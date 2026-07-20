// src/voice_manager.js
const { joinVoiceChannel, EndBehaviorType, createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType } = require('@discordjs/voice');
const prism = require('prism-media');
const WebSocket = require('ws');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const socketsByUser = new Map();
let transcriptHandler = null;

const utteranceStartTimes = new Map();
const activeStreams = new Map();

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
        if (activeStreams.has(userId)) {
            return;
        }

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
    
    const tempAudioPath = path.join(__dirname, '..', '..', 'temp_data', 'tts_output.wav');
    const pythonScript = path.join(__dirname, 'local_tts.py');

    const dataDir = path.dirname(tempAudioPath);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

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