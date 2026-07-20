const fs = require('fs');
const path = require('path');
const { speakText } = require('../voice/voice_manager'); // Adjust this import based on your exact function name

const dataDir = path.join(__dirname, '..', '..', 'temp_data');
const notesPath = path.join(dataDir, 'session_notes.json');
const transcriptPath = path.join(dataDir, 'transcript_log.txt');

let sessionZeroActive = false;
let sessionZeroBuffer = [];

function ensureDataDirectories() {
    fs.mkdirSync(dataDir, { recursive: true });
}

function loadSessionNotes() {
    ensureDataDirectories();
    if (!fs.existsSync(notesPath)) return [];
    try {
        return JSON.parse(fs.readFileSync(notesPath, 'utf8')) || [];
    } catch (e) {
        console.warn('-> Could not read session notes', e.message);
        return [];
    }
}

function saveSessionNotes(notes) {
    ensureDataDirectories();
    fs.writeFileSync(notesPath, JSON.stringify(notes, null, 2));
}

function normalizeTriggerText(value = '') {
    return String(value || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function addSessionNote(notes, { trigger, note, remindType = 'instant' }) {
    const entry = {
        id: `${Date.now()}-${Math.round(Math.random() * 1000)}`,
        trigger: String(trigger || '').trim(),
        note: String(note || '').trim(),
        remindType,
        createdAt: new Date().toISOString(),
    };
    notes.push(entry);
    saveSessionNotes(notes);
    return entry;
}

function deleteSessionNote(notes, id) {
    const next = notes.filter((n) => n.id !== id);
    saveSessionNotes(next);
    return next;
}

function findTriggeredNotes(notes, text) {
    const transcriptText = normalizeTriggerText(text);
    return notes.filter((n) => {
        const triggerText = normalizeTriggerText(n.trigger);
        return triggerText && (
            transcriptText.includes(triggerText) ||
            triggerText.split(/\s+/).every((word) => transcriptText.includes(word))
        );
    });
}

// --- Session Zero State Management ---

function startSessionZero() {
    sessionZeroActive = true;
    sessionZeroBuffer = [];
    
    const promptText = 'What should the world setting be? Describe your ideas, then say "we are done" to generate the lore and start the campaign.';
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
    loadSessionNotes, 
    saveSessionNotes, 
    addSessionNote, 
    deleteSessionNote, 
    findTriggeredNotes,
    startSessionZero,
    isSessionZeroActive,
    addSessionZeroInput,
    endSessionZero
};