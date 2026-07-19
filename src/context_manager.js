const fs = require('fs');
const path = require('path');
const http = require('http');
const { getAllWorldData } = require('./data_manager');

const dataDir = path.join(__dirname, '..', 'temp_data');
const relationshipsPath = path.join(dataDir, 'relationships.json');
const transcriptLogPath = path.join(dataDir, 'transcript_log.txt');
const sessionStatePath = path.join(dataDir, 'session_state.json');

// Lightweight in-memory caches for O(1) exact lookups
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
    
    // Immediately push new state to RAG so the AI DM knows the current scene
    const activeText = `Active Scene: ${state.activeScene || 'None'}\nActive NPCs: ${state.activeNpcs?.join(', ') || 'None'}`;
    callRagServer('/add', {
        collection: 'dnd_knowledge',
        documents: [activeText],
        metadatas: [{ source: 'session_state', category: 'Live State' }],
        ids: ['current_session_state'] // Static ID means it gracefully overwrites old state
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

        // Increase timeout to 60 seconds to allow for large Foundry data syncing
        req.setTimeout(60000, () => {
            req.destroy();
            reject(new Error("RAG Server timeout"));
        });

        req.on('error', (e) => {
            console.warn(`-> RAG Server unreachable at ${apiPath}.`);
            // Do NOT retry here. Let the bot continue; it will try again next cycle.
            resolve(null); 
        });
        
        req.write(payload);
        req.end();
    });
}

async function syncKnowledgeToRAG(worldData) {
    console.log('-> Syncing Foundry data to RAG database...');
    worldDbCache.clear();
    exactNameCache.clear();

    const recordsForRag = [];

    // 1. Populate lightweight caches and prep RAG payload
    Object.entries(worldData).forEach(([category, items]) => {
        (items || []).forEach(record => {
            if (!record || !record._id) return;
            
            const name = record.name || record.title || record.label || record._id;
            const description = extractDescription(record);
            const enrichedRecord = { ...record, category, name, description };
            
            // Store full object in memory for exact lookups
            worldDbCache.set(record._id, enrichedRecord);
            exactNameCache.set(normalizeText(name), record._id);

            recordsForRag.push(enrichedRecord);
        });
    });

    // 2. Batch upload to RAG
    try {
        const BATCH_SIZE = 50;
        for (let i = 0; i < recordsForRag.length; i += BATCH_SIZE) {
            const batch = recordsForRag.slice(i, i + BATCH_SIZE);
            const documents = batch.map(r => `${r.name}\n${r.description || ''}`);
            const metadatas = batch.map(r => ({ source: 'foundry_vtt', name: r.name, category: r.category }));
            const ids = batch.map(r => r._id);
            
            await callRagServer('/add', { collection: 'dnd_knowledge', documents, metadatas, ids });
        }
        console.log(`-> Successfully synced ${recordsForRag.length} records to RAG database.`);
    } catch (e) {
        console.warn('-> Failed to sync to RAG server:', e.message);
    }
}

async function resolveRecordReference(input) {
    if (!input) return null;

    // 1. O(1) Exact ID Match
    if (worldDbCache.has(input)) return worldDbCache.get(input);

    // 2. O(1) Exact Name Match
    const normalized = normalizeText(input);
    if (exactNameCache.has(normalized)) return worldDbCache.get(exactNameCache.get(normalized));

    // 3. Fallback: RAG Semantic Search
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
            // Map the vector IDs back to the FULL objects in our cache
            return response.results.ids[0]
                .map(id => worldDbCache.get(id))
                .filter(Boolean); // Filter out any undefined just in case
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

    // Use our exactNameCache to find IDs based on labels
    for (const entry of relationships) {
        if ((!entry.sourceId || !entry.targetId) && entry.source && entry.target) {
            // Your old code relied on category:name, we normalize just to be safe
            const sNameMatch = entry.source.split(':').pop();
            const tNameMatch = entry.target.split(':').pop();
            
            const sId = exactNameCache.get(normalizeText(sNameMatch)) || null;
            const tId = exactNameCache.get(normalizeText(tNameMatch)) || null;

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
                        fs.writeFileSync(transcriptLogPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
                        return `[${m[1]}] [${source}] ${newText}`;
                    }
                }
            }
        }
    } catch (err) {}

    const line = `[${timestamp}] [${source}] ${text}`;
    fs.appendFileSync(transcriptLogPath, `${line}\n`, 'utf8');
    
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
        const lines = content.split('\n').filter(Boolean);
        
        // Strictly sort lines by the ISO timestamp inside the first brackets
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
    
    // Syncs to RAG and populates the ID maps
    await syncKnowledgeToRAG(worldData);

    let relationships = loadRelationships();
    if (!Array.isArray(relationships)) relationships = [];

    try {
        const mig = migrateRelationships();
        relationships = mig.relationships;
        if (mig.migrated) console.log('-> Migrated relationships to include ids');
    } catch (e) {}

    // Cleanup stale relationships linking to deleted Foundry items
    if (relationships.length > 0 && worldDbCache.size > 0) {
        const cleaned = relationships.filter((r) => {
            try {
                if (r.sourceId && r.targetId) {
                    return worldDbCache.has(r.sourceId) && worldDbCache.has(r.targetId);
                }
                return true; // Keep manual label-only links
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
};