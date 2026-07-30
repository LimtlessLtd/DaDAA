// src/characters/character_state_manager.js
// Live mechanical state per character (current HP, conditions, inventory) - the part of a D&D
// Beyond import that changes during play and must never be silently overwritten by a later sheet
// refresh. Mirrors the file-backed pattern already used by check_manager.js and
// background_event_manager.js: sync fs, one JSON object under temp_data/, plain load/save/mutate
// functions. Keyed by character name, same canonical key character_map.json/character_logs.json/
// pending_checks.json/character_voices.json/ddb_characters.json all already use.
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'temp_data');
const statePath = path.join(dataDir, 'character_state.json');

function ensureDataDirectories() {
    fs.mkdirSync(dataDir, { recursive: true });
}

function loadCharacterState() {
    ensureDataDirectories();
    if (!fs.existsSync(statePath)) return {};
    try {
        return JSON.parse(fs.readFileSync(statePath, 'utf8')) || {};
    } catch (e) {
        console.warn('-> Could not read character_state.json', e.message);
        return {};
    }
}

function saveCharacterState(state) {
    ensureDataDirectories();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// Called once, the first time a character is ever linked (no existing state row for that name) -
// seeds full live state from their imported D&D Beyond sheet. Never called again for that name
// afterward, so a later "refresh from D&D Beyond" can't clobber HP/inventory accumulated in play -
// see reconcileMaxHp below for what a later refresh IS allowed to touch.
function initializeStateFromSheet(characterName, sheet) {
    const state = loadCharacterState();
    if (state[characterName]) return state[characterName];

    state[characterName] = {
        currentHp: sheet.maxHp,
        maxHp: sheet.maxHp,
        conditions: [],
        inventory: (sheet.inventory || []).map((i) => ({ name: i.name, quantity: i.quantity })),
        lastUpdatedAt: new Date().toISOString()
    };
    saveCharacterState(state);
    return state[characterName];
}

// Called on every D&D Beyond refresh (including the first) - updates only maxHp, clamping
// currentHp down if it now exceeds the new max (e.g. a level-down correction on D&D Beyond, or a
// buff/override being removed). Never touches conditions or inventory - those are play state, not
// sheet state.
function reconcileMaxHp(characterName, newMaxHp) {
    const state = loadCharacterState();
    const entry = state[characterName];
    if (!entry) return;

    entry.maxHp = newMaxHp;
    if (entry.currentHp > newMaxHp) entry.currentHp = newMaxHp;
    entry.lastUpdatedAt = new Date().toISOString();
    saveCharacterState(state);
}

function clampHp(value, maxHp) {
    return Math.max(0, Math.min(maxHp, value));
}

// Deterministic backstop consuming the LLM's own characterStateChanges field (ai_provider.js) -
// same philosophy as check_manager.js/announceCheckRequirement: don't trust the narrative alone to
// keep state consistent. Each change is { character, hpDelta, newConditions, removedConditions,
// inventoryAdd, inventoryRemove }. Silently no-ops for a character with no tracked state (e.g. an
// NPC misnamed by the model) rather than creating a bogus row.
function applyStateChanges(changes) {
    if (!Array.isArray(changes) || changes.length === 0) return;
    const state = loadCharacterState();
    let changed = false;

    for (const change of changes) {
        const name = String(change?.character || '').trim();
        const entry = name && state[name];
        if (!entry) continue;

        if (typeof change.hpDelta === 'number' && change.hpDelta !== 0) {
            entry.currentHp = clampHp(entry.currentHp + change.hpDelta, entry.maxHp);
        }

        if (Array.isArray(change.removedConditions) && change.removedConditions.length > 0) {
            const removeSet = new Set(change.removedConditions.map((c) => String(c).toLowerCase().trim()));
            entry.conditions = (entry.conditions || []).filter((c) => !removeSet.has(String(c).toLowerCase().trim()));
        }
        if (Array.isArray(change.newConditions) && change.newConditions.length > 0) {
            entry.conditions = entry.conditions || [];
            for (const condition of change.newConditions) {
                const clean = String(condition || '').trim();
                if (clean && !entry.conditions.some((c) => c.toLowerCase() === clean.toLowerCase())) {
                    entry.conditions.push(clean);
                }
            }
        }

        if (Array.isArray(change.inventoryRemove) && change.inventoryRemove.length > 0) {
            for (const item of change.inventoryRemove) {
                const itemName = String(item?.name || '').trim();
                if (!itemName) continue;
                const existing = (entry.inventory || []).find((i) => i.name.toLowerCase() === itemName.toLowerCase());
                if (!existing) continue;
                existing.quantity -= (item.quantity || 1);
                if (existing.quantity <= 0) {
                    entry.inventory = entry.inventory.filter((i) => i !== existing);
                }
            }
        }
        if (Array.isArray(change.inventoryAdd) && change.inventoryAdd.length > 0) {
            entry.inventory = entry.inventory || [];
            for (const item of change.inventoryAdd) {
                const itemName = String(item?.name || '').trim();
                if (!itemName) continue;
                const existing = entry.inventory.find((i) => i.name.toLowerCase() === itemName.toLowerCase());
                if (existing) {
                    existing.quantity += (item.quantity || 1);
                } else {
                    entry.inventory.push({ name: itemName, quantity: item.quantity || 1 });
                }
            }
        }

        entry.lastUpdatedAt = new Date().toISOString();
        changed = true;
    }

    if (changed) saveCharacterState(state);
}

// Formats every tracked character's current status for prompt injection - same convention as
// character_manager.js's getPlayerLogsString().
function getCharacterStateString() {
    const state = loadCharacterState();
    const entries = Object.entries(state);
    if (entries.length === 0) return 'No characters with tracked mechanical state yet.';

    return entries.map(([name, s]) => {
        const conditionsText = (s.conditions && s.conditions.length > 0) ? s.conditions.join(', ') : 'none';
        const inventoryText = (s.inventory && s.inventory.length > 0)
            ? s.inventory.map((i) => `${i.name}${i.quantity > 1 ? ` x${i.quantity}` : ''}`).join(', ')
            : 'nothing notable';
        return `${name}: HP ${s.currentHp}/${s.maxHp}, Conditions: ${conditionsText}, Inventory: ${inventoryText}`;
    }).join('\n');
}

module.exports = {
    loadCharacterState,
    saveCharacterState,
    initializeStateFromSheet,
    reconcileMaxHp,
    applyStateChanges,
    getCharacterStateString
};