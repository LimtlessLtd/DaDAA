// src/sessions/check_manager.js
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'temp_data');
const pendingChecksPath = path.join(dataDir, 'pending_checks.json');
const openGroupCheckPath = path.join(dataDir, 'open_group_check.json');

function ensureDataDirectories() {
    fs.mkdirSync(dataDir, { recursive: true });
}

function loadPendingChecks() {
    ensureDataDirectories();
    if (!fs.existsSync(pendingChecksPath)) return [];
    try {
        return JSON.parse(fs.readFileSync(pendingChecksPath, 'utf8')) || [];
    } catch (e) {
        console.warn('-> Could not read pending checks', e.message);
        return [];
    }
}

function savePendingChecks(checks) {
    ensureDataDirectories();
    fs.writeFileSync(pendingChecksPath, JSON.stringify(checks, null, 2));
}

// Only one active check per character at a time - a new request for the same
// character replaces whatever was pending (the DM moved on before it was resolved).
function addPendingCheck(character, skill, dc) {
    if (!character || !skill || !dc) return null;

    const checks = loadPendingChecks().filter((c) => c.character !== character);
    const entry = {
        character,
        skill: String(skill).trim(),
        dc: Number(dc),
        requestedAt: new Date().toISOString()
    };
    checks.push(entry);
    savePendingChecks(checks);
    return entry;
}

function resolvePendingCheck(character) {
    if (!character) return null;
    const checks = loadPendingChecks();
    const index = checks.findIndex((c) => c.character === character);
    if (index === -1) return null;

    const [resolved] = checks.splice(index, 1);
    savePendingChecks(checks);
    return resolved;
}

function loadOpenGroupCheck() {
    ensureDataDirectories();
    if (!fs.existsSync(openGroupCheckPath)) return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(openGroupCheckPath, 'utf8'));
        return (parsed && parsed.active) ? parsed : null;
    } catch (e) {
        console.warn('-> Could not read open group check', e.message);
        return null;
    }
}

function saveOpenGroupCheck(entry) {
    ensureDataDirectories();
    fs.writeFileSync(openGroupCheckPath, JSON.stringify(entry, null, 2));
}

// Opens a boolean-style group check ("everyone make a Perception check"): unlike a solo check,
// no specific character is required to respond - any bound character may voluntarily roll while
// it's open (all, some, or none of them), matching how a real table actually reacts to that kind
// of prompt rather than a pre-named roster. Only one can be open at a time - opening a new one
// replaces whatever was still open, same "a new request replaces whatever was pending" rule solo
// checks already follow.
function openGroupCheck(skill, dc) {
    if (!skill || !dc) return null;
    const entry = {
        active: true,
        skill: String(skill).trim(),
        dc: Number(dc),
        requestedAt: new Date().toISOString(),
        results: {}
    };
    saveOpenGroupCheck(entry);
    return entry;
}

function getOpenGroupCheck() {
    return loadOpenGroupCheck();
}

// Records one voluntary roll into the open group check's scoreboard. Returns the updated entry,
// or null if nothing is open (e.g. it already timed out/closed just before this roll landed).
function recordOpenGroupCheckRoll(character, result) {
    if (!character) return null;
    const entry = loadOpenGroupCheck();
    if (!entry) return null;

    entry.results[character] = result;
    saveOpenGroupCheck(entry);
    return entry;
}

// Closes out whatever group check is open (resolved by its timeout - see
// index.js resolveOpenGroupCheck) so a roll landing afterward is treated as an ordinary
// unprompted roll instead of re-opening/re-narrating an already-closed moment.
function closeOpenGroupCheck() {
    saveOpenGroupCheck({ active: false });
}

module.exports = {
    loadPendingChecks,
    addPendingCheck,
    resolvePendingCheck,
    openGroupCheck,
    getOpenGroupCheck,
    recordOpenGroupCheckRoll,
    closeOpenGroupCheck
};
