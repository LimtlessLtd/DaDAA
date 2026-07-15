const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'temp_data');
const notesPath = path.join(dataDir, 'session_notes.json');

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
    const t = String(text || '').toLowerCase();
    return notes.filter((n) => n.trigger && t.includes(n.trigger.toLowerCase()));
}

module.exports = { loadSessionNotes, saveSessionNotes, addSessionNote, deleteSessionNote, findTriggeredNotes };
