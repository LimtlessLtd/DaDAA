// src/audio_service.js
const record = require('node-record-lpcm16');

function startAudioListener(worldGraph) {
    console.log("-> Audio service active. Listening for game conversation...");

    const recording = record.record({
        sampleRate: 16000,
        threshold: 0,
        verbose: false
    }).stream();

    recording.on('data', (chunk) => {
        // Here you would stream 'chunk' to your STT API
        // For now, we log that data is being received
    });
}

module.exports = { startAudioListener };