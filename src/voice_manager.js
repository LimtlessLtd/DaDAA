// src/voice_manager.js
const { joinVoiceChannel, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');
const WebSocket = require('ws');

let ws = null;
let transcriptHandler = null;

function ensureSocket() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return ws;
    }

    ws = new WebSocket('ws://localhost:8765');
    ws.on('open', () => console.log('-> Connected to AI Transcription Server'));
    ws.on('error', (err) => console.error('-> WebSocket Error:', err));
    ws.on('message', (message) => {
        const payload = JSON.parse(message.toString());
        if (transcriptHandler && payload.text) {
            transcriptHandler(payload.text);
        }
    });

    return ws;
}

function joinAndListen(client, guildId, channelId, handler) {
    transcriptHandler = handler;
    const connection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator: client.guilds.cache.get(guildId).voiceAdapterCreator,
        selfDeaf: false,
    });

    const socket = ensureSocket();

    connection.receiver.speaking.on('start', (userId) => {
        const audioStream = connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
        });

        const opusDecoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });

        audioStream.pipe(opusDecoder).on('data', (chunk) => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(chunk);
            }
        });
    });

    return connection;
}

module.exports = { joinAndListen };