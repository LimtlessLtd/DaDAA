// src/ai/context_manager.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const { getAllWorldData, saveEntity } = require('../data/data_manager');

const dataDir = path.join(__dirname, '..', '..', 'temp_data');
const relationshipsPath = path.join(dataDir, 'relationships.json');
const transcriptLogPath = path.join(dataDir, 'transcript_log.txt');
const sessionStatePath = path.join(dataDir, 'session_state.json');

const worldDbCache = new Map();
const exactNameCache = new Map();

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
    
    const activeText = `Active Scene: ${state.activeScene || 'None'}\nActive NPCs: ${state.activeNpcs?.join(', ') || 'None'}`;
    callRagServer('/add', {
        collection: 'dnd_knowledge',
        documents: [activeText],
        metadatas: [{ source: 'session_state', category: 'Live State' }],
        ids: ['current_session_state']
    }).catch(() => {});
}

function normalizeText(value = '') {
    return String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function stripHtml(html = '') {
    return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractDescription(record) {
    if (!record) return '';
    if (Array.isArray(record.pages)) {
        const pageTexts = record.pages
            .map(p => stripHtml(p.text?.content || p.system?.description?.value || ''))
            .filter(Boolean);
        if (pageTexts.length > 0) return pageTexts.join('\n');
    }
    if (record.system?.description?.value) return stripHtml(record.system.description.value);
    if (record.system?.details?.biography?.value) return stripHtml(record.system.details.biography.value);
    if (record.system?.details?.publicNotes) return stripHtml(record.system.details.publicNotes);
    if (record.description) return stripHtml(record.description);
    if (record.content) return stripHtml(record.content);
    if (record.text) return stripHtml(record.text);
    return '';
}

function callRagServer(apiPath, data) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify(data);
        const options = {
            hostname: '127.0.0.1',
            port: 8766,
            path: apiPath,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        };

        const req = http.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => responseData += chunk);
            res.on('end', () => resolve(JSON.parse(responseData || '{}')));
        });

        req.setTimeout(60000, () => {
            req.destroy();
            reject(new Error("RAG Server timeout"));
        });

        req.on('error', (e) => {
            console.warn(`-> RAG Server unreachable at ${apiPath}.`);
            resolve(null); 
        });
        
        req.write(payload);
        req.end();
    });
}

// Everything goes into a single 'dnd_knowledge' collection (tagged with a "type" metadata
// field for filtering, not split by category) because findRelevantRecords() only ever
// queries 'dnd_knowledge' - splitting into per-category collections here previously meant
// synced entities were written somewhere the retrieval path never looked, so they never
// actually reached the DM's prompt no matter how much was synced.
async function syncKnowledgeToRAG(worldData) {
    console.log('-> Syncing game data to RAG database...');
    worldDbCache.clear();
    exactNameCache.clear();

    const recordsForRag = [];

    Object.entries(worldData).forEach(([category, items]) => {
        (items || []).forEach(record => {
            if (!record) return;

            const id = record.id || `${category}_${Math.random().toString(36).substr(2, 9)}`;
            const name = record.name || record.title || id;
            const description = extractDescription(record);
            const enrichedRecord = { ...record, id, category, name, description };

            worldDbCache.set(id, enrichedRecord);
            exactNameCache.set(normalizeText(name), id);

            recordsForRag.push(enrichedRecord);
        });
    });

    try {
        const BATCH_SIZE = 50;
        for (let i = 0; i < recordsForRag.length; i += BATCH_SIZE) {
            const batch = recordsForRag.slice(i, i + BATCH_SIZE);
            const documents = batch.map(r => `${r.name}\n${r.description || ''}`);
            const metadatas = batch.map(r => ({
                source: 'game_data',
                name: r.name,
                type: r.category,
                entity_id: r.id
            }));
            const ids = batch.map(r => r.id);

            await callRagServer('/add', {
                collection: 'dnd_knowledge',
                documents: documents,
                metadatas: metadatas,
                ids: ids
            });
        }
        console.log(`-> Successfully synced ${recordsForRag.length} total records to RAG database.`);
    } catch (e) {
        console.warn('-> Failed to sync to RAG server:', e.message);
    }
}

