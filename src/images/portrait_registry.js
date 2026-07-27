// src/images/portrait_registry.js
// A small JSON manifest recording which NPCs have a generated portrait, mirroring
// src/voice/voice_registry.js's "generate once, lock in forever" pattern for TTS voices.
// Keyed by a normalized NPC name (not entity id) since dialogue segments identify a speaker by
// name (see ai_provider.js buildPrompt guideline 5), not by entity id.
//
// Deliberately does NOT import normalizeText from context_manager.js, even though it's the same
// one-line logic - context_manager.js require()s image_gen_manager.js (to fire portrait jobs
// from addWorldEntity()), which requires this file, so importing context_manager.js back from
// here would form a require cycle. Duplicating this trivial function avoids that entirely.
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', '..', 'temp_data', 'npc_portraits.json');

function normalizeName(value = '') {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function loadRegistry() {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
        }
    } catch (e) {
        console.warn('-> Failed to read npc_portraits.json:', e.message);
    }
    return {};
}

function saveRegistry(registry) {
    try {
        fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
    } catch (e) {
        console.warn('-> Failed to save npc_portraits.json:', e.message);
    }
}

// Returns { entityId, name, path, prompt, generatedAt } (path relative to temp_data/) or null.
function getPortrait(npcName) {
    const registry = loadRegistry();
    return registry[normalizeName(npcName)] || null;
}

function registerPortrait(entity, relativePath, prompt) {
    const registry = loadRegistry();
    registry[normalizeName(entity.name)] = {
        entityId: entity.id,
        name: entity.name,
        path: relativePath,
        prompt,
        generatedAt: new Date().toISOString()
    };
    saveRegistry(registry);
}

module.exports = { getPortrait, registerPortrait };
