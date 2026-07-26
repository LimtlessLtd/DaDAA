// src/voice/voice_manager.js
const { joinVoiceChannel, EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const prism = require('prism-media');
const WebSocket = require('ws');
const { execFile } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { resolveSpeakerVoice } = require('./voice_registry');

const socketsByUser = new Map();
let transcriptHandler = null;

const utteranceStartTimes = new Map();
const activeStreams = new Map();

const audioPlayer = createAudioPlayer();
let currentVoiceConnection = null;
let ttsQueue = [];
let isPlayingTts = false;

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
                const userTimes = utteranceStartTimes.get(payload.userId || userId) || [];
                const startTime = userTimes.shift() || Date.now();
                transcriptHandler(payload.userId || userId, payload.text, startTime);
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
        
        if (!utteranceStartTimes.has(userId)) {
            utteranceStartTimes.set(userId, []);
        }
        utteranceStartTimes.get(userId).push(Date.now());

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
// guideline 5); "voiceDescription" only matters the first time that speaker is heard - see
// voice_registry.js resolveSpeakerVoice() for how it gets locked in from then on.
function speakText(text, speaker = 'narrator', voiceDescription = null) {
    if (!text || !currentVoiceConnection) {
        console.warn('-> speakText: Missing text or voice connection');
        return;
    }
    ttsQueue.push({ text, speaker, voiceDescription });
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

async function processTtsQueue() {
    console.log("processing TTS Queue");

    if (isPlayingTts || ttsQueue.length === 0 || !currentVoiceConnection) return;

    isPlayingTts = true;
    const item = ttsQueue.shift();
    const text = item.text;
    const voiceSpec = resolveSpeakerVoice(item.speaker, item.voiceDescription);

    const tempAudioPath = path.join(__dirname, '..', '..', 'temp_data', `tts_${Date.now()}.wav`);
    const dataDir = path.dirname(tempAudioPath);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    try {
        const wavBuffer = await synthesizeViaTtsServer(text, voiceSpec);
        fs.writeFileSync(tempAudioPath, wavBuffer);
    } catch (serverErr) {
        console.warn('-> Kokoro TTS server unavailable, falling back to legacy TTS:', serverErr.message);
        try {
            await synthesizeViaLegacyScript(text, tempAudioPath, legacyProfileFor(item.speaker, voiceSpec));
        } catch (legacyErr) {
            console.error('-> Legacy TTS also failed:', legacyErr.message);
            isPlayingTts = false;
            processTtsQueue();
            return;
        }
    }

    try {
        const resource = createAudioResource(tempAudioPath);
        audioPlayer.play(resource);
    } catch (e) {
        console.error('-> Audio playback error:', e.message);
        isPlayingTts = false;
        processTtsQueue();
    }
}

module.exports = { joinAndListen, speakText };