// Persists a single DM-invented world element (new location, NPC, item, quest, lore, or
// encounter) so it survives beyond the current session, and makes it immediately queryable
// via findRelevantRecords() without waiting for a restart. Skips names already known (case-
// insensitive) so the DM re-mentioning an established place doesn't create a duplicate entity.
async function addWorldEntity(type, name, description, secret = false) {
    const validTypes = ['npcs', 'locations', 'items', 'quests', 'lore', 'encounters'];
    const cleanName = String(name || '').trim();
    const cleanDescription = String(description || '').trim();
    const isSecret = !!secret;

    if (!validTypes.includes(type) || !cleanName || !cleanDescription) {
        console.warn('-> Skipped malformed world entity:', JSON.stringify({ type, name, description }));
        return null;
    }

    const normalized = normalizeText(cleanName);
    if (exactNameCache.has(normalized)) {
        return null; // already established - not a new invention, just a re-mention
    }

    const entity = saveEntity(type, { name: cleanName, description: cleanDescription, category: type, secret: isSecret });

    worldDbCache.set(entity.id, entity);
    exactNameCache.set(normalized, entity.id);

    await callRagServer('/add', {
        collection: 'dnd_knowledge',
        documents: [`${cleanName}\n${cleanDescription}`],
        metadatas: [{ source: 'dm_generated', name: cleanName, type, entity_id: entity.id, secret: isSecret }],
        ids: [entity.id]
    }).catch(() => {});

    console.log(`-> DM invented new ${isSecret ? 'secret ' : ''}${type}: ${cleanName}`);
    return entity;
}

async function addWorldEntities(entries) {
    if (!entries || !Array.isArray(entries) || entries.length === 0) return;
    for (const entry of entries) {
        await addWorldEntity(entry?.type, entry?.name, entry?.description, entry?.secret);
    }
}

// Clears the in-memory world cache without touching disk or RAG - used after an external
// wipe (e.g. /api/start_campaign deleting temp_data/<type>/ files) so stale cached entities
// don't cause false-positive dedup matches or get retrieved after they no longer exist on disk.
function resetWorldCache() {
    worldDbCache.clear();
    exactNameCache.clear();
}

async function resolveRecordReference(input) {
    if (!input) return null;

    if (worldDbCache.has(input)) return worldDbCache.get(input);

    const normalized = normalizeText(input);
    if (exactNameCache.has(normalized)) return worldDbCache.get(exactNameCache.get(normalized));

    try {
        const response = await callRagServer('/query', {
            collection: 'dnd_knowledge',
            query_texts: [input],
            n_results: 1
        });
        
        if (response.results?.ids?.[0]?.length > 0) {
            const matchedId = response.results.ids[0][0];
            return worldDbCache.get(matchedId) || null;
        }
    } catch (e) {
        console.warn('-> RAG resolve reference failed:', e.message);
    }
    return null;
}

async function findRelevantRecords(text) {
    if (!text || text.trim().length === 0) return [];
    
    const sessionState = loadSessionState();
    let queryText = text;
    
    if (sessionState.activeScene) queryText += ` ${sessionState.activeScene}`;
    sessionState.activeNpcs.forEach(npc => queryText += ` ${npc}`);

    try {
        const response = await callRagServer('/query', { 
            collection: 'dnd_knowledge',
            query_texts: [queryText], 
            n_results: 8 
        });
        
        if (response.results?.ids?.[0]?.length > 0) {
            return response.results.ids[0]
                .map(id => worldDbCache.get(id))
                .filter(Boolean);
        }
    } catch (e) {
        console.warn('-> RAG query failed:', e.message);
    }
    return [];
}

function loadRelationships() {
    ensureDataDirectories();
    if (!fs.existsSync(relationshipsPath)) return [];
    try {
        return JSON.parse(fs.readFileSync(relationshipsPath, 'utf8'));
    } catch (error) {
        return [];
    }
}

function saveRelationships(relationships) {
    ensureDataDirectories();
    fs.writeFileSync(relationshipsPath, JSON.stringify(relationships, null, 2));
}

