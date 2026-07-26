const fs = require('fs');
const path = require('path');
const { speakText } = require('../voice/voice_manager'); // Adjust this import based on your exact function name

const dataDir = path.join(__dirname, '..', '..', 'temp_data');
const transcriptPath = path.join(dataDir, 'transcript_log.txt');

let sessionZeroActive = false;
let sessionZeroBuffer = [];

function ensureDataDirectories() {
    fs.mkdirSync(dataDir, { recursive: true });
}

// --- Session Zero State Management ---

function startSessionZero() {
    sessionZeroActive = true;
    sessionZeroBuffer = [];

    const promptText = 'Please give me prompts and ideas for the world and its lore.';
    const timestamp = new Date().toISOString();
    const broadcastMsg = `[${timestamp}] [DaDAA] ${promptText}\n`;

    try {
        ensureDataDirectories();
        fs.appendFileSync(transcriptPath, broadcastMsg, 'utf8');

        speakText(promptText);
    } catch (e) {
        console.warn('-> Could not write to transcript log or play audio', e.message);
    }

    console.log('-> Session Zero started. Listening for world ideas...');
}

function isSessionZeroActive() {
    return sessionZeroActive;
}

function addSessionZeroInput(source, text) {
    if (!sessionZeroActive) return;
    sessionZeroBuffer.push(`[${source}]: ${text}`);
}

function endSessionZero() {
    sessionZeroActive = false;
    const compiledIdeas = sessionZeroBuffer.join('\n');
    sessionZeroBuffer = [];
    return compiledIdeas;
}

module.exports = {
    startSessionZero,
    isSessionZeroActive,
    addSessionZeroInput,
    endSessionZero
};
