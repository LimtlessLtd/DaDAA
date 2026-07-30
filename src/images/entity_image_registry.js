// src/images/entity_image_registry.js
// A small JSON manifest recording which world entities (NPCs, locations, items, quests, lore,
// encounters) have a generated image, mirroring src/voice/voice_registry.js's "generate once,
// lock in forever" pattern for TTS voices. Keyed by a normalized entity name (not entity id)
// since dialogue segments identify an NPC speaker by name (see ai_provider.js buildPrompt
// guideline 4), not by entity id - using the same key for every entity type keeps lookup uniform.
//
// Deliberately does NOT import normalizeText from context_manager.js, even though it's the same
// one-line logic - image_gen_manager.js (which requires this file) is required FROM
// context_manager.js in spirit (entity image jobs are triggered from world-entity/dialogue
// handling that lives there), so importing context_manager.js back from here risks a require
// cycle the moment that relationship is added directly. Duplicating this trivial function avoids
// depending on that staying true.
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', '..', 'temp_data', 'entity_images.json');

function normalizeName(value = '') {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function loadRegistry() {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
        }
    } catch (e) {
        console.warn('-> Failed to read entity_images.json:', e.message);
    }
    return {};
}

function saveRegistry(registry) {
    try {
        fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
    } catch (e) {
        console.warn('-> Failed to save entity_images.json:', e.message);
    }
}

// Returns { entityId, name, type, path, prompt, generatedAt } (path relative to temp_data/) or null.
function getEntityImage(entityName) {
    const registry = loadRegistry();
    return registry[normalizeName(entityName)] || null;
}

function registerEntityImage(entity, type, relativePath, prompt) {
    const registry = loadRegistry();
    registry[normalizeName(entity.name)] = {
        entityId: entity.id,
        name: entity.name,
        type,
        path: relativePath,
        prompt,
        generatedAt: new Date().toISOString()
    };
    saveRegistry(registry);
}

module.exports = { getEntityImage, registerEntityImage };