function addRelationship(relationships, sourceLabel, targetLabel, type = 'related', sourceId = null, targetId = null) {
    const existing = relationships.find((entry) =>
        entry.source === sourceLabel && entry.target === targetLabel && entry.type === type
    );
    if (existing) return existing;

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

function migrateRelationships() {
    const relationships = loadRelationships();
    let changed = false;

    for (const entry of relationships) {
        if ((!entry.sourceId || !entry.targetId) && entry.source && entry.target) {
            const sId = exactNameCache.get(normalizeText(entry.source)) || null;
            const tId = exactNameCache.get(normalizeText(entry.target)) || null;

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

    if (changed) saveRelationships(relationships);
    return { relationships, migrated: changed };
}

function appendTranscript(text, source = 'discord', customTimestamp = null) {
    
    ensureDataDirectories();
    const now = customTimestamp ? new Date(customTimestamp) : new Date();
    const timestamp = now.toISOString();
    
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
                    
                    if (String(lastSource) === String(source) && deltaSec <= 12 && (String(lastText).length < 400)) {
                        const sep = lastText.match(/[.!?]$/) ? ' ' : ' ';
                        const newText = `${lastText}${sep}${text}`.replace(/\s+/g, ' ').trim();
                        lines[lines.length - 1] = `[${m[1]}] [${source}] ${newText}`;
                        if (lines.length > 1000) {
                            lines.splice(0, lines.length - 1000);
                        }
                        fs.writeFileSync(transcriptLogPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
                        return `[${m[1]}] [${source}] ${newText}`;
                    }
                }
            }
        }
    } catch (err) {}

        const line = `[${timestamp}] [${source}] ${text}`;
        fs.appendFileSync(transcriptLogPath, `${line}\n`, 'utf8');
    
    try {
        const contents = fs.readFileSync(transcriptLogPath, 'utf8');
        const lines = contents.split('\n').filter(Boolean);
        if (lines.length > 1000) {
            const limitedLines = lines.slice(-1000);
            fs.writeFileSync(transcriptLogPath, limitedLines.join('\n') + '\n', 'utf8');
        }
    } catch (e) {
        console.warn('-> Failed to limit transcript file size:', e.message);
    }
    
    callRagServer('/add', {
        collection: 'dnd_transcripts',
        documents: [text],
        metadatas: [{ source, timestamp }],
        ids: [`transcript_${Date.now()}_${Math.floor(Math.random() * 1000)}`]
    }).catch(() => {});

    return line;
}

function readTranscriptLog() {
    if (!fs.existsSync(transcriptLogPath)) return '';
    try {
        const content = fs.readFileSync(transcriptLogPath, 'utf8');
        let lines = content.split('\n').filter(Boolean);
        
        // Limit to most recent 1000 lines for performance
        if (lines.length > 1000) {
            lines = lines.slice(-1000);
        }
        
        lines.sort((a, b) => {
            const matchA = a.match(/^\[(.+?)\]/);
            const matchB = b.match(/^\[(.+?)\]/);
            if (matchA && matchB) {
                return new Date(matchA[1]) - new Date(matchB[1]);
            }
            return 0;
        });
        
        return lines.join('\n') + (lines.length ? '\n' : '');
    } catch (e) {
        console.warn('-> Failed to read or sort transcript log:', e.message);
        return '';
    }
}

async function buildDmSuggestion(transcript, relationships) {
    const sessionState = loadSessionState();
    
    const relevant = await findRelevantRecords(transcript);
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

    const counts = Object.entries(worldData)
        .filter(([, records]) => records && records.length > 0)
        .map(([key, records]) => `${records.length} ${key}`);
    console.log(`-> Loaded game data: ${counts.length > 0 ? counts.join(', ') : 'no saved data yet'}`);

    await syncKnowledgeToRAG(worldData);

    let relationships = loadRelationships();
    if (!Array.isArray(relationships)) relationships = [];

    try {
        const mig = migrateRelationships();
        relationships = mig.relationships;
        if (mig.migrated) console.log('-> Migrated relationships to include ids');
    } catch (e) {}

    if (relationships.length > 0 && worldDbCache.size > 0) {
        const cleaned = relationships.filter((r) => {
            try {
                if (r.sourceId && r.targetId) {
                    return worldDbCache.has(r.sourceId) && worldDbCache.has(r.targetId);
                }
                return true;
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

    return { worldData, relationships, sessionState: loadSessionState() };
}

module.exports = {
    addRelationship,
    appendTranscript,
    buildDmSuggestion,
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
    callRagServer,
    addWorldEntities,
    resetWorldCache,
};