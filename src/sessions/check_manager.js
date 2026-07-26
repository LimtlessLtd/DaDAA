// src/sessions/check_manager.js
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'temp_data');
const pendingChecksPath = path.join(dataDir, 'pending_checks.json');

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

module.exports = { loadPendingChecks, addPendingCheck, resolvePendingCheck };
