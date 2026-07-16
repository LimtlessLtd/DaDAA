// src/voice_manager.js
const { joinVoiceChannel, EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus } = require('@discordjs/voice');
const prism = require('prism-media');
const WebSocket = require('ws');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const socketsByUser = new Map();
let transcriptHandler = null;

// Track utterance start times per user to solve overlapping speech order issues
const utteranceStartTimes = new Map();
// Prevent memory leak / multiple subscriptions by keeping track of active streams per user
const activeStreams = new Map();

// Global audio player for the bot to speak
const audioPlayer = createAudioPlayer();
let currentVoiceConnection = null;
let ttsQueue = [];
let isPlayingTts = false;

function ensureSocket(userId) {
    if (!userId) return null;
    const existing = socketsByUser.get(userId);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
        return existing;
    }

    const socket = new WebSocket('ws://localhost:8765');
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
    socket.on('unexpected-response', (req, res) => {
        console.error(`-> Transcription unexpected response for user ${userId}: ${res.statusCode}`);
        if (socketsByUser.get(userId) === socket) {
            socketsByUser.delete(userId);
        }
    });
    socket.on('pong', () => {
        // Keepalive
    });
    socket.on('message', (message) => {
        try {
            const payload = JSON.parse(message.toString());
            if (transcriptHandler && payload.text) {
                // Get the start timestamp of this transcription from the queue
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

    connection.receiver.speaking.on('start', (userId) => {
        // Interruption: If a user starts speaking, stop the AI immediately.
        if (isPlayingTts) {
            console.log(`-> Interrupting DM TTS playback due to user ${userId} speaking.`);
            audioPlayer.stop(); // Stops current playback immediately
            ttsQueue = []; // Clear any queued sentences
            isPlayingTts = false;
        }

        // Prevent registering duplicate streams/subscriptions for the same user if they are already speaking
        if (activeStreams.has(userId)) {
            return;
        }

        const socket = ensureSocket(userId);
        
        // Record the start timestamp of this specific speech segment
        if (!utteranceStartTimes.has(userId)) {
            utteranceStartTimes.set(userId, []);
        }
        utteranceStartTimes.get(userId).push(Date.now());

        const audioStream = connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
        });
        activeStreams.set(userId, audioStream);

        const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });

        // Safely catch subscription errors to prevent crashes on network drops
        audioStream.on('error', (err) => {
            console.warn(`-> Audio stream error for user ${userId}:`, err.message);
        });

        // Safely catch decoder errors to prevent crashes on corrupted/malformed voice packets
        opusDecoder.on('error', (err) => {
            console.warn(`-> Opus decoder error for user ${userId} (corrupted packet discarded):`, err.message);
        });

        audioStream.pipe(opusDecoder).on('data', (chunk) => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(chunk);
            }
        });

        audioStream.on('end', () => {
            activeStreams.delete(userId);
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

function speakText(text, profile = 'narrator') {
    if (!text || !currentVoiceConnection) return;
    ttsQueue.push({ text, profile });
    processTtsQueue();
}

function processTtsQueue() {
    if (isPlayingTts || ttsQueue.length === 0 || !currentVoiceConnection) return;

    isPlayingTts = true;
    const item = ttsQueue.shift();
    const text = item.text;
    const profile = item.profile || 'narrator';
    
    const tempAudioPath = path.join(__dirname, '..', 'temp_data', 'tts_output.wav');
    const pythonScript = path.join(__dirname, 'local_tts.py');

    // Make sure the temp directory exists
    const dataDir = path.dirname(tempAudioPath);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    // Spawn python script to generate audio
    execFile('python', [pythonScript, text, tempAudioPath, profile], (error) => {
        if (error) {
            console.error('-> TTS Generation Error:', error.message);
            isPlayingTts = false;
            processTtsQueue();
            return;
        }

        try {
            const resource = createAudioResource(tempAudioPath);
            audioPlayer.play(resource);
        } catch (e) {
            console.error('-> Audio playback error:', e.message);
            isPlayingTts = false;
            processTtsQueue();
        }
    });
}

module.exports = { joinAndListen, speakText };