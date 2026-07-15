const fs = require('fs');
const path = require('path');
const { getAllWorldData } = require('./data_manager');

const dataDir = path.join(__dirname, '..', 'temp_data');
const relationshipsPath = path.join(dataDir, 'relationships.json');
const transcriptLogPath = path.join(dataDir, 'transcript_log.txt');

function ensureDataDirectories() {
    fs.mkdirSync(dataDir, { recursive: true });
}

function normalizeText(value = '') {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function buildKnowledgeIndex(worldData = {}) {
    const index = {
        byId: new Map(),
        byName: new Map(),
        records: [],
        categories: new Map(),
    };

    Object.entries(worldData).forEach(([category, records]) => {
        (records || []).forEach((record) => {
            if (!record || !record._id) return;

            const name = record.name || record.title || record.label || record._id;
            const entry = { ...record, category, name };

            index.records.push(entry);
            index.byId.set(record._id, entry);

            const normalizedName = normalizeText(name);
            if (normalizedName) {
                index.byName.set(normalizedName, entry);
            }

            if (!index.categories.has(category)) {
                index.categories.set(category, []);
            }
            index.categories.get(category).push(entry);
        });
    });

    return index;
}

function resolveRecordReference(knowledgeIndex, input) {
    if (!input) return null;

    const direct = knowledgeIndex.byId.get(input);
    if (direct) return direct;

    const normalized = normalizeText(input);
    if (!normalized) return null;

    const exact = knowledgeIndex.byName.get(normalized);
    if (exact) return exact;

    return knowledgeIndex.records.find((record) => normalizeText(record.name).includes(normalized)) || null;
}

function findRelevantRecords(knowledgeIndex, text) {
    const tokens = normalizeText(text).split(/\s+/).filter(Boolean);
    const matches = [];
    const seen = new Set();

    tokens.forEach((token) => {
        const record = knowledgeIndex.byName.get(token);
        if (record && !seen.has(record._id)) {
            matches.push(record);
            seen.add(record._id);
        }
    });

    if (matches.length === 0) {
        const phrase = normalizeText(text);
        if (phrase) {
            const phraseMatch = knowledgeIndex.byName.get(phrase);
            if (phraseMatch) {
                matches.push(phraseMatch);
            }
        }
    }

    return matches.slice(0, 5);
}

function loadRelationships() {
    ensureDataDirectories();
    if (!fs.existsSync(relationshipsPath)) {
        return [];
    }

    try {
        return JSON.parse(fs.readFileSync(relationshipsPath, 'utf8'));
    } catch (error) {
        console.warn('-> Unable to load relationships file, starting fresh.', error.message);
        return [];
    }
}

function saveRelationships(relationships) {
    ensureDataDirectories();
    fs.writeFileSync(relationshipsPath, JSON.stringify(relationships, null, 2));
}

function addRelationship(relationships, sourceLabel, targetLabel, type = 'related', sourceId = null, targetId = null) {
    // Accept both label-only relationships and ones that include explicit ids.
    const existing = relationships.find((entry) =>
        entry.source === sourceLabel && entry.target === targetLabel && entry.type === type
    );

    if (existing) {
        return existing;
    }

    const entry = {
        id: `${Date.now()}-${Math.round(Math.random() * 1000)}`,
        source: sourceLabel,
        target: targetLabel,
        sourceId: sourceId || null,
        targetId: targetId || null,
        type,
        createdAt: new Date().toISOString(),
    };

    relationships.push(entry);
    saveRelationships(relationships);
    return entry;
}

function migrateRelationships(knowledgeIndex) {
    // Load relationships and ensure each entry includes sourceId/targetId when possible.
    const relationships = loadRelationships();
    let changed = false;

    const byLabel = new Map();
    for (const r of knowledgeIndex.records) {
        byLabel.set(`${r.category}:${r.name}`, r._id);
    }

    for (const entry of relationships) {
        if ((!entry.sourceId || !entry.targetId) && entry.source && entry.target) {
            const sId = byLabel.get(entry.source) || null;
            const tId = byLabel.get(entry.target) || null;
            if (sId && !entry.sourceId) {
                entry.sourceId = sId;
                changed = true;
            }
            if (tId && !entry.targetId) {
                entry.targetId = tId;
                changed = true;
            }
        }
    }

    if (changed) {
        saveRelationships(relationships);
    }

    return { relationships, migrated: changed };
}

function appendTranscript(text, source = 'discord') {
    ensureDataDirectories();
    const line = `[${new Date().toISOString()}] [${source}] ${text}`;
    fs.appendFileSync(transcriptLogPath, `${line}\n`, 'utf8');
    return line;
}

function readTranscriptLog() {
    if (!fs.existsSync(transcriptLogPath)) {
        return '';
    }
    return fs.readFileSync(transcriptLogPath, 'utf8');
}

function buildDmSuggestion(transcript, knowledgeIndex, relationships) {
    const relevant = findRelevantRecords(knowledgeIndex, transcript);
    const contextSummary = relevant.length > 0
        ? relevant.map((record) => `${record.category}: ${record.name}`).join(' | ')
        : 'No obvious local world references were found.';

    const recentLinks = (relationships || []).slice(-3).map((entry) => `${entry.source} → ${entry.target} (${entry.type})`);
    const linkSummary = recentLinks.length > 0 ? `Recent links: ${recentLinks.join('; ')}` : 'No saved relationships yet.';

    return `DM cue: ${transcript}\nContext: ${contextSummary}\n${linkSummary}`;
}

async function initializeWorldContext() {
    const worldData = await getAllWorldData();
    const knowledgeIndex = buildKnowledgeIndex(worldData);
    // Load relationships, attempt migration to include ids, and remove any stale entries
    let relationships = loadRelationships();
    if (!Array.isArray(relationships)) relationships = [];

    // Try to enrich existing relationships with ids from the current knowledge index
    try {
        const mig = migrateRelationships(knowledgeIndex);
        relationships = mig.relationships;
        if (mig.migrated) console.log('-> Migrated relationships to include ids');
    } catch (e) {
        // ignore migration errors
    }

    if (relationships.length > 0) {
        const existingIds = new Set(knowledgeIndex.records.map((r) => r._id));
        const existingLabels = new Set(knowledgeIndex.records.map((r) => `${r.category}:${r.name}`));

        const cleaned = relationships.filter((r) => {
            try {
                if (r.sourceId && r.targetId) {
                    return existingIds.has(r.sourceId) && existingIds.has(r.targetId);
                }
                return existingLabels.has(r.source) && existingLabels.has(r.target);
            } catch (e) {
                return false;
            }
        });

        if (cleaned.length !== relationships.length) {
            const removed = relationships.length - cleaned.length;
            relationships = cleaned;
            saveRelationships(relationships);
            console.log(`-> Removed ${removed} stale relationships`);
        }
    }

    return { worldData, knowledgeIndex, relationships };
}

module.exports = {
    addRelationship,
    appendTranscript,
    buildDmSuggestion,
    buildKnowledgeIndex,
    findRelevantRecords,
    initializeWorldContext,
    loadRelationships,
    readTranscriptLog,
    resolveRecordReference,
    saveRelationships,
    migrateRelationships,
};
