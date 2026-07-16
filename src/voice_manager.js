// src/voice_manager.js
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const WebSocket = require('ws');

const socketsByUser = new Map();
let transcriptHandler = null;

// Track utterance start times per user to solve overlapping speech order issues
const utteranceStartTimes = new Map();
// Prevent memory leak / multiple subscriptions by keeping track of active streams per user
const activeStreams = new Map();

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

    connection.receiver.speaking.on('start', (userId) => {
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

module.exports = { joinAndListen };