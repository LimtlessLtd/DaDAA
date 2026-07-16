const fs = require('fs');
const path = require('path');
const { getAllWorldData } = require('./data_manager');

const dataDir = path.join(__dirname, '..', 'temp_data');
const relationshipsPath = path.join(dataDir, 'relationships.json');
const transcriptLogPath = path.join(dataDir, 'transcript_log.txt');
const sessionStatePath = path.join(dataDir, 'session_state.json');

function ensureDataDirectories() {
    fs.mkdirSync(dataDir, { recursive: true });
}

function loadSessionState() {
    ensureDataDirectories();
    if (!fs.existsSync(sessionStatePath)) {
        return { activeScene: null, activeNpcs: [], activeQuests: [] };
    }
    try {
        return JSON.parse(fs.readFileSync(sessionStatePath, 'utf8'));
    } catch (e) {
        return { activeScene: null, activeNpcs: [], activeQuests: [] };
    }
}

function saveSessionState(state) {
    ensureDataDirectories();
    fs.writeFileSync(sessionStatePath, JSON.stringify(state, null, 2));
}

function normalizeText(value = '') {
    return String(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function stripHtml(html = '') {
    return String(html)
        .replace(/<[^>]+>/g, ' ') // Replace tags with space
        .replace(/\s+/g, ' ')     // Normalize whitespace
        .trim();
}

function extractDescription(record) {
    if (!record) return '';
    
    // 1. Journal entries with pages
    if (Array.isArray(record.pages)) {
        const pageTexts = record.pages
            .map(p => {
                const textVal = p.text?.content || p.system?.description?.value || '';
                return stripHtml(textVal);
            })
            .filter(Boolean);
        if (pageTexts.length > 0) return pageTexts.join('\n');
    }
    
    // 2. Equipment / Spells / Items
    if (record.system?.description?.value) {
        return stripHtml(record.system.description.value);
    }
    
    // 3. Actors / NPCs (biography / notes)
    if (record.system?.details?.biography?.value) {
        return stripHtml(record.system.details.biography.value);
    }
    if (record.system?.details?.publicNotes) {
        return stripHtml(record.system.details.publicNotes);
    }
    
    // 4. General fallbacks
    if (record.description) return stripHtml(record.description);
    if (record.content) return stripHtml(record.content);
    if (record.text) return stripHtml(record.text);
    
    return '';
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
            const description = extractDescription(record);
            const entry = { ...record, category, name, description };

            index.records.push(entry);
            index.byId.set(record._id, entry);

            const normalizedName = normalizeText(name);
            if (normalizedName) {
                // Store multiple records under the same name if necessary, or just the first
                if (!index.byName.has(normalizedName)) {
                    index.byName.set(normalizedName, entry);
                }
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

    // Fuzzy match
    return knowledgeIndex.records.find((record) => normalizeText(record.name).includes(normalized)) || null;
}

function findRelevantRecords(knowledgeIndex, text) {
    const sessionState = loadSessionState();
    const tokens = normalizeText(text).split(/\s+/).filter(token => token.length > 3);
    const matches = [];
    const seen = new Set();

    // Prioritize active session elements if they appear in text
    if (sessionState.activeScene) tokens.push(normalizeText(sessionState.activeScene));
    sessionState.activeNpcs.forEach(npc => tokens.push(normalizeText(npc)));

    tokens.forEach((token) => {
        // Simple keyword match against record names
        const found = knowledgeIndex.records.filter(r => normalizeText(r.name).includes(token));
        found.forEach(record => {
            if (!seen.has(record._id)) {
                matches.push(record);
                seen.add(record._id);
            }
        });
    });

    return matches.slice(0, 8);
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

function appendTranscript(text, source = 'discord', customTimestamp = null) {
    ensureDataDirectories();
    const now = customTimestamp ? new Date(customTimestamp) : new Date();
    const timestamp = now.toISOString();
    // Attempt to merge with last line if same source and recent
    let merged = false;
    try {
        if (fs.existsSync(transcriptLogPath)) {
            const contents = fs.readFileSync(transcriptLogPath, 'utf8');
            const lines = contents.split('\n').filter(Boolean);
            const last = lines.length ? lines[lines.length - 1] : null;
            if (last) {
                const m = last.match(/^\[(.+?)\] \[(.+?)\] (.*)$/);
                if (m) {
                    const lastTs = new Date(m[1]);
                    const lastSource = m[2];
                    const lastText = m[3];
                    const deltaSec = (now - lastTs) / 1000;
                    // Merge when the same source speaks again within 12 seconds and last text isn't huge.
                    if (String(lastSource) === String(source) && deltaSec <= 12 && (String(lastText).length < 400)) {
                        // If lastText ends with sentence punctuation, preserve it but still merge to avoid tiny splits.
                        const sep = lastText.match(/[.!?]$/) ? ' ' : ' ';
                        const newText = `${lastText}${sep}${text}`.replace(/\s+/g, ' ').trim();
                        lines[lines.length - 1] = `[${m[1]}] [${source}] ${newText}`;
                        fs.writeFileSync(transcriptLogPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
                        merged = true;
                        return `[${m[1]}] [${source}] ${newText}`;
                    }
                }
            }
        }
    } catch (err) {
        // ignore merge failures and fall back to appending
        console.warn('-> appendTranscript merge failed:', err && err.message);
    }

    const line = `[${timestamp}] [${source}] ${text}`;
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
    const sessionState = loadSessionState();
    const relevant = findRelevantRecords(knowledgeIndex, transcript);
    const contextSummary = relevant.length > 0
        ? relevant.map((record) => `${record.category}: ${record.name}`).join(' | ')
        : 'No obvious local world references were found.';

    const recentLinks = (relationships || []).slice(-3).map((entry) => `${entry.source} → ${entry.target} (${entry.type})`);
    const linkSummary = recentLinks.length > 0 ? `Recent links: ${recentLinks.join('; ')}` : 'No saved relationships yet.';

    const sessionSummary = `Active Scene: ${sessionState.activeScene || 'Unknown'} | NPCs: ${sessionState.activeNpcs.join(', ') || 'None'}`;

    return `DM cue: ${transcript}\nSession State: ${sessionSummary}\nContext: ${contextSummary}\n${linkSummary}`;
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

    return { worldData, knowledgeIndex, relationships, sessionState: loadSessionState() };
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
    loadSessionState,
    saveSessionState,
    stripHtml,
    extractDescription,
};
