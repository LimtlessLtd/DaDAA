// src/voice/voice_manager.js
const { joinVoiceChannel, EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const prism = require('prism-media');
const WebSocket = require('ws');
const { execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { resolveSpeakerVoice, NARRATOR_VOICE } = require('./voice_registry');

const socketsByUser = new Map();
let transcriptHandler = null;

// Map<userId, Array<{start, end}>> - one entry per utterance whose audio stream closed, in
// order. Both timestamps are captured together in the SAME closure (see the 'start'/'end'
// handlers in joinAndListen below) rather than in two separately-shiftable queues, so the pair
// itself can never drift out of sync with each other. The queue as a whole is still matched to
// incoming transcripts by simple FIFO order (shifted in ensureSocket's socket.on('message')
// below) - if the transcription server silently drops an utterance (VAD decided it wasn't real
// speech, see VoiceSession.feed()'s MIN_SPEECH_FRAMES / the prompt-echo filter in
// transcription_service.py), no message ever arrives for it, so its entry is never shifted out
// and the FOLLOWING transcript would be matched to the wrong (stale) timing pair. Capped below so
// a long run of dropped utterances can't grow this unboundedly, but the mismatch itself is a
// known limitation of correlating by order alone, not something this cap fixes.
const utteranceTimings = new Map();
const MAX_QUEUED_TIMINGS_PER_USER = 20;
const activeStreams = new Map();

const audioPlayer = createAudioPlayer();
let currentVoiceConnection = null;
let ttsQueue = [];
let isPlayingTts = false;

// Persistent cache for fixed, unchanging lines (THINKING_FILLERS, the Session Zero/character-intro
// prompts) - deliberately NOT under temp_data/, since that's per-campaign save state that gets
// wiped on "Start New Campaign" and this cache is neither. Keyed by a hash of the exact text (the
// narrator voice is a fixed constant, see voice_registry.js NARRATOR_VOICE, so the same text always
// synthesizes to the same audio) - generated once via pregenerateStaticAudio() and reused forever,
// same "generate once, lock in" pattern as character_voices.json/entity_images.json.
const STATIC_TTS_DIR = path.join(__dirname, '..', '..', 'tts_cache');

function staticCachePath(text) {
    const hash = crypto.createHash('sha1').update(text).digest('hex');
    return path.join(STATIC_TTS_DIR, `${hash}.wav`);
}

function getStaticAudioPath(text) {
    const cachePath = staticCachePath(text);
    return fs.existsSync(cachePath) ? cachePath : null;
}

// Determine python command based on OS
const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';

function ensureSocket(userId) {
    if (!userId) return null;
    const existing = socketsByUser.get(userId);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
        return existing;
    }

    const socket = new WebSocket('ws://127.0.0.1:8765');
    socket.on('open', () => {
        console.log(`-> Connected to AI Transcription Server for user ${userId}`);
        try {
            socket.send(JSON.stringify({ type: 'handshake', userId }));
        } catch (error) {
            console.error('-> Failed to send transcription handshake:', error.message || error);
        }
    });
    socket.on('error', (err) => {
        console.error('-> WebSocket Error:', err.message || err);
        if (socketsByUser.get(userId) === socket) {
            socketsByUser.delete(userId);
        }
    });
    socket.on('close', (code, reason) => {
        console.log(`-> Transcription socket closed for user ${userId}: ${code} ${reason}`);
        if (socketsByUser.get(userId) === socket) {
            socketsByUser.delete(userId);
        }
    });
    socket.on('message', (message) => {
        try {
            const payload = JSON.parse(message.toString());
            if (transcriptHandler && payload.text) {
                const targetId = payload.userId || userId;
                const timing = (utteranceTimings.get(targetId) || []).shift();
                const now = Date.now();
                // "end" (speech-end timestamp) lets the caller measure pure STT turnaround
                // (speech-end -> transcript-received), separately from the debounce/queueing
                // delay that happens after the transcript is already in hand.
                const { start = now, end = now } = timing || {};
                transcriptHandler(targetId, payload.text, start, end);
            }
        } catch (error) {
            console.error('-> Failed to parse transcription payload:', error.message);
        }
    });

    socketsByUser.set(userId, socket);
    return socket;
}

function joinAndListen(client, guildId, channelId, handler) {
    transcriptHandler = handler;
    const connection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator: client.guilds.cache.get(guildId).voiceAdapterCreator,
        selfDeaf: false,
    });

    currentVoiceConnection = connection;
    connection.subscribe(audioPlayer);

    const { Readable } = require('stream');
    class Silence extends Readable {
        _read() {
            this.push(Buffer.alloc(960 * 2 * 2));
            this.push(null);
        }
    }
    audioPlayer.play(createAudioResource(new Silence(), { inputType: StreamType.Raw }));

    connection.receiver.speaking.on('start', (userId) => {
        if (activeStreams.has(userId)) return;

        const socket = ensureSocket(userId);
        client.emit('dndSpeechStart', userId);

        // Local to this utterance's closure, not a shared map - paired with its own end time
        // below (in the SAME closure) rather than two separately-shiftable queues, so the two
        // timestamps can never desync from each other. See utteranceTimings above.
        const speechStartedAt = Date.now();

        const audioStream = connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
        });
        activeStreams.set(userId, audioStream);

        const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });

        audioStream.on('error', (err) => {
            console.warn(`-> Audio stream error for user ${userId}:`, err.message);
            activeStreams.delete(userId);
            audioStream.destroy();
            client.emit('dndSpeechEnd', userId); 
        });

        audioStream.pipe(opusDecoder).on('data', (chunk) => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(chunk);
            }
        });

        audioStream.on('end', () => {
            activeStreams.delete(userId);

            if (!utteranceTimings.has(userId)) utteranceTimings.set(userId, []);
            const queue = utteranceTimings.get(userId);
            queue.push({ start: speechStartedAt, end: Date.now() });
            // Bound the queue rather than let it grow forever if the transcription server keeps
            // silently dropping utterances (see the comment on utteranceTimings above) - drops the
            // oldest, since a very stale entry is no more likely to be the right match than a
            // slightly-less-stale one.
            if (queue.length > MAX_QUEUED_TIMINGS_PER_USER) queue.shift();

            client.emit('dndSpeechEnd', userId);
        });
    });

    return connection;
}

