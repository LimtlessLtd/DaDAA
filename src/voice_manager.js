// src/voice_manager.js
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const WebSocket = require('ws');

const socketsByUser = new Map();
let transcriptHandler = null;

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
                transcriptHandler(payload.userId || userId, payload.text);
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
        const socket = ensureSocket(userId);
        const audioStream = connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
        });

        const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 1, frameSize: 960 });

        audioStream.pipe(opusDecoder).on('data', (chunk) => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                socket.send(chunk);
            }
        });
    });

    return connection;
}

module.exports = { joinAndListen };