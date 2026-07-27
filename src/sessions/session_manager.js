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

// --- Character Introduction State Management ---
// Runs once per campaign, after the campaign seed is generated and read aloud but before
// Session 1's opening event - each player introduces their name, their character, and what
// that character is doing as the scene opens. Buffered the same way Session Zero is above;
// index.js parses the compiled buffer with the LLM once everyone signals they're done, then
// binds each Discord user to their character via character_manager.js bindCharacter().

let characterIntroActive = false;
let characterIntroBuffer = [];

function startCharacterIntros() {
    characterIntroActive = true;
    characterIntroBuffer = [];

    const promptText = "Now, going round the table - tell me your name, your character's name, a brief description of them, and what they're doing as the scene opens. Let me know when everyone's introduced themselves.";
    const timestamp = new Date().toISOString();
    const broadcastMsg = `[${timestamp}] [DaDAA] ${promptText}\n`;

    try {
        ensureDataDirectories();
        fs.appendFileSync(transcriptPath, broadcastMsg, 'utf8');

        speakText(promptText);
    } catch (e) {
        console.warn('-> Could not write to transcript log or play audio', e.message);
    }

    console.log('-> Character introductions started. Listening for players...');
}

function isCharacterIntroActive() {
    return characterIntroActive;
}

function addCharacterIntroInput(source, text) {
    if (!characterIntroActive) return;
    characterIntroBuffer.push(`[${source}]: ${text}`);
}

function endCharacterIntros() {
    characterIntroActive = false;
    const compiledIntros = characterIntroBuffer.join('\n');
    characterIntroBuffer = [];
    return compiledIntros;
}

module.exports = {
    startSessionZero,
    isSessionZeroActive,
    addSessionZeroInput,
    endSessionZero,
    startCharacterIntros,
    isCharacterIntroActive,
    addCharacterIntroInput,
    endCharacterIntros
};