audioPlayer.on(AudioPlayerStatus.Idle, () => {
    isPlayingTts = false;
    processTtsQueue();
});

audioPlayer.on('error', error => {
    console.error('-> Audio Player Error:', error.message);
    isPlayingTts = false;
    processTtsQueue();
});

// "speaker" is "narrator" or an exact NPC/character name (see ai_provider.js buildPrompt
// guideline 4); "voiceDescription" only matters the first time that speaker is heard - see
// voice_registry.js resolveSpeakerVoice() for how it gets locked in from then on.
// "onPlaybackStart" is an optional latency-instrumentation hook (see index.js runDmTurn) fired
// the moment THIS item is handed to the audio player - not awaited, purely a timestamp callback.
function speakText(text, speaker = 'narrator', voiceDescription = null, onPlaybackStart = null) {
    if (!text || !currentVoiceConnection) {
        console.warn('-> speakText: Missing text or voice connection');
        return;
    }
    ttsQueue.push({ text, speaker, voiceDescription, onPlaybackStart });
    processTtsQueue();
}

// Primary path: the persistent core_server.py process (TtsService, port 8767) keeps its Kokoro
// pipeline warm so synthesis is fast - spawning a fresh Python process per line (the old
// approach) would pay Kokoro's ~1-2s model load cost on every single narration line.
function synthesizeViaTtsServer(text, voiceSpec) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ text, voices: voiceSpec.voices, speed: voiceSpec.speed });
        const req = http.request({
            hostname: '127.0.0.1',
            port: 8767,
            path: '/synthesize',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`TTS server HTTP ${res.statusCode}: ${Buffer.concat(chunks)}`));
                    return;
                }
                resolve(Buffer.concat(chunks));
            });
        });

        // Generous timeout: the first synthesis request for a given voice triggers a one-time
        // download of that voice's tensor file from Hugging Face (see TtsService/PIPELINE.load_voice
        // in core_server.py), which can take longer than a typical request on a slow connection -
        // a fallback to gTTS/pyttsx3 for the whole session over one slow download is worse than waiting.
        req.setTimeout(60000, () => {
            req.destroy();
            reject(new Error('TTS server timeout'));
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// Best-effort, called once at bot startup with every fixed line that's ever spoken verbatim
// (THINKING_FILLERS, the Session Zero/character-intro prompts) - synthesizes and caches whichever
// ones aren't already cached from a previous run, so the FIRST time any of them is actually needed
// during play, processTtsQueue() below finds it already sitting on disk instead of paying Kokoro's
// synthesis latency in the moment. Skips ones already cached (idempotent - safe to call every
// startup). Never throws - a synthesis failure here (e.g. core_server.py not up yet) just means
// that one line falls back to the normal dynamic path the first time it's actually spoken, same as
// if this had never run at all.
async function pregenerateStaticAudio(lines) {
    const uniqueLines = [...new Set((lines || []).filter(Boolean))];
    if (uniqueLines.length === 0) return;

    fs.mkdirSync(STATIC_TTS_DIR, { recursive: true });
    let generated = 0;
    for (const text of uniqueLines) {
        if (getStaticAudioPath(text)) continue; // already cached from a previous run
        try {
            const wavBuffer = await synthesizeViaTtsServer(text, NARRATOR_VOICE);
            fs.writeFileSync(staticCachePath(text), wavBuffer);
            generated++;
        } catch (e) {
            console.warn(`-> Failed to pre-generate static TTS audio for "${text.slice(0, 40)}...":`, e.message);
        }
    }
    if (generated > 0) {
        console.log(`-> Pre-generated ${generated} static TTS audio file(s).`);
    }
}

// Fallback path: the old per-process gTTS/pyttsx3 script, kept only for when the Kokoro server
// isn't running yet (e.g. first run before `pip install -r requirements.txt` + espeak-ng setup).
// It only knows the old fixed profile names, so a dynamic voice blend is collapsed down to
// whichever of those it most resembles - good enough for an emergency fallback, not a match.
function legacyProfileFor(speaker, voiceSpec) {
    if (!speaker || speaker.trim().toLowerCase() === 'narrator') return 'narrator';
    const primaryVoice = voiceSpec.voices?.[0]?.name || '';
    return primaryVoice.startsWith('bf_') ? 'female' : 'male';
}

function synthesizeViaLegacyScript(text, tempAudioPath, profile) {
    return new Promise((resolve, reject) => {
        const pythonScript = path.join(__dirname, 'local_tts.py');
        execFile(pythonCommand, [pythonScript, text, tempAudioPath, profile], (error, stdout, stderr) => {
            if (error) {
                reject(new Error(`${error.message} | ${stderr}`));
                return;
            }
            if (!fs.existsSync(tempAudioPath)) {
                reject(new Error(`Legacy TTS file missing: ${tempAudioPath}`));
                return;
            }
            resolve();
        });
    });
}

// Resolves one queued item down to a playable local audio path: the static pregenerated cache
// (narrator-only fixed lines, see pregenerateStaticAudio()) if it's cached, else a fresh Kokoro
// synthesis via core_server.py, falling back to the legacy gTTS/pyttsx3 script if that's
// unreachable. Returns null only when both paths fail (caller skips the item). Split out of
// processTtsQueue so the same synthesis work can be kicked off either for the item about to play
// or, per the prefetch below, for the item after that while the current one is still playing.
async function resolveAudioPath(item) {
    const { text, speaker, voiceDescription } = item;
    const voiceSpec = resolveSpeakerVoice(speaker, voiceDescription);

    // Only ever checked for narrator-voiced text, since that's all the cache ever contains - an
    // NPC line happening to match one verbatim would still be wrong to play in the narrator's voice.
    const isNarrator = !speaker || speaker.trim().toLowerCase() === 'narrator';
    const cachedPath = isNarrator ? getStaticAudioPath(text) : null;
    if (cachedPath) return cachedPath;

    // Random suffix alongside the timestamp: pipelining means two items' synthesis can now be
    // in flight at once (the one playing + the prefetched one after it), so two temp files can
    // genuinely coexist on disk where before there was only ever one at a time.
    const tempAudioPath = path.join(__dirname, '..', '..', 'temp_data', `tts_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.wav`);
    const dataDir = path.dirname(tempAudioPath);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    try {
        const wavBuffer = await synthesizeViaTtsServer(text, voiceSpec);
        fs.writeFileSync(tempAudioPath, wavBuffer);
        return tempAudioPath;
    } catch (serverErr) {
        console.warn('-> Kokoro TTS server unavailable, falling back to legacy TTS:', serverErr.message);
        try {
            await synthesizeViaLegacyScript(text, tempAudioPath, legacyProfileFor(speaker, voiceSpec));
            return tempAudioPath;
        } catch (legacyErr) {
            console.error('-> Legacy TTS also failed:', legacyErr.message);
            return null;
        }
    }
}

// Holds { item, promise } for the next queued item once its synthesis has already been kicked
// off ahead of time (see the prefetch step at the bottom of processTtsQueue) - checked first on
// the following call so playback doesn't wait on synthesis it could have started earlier.
let prefetched = null;

async function processTtsQueue() {
    if (isPlayingTts || !currentVoiceConnection) return;
    if (ttsQueue.length === 0 && !prefetched) return;

    isPlayingTts = true;

    let item, pathPromise;
    if (prefetched) {
        ({ item, promise: pathPromise } = prefetched);
        prefetched = null;
    } else {
        item = ttsQueue.shift();
        pathPromise = resolveAudioPath(item);
    }

    const audioPath = await pathPromise;
    if (!audioPath) {
        isPlayingTts = false;
        processTtsQueue();
        return;
    }

    const speakerLabel = (!item.speaker || item.speaker.trim().toLowerCase() === 'narrator') ? 'narrator' : item.speaker;
    console.log(`-> Speaking as ${speakerLabel}: "${item.text}"`);

    try {
        audioPlayer.play(createAudioResource(audioPath));
    } catch (e) {
        console.error('-> Audio playback error:', e.message);
        isPlayingTts = false;
        processTtsQueue();
        return;
    }

    if (item.onPlaybackStart) {
        try { item.onPlaybackStart(); } catch (e) { /* instrumentation must never break playback */ }
    }

    // Start synthesizing the NEXT queued item now, while this one plays, instead of waiting for
    // AudioPlayerStatus.Idle - this is what closes the dead-air gap between dialogue segments
    // (narrator -> NPC -> narrator) that Kokoro's synthesis time used to leave between lines.
    if (ttsQueue.length > 0) {
        const nextItem = ttsQueue.shift();
        prefetched = { item: nextItem, promise: resolveAudioPath(nextItem) };
    }
}

// A single DM turn can queue several dialogue segments (narrator + an NPC line + narrator again -
// see ai_provider.js guideline 4), so if a campaign reset happens mid-turn, whatever's still
// queued would otherwise keep playing right through the reset, sounding like the DM is still
// talking about the old campaign. Call this on "Start New Campaign"/purge to flush it.
function stopSpeaking() {
    ttsQueue = [];
    prefetched = null;
    audioPlayer.stop(true);
}

// Live snapshot for the dashboard's Performance tab - current state, not history. Cheap to call
// on every dashboard poll since it just reads the module-level variables already maintained above.
function getTtsQueueStatus() {
    return {
        queueLength: ttsQueue.length,
        isPlaying: isPlayingTts,
        hasPrefetch: !!prefetched
    };
}

// Resolves once every item queued so far has actually finished playing (not merely been
// dispatched) - i.e. ttsQueue is empty, nothing is mid-playback, and nothing is sitting prefetched
// waiting to play next. Used by index.js's enqueueDmTurn() to hold a DM turn "in flight" for its
// full spoken duration, not just its LLM-call duration - see the comment there for why: without
// this, a new trigger landing while a turn is still narrating starts its OWN LLM call immediately,
// and that turn's TTS then queues up behind the one still playing, so a burst of closely-spaced
// triggers (repeated small utterances, or the un-debounced dice-roll trigger) piles up several
// turns' worth of unplayed audio instead of just one.
function waitForTtsQueueDrain(pollMs = 200) {
    return new Promise((resolve) => {
        (function check() {
            if (ttsQueue.length === 0 && !isPlayingTts && !prefetched) {
                resolve();
            } else {
                setTimeout(check, pollMs);
            }
        })();
    });
}

module.exports = { joinAndListen, speakText, stopSpeaking, pregenerateStaticAudio, getTtsQueueStatus, waitForTtsQueueDrain };