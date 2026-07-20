// web/web_editor.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { getAllWorldData } = require('../data/data_manager');
const { 
    callRagServer,
    loadRelationships, 
    saveRelationships, 
    addRelationship, 
    initializeWorldContext, 
    migrateRelationships, 
    loadSessionState, 
    saveSessionState, 
    readTranscriptLog 
} = require('../ai/context_manager');
const { loadSessionNotes, saveSessionNotes, addSessionNote, deleteSessionNote, startSessionZero } = require('../sessions/session_manager');
const { loadCharacterMap, bindCharacter, unbindCharacter, loadCharacterLogs, loadSeenDiscordUsers } = require('../characters/character_manager');
const { getRollingSummary } = require('../ai/ai_helper');
const { generateNextEvent } = require('../ai/ai_provider');

const UI_ROOT = path.join(__dirname, '..', '..', 'UI');
const TEMP_DATA_ROOT = path.join(__dirname, '..', '..', 'temp_data');
const PORT = Number(process.env.DA_DAA_PORT || 8000);


async function searchRecords(query = '', categoryFilter = null) {
    const normalized = String(query).trim().toLowerCase();
    
    if (!normalized) {
        return [];
    }

    try {
        const response = await callRagServer('/query', {
            collection: 'dnd_knowledge',
            query_texts: [normalized],
            n_results: 80
        });

        if (response.results && response.results.ids && response.results.ids[0]) {
            const ids = response.results.ids[0];
            const metas = response.results.metadatas[0];

            let results = ids.map((id, index) => {
                const meta = metas[index] || {};
                return {
                    id: id,
                    label: `${meta.category || 'unknown'}: ${meta.name || 'Unnamed'}`,
                    category: meta.category,
                    name: meta.name || id
                };
            });

            if (categoryFilter) {
                results = results.filter(r => String(r.category) === String(categoryFilter));
            }

            return results;
        }
    } catch (e) {
        console.warn('-> Web Editor Search failed:', e.message);
    }
    
    return [];
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk;
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, statusCode, payload) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
}

function sendFile(res, filePath, contentType) {
    fs.readFile(filePath, (error, data) => {
        if (error) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found');
            return;
        }

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
}

function resolveStaticPath(urlPath) {
    if (urlPath === '/') {
        return path.join(UI_ROOT, 'dashboard.html');
    }

    const candidate = decodeURIComponent(urlPath.replace(/^\//, ''));
    const directPath = path.join(UI_ROOT, candidate);
    if (directPath.startsWith(UI_ROOT) && fs.existsSync(directPath)) {
        return directPath;
    }

    return null;
}

function startWebEditor() {
    const server = http.createServer(async (req, res) => {
            const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
            const pathname = String(url.pathname || '').replace(/\/$/, '');
            

        if (pathname === '/api/session_state') {
            if (req.method === 'GET') {
                const state = loadSessionState();
                const eventPath = path.join(TEMP_DATA_ROOT, 'current_event.json');
                if (fs.existsSync(eventPath)) {
                    try {
                        state.currentEventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
                    } catch(e) {}
                }
                sendJson(res, 200, state);
                return;
            }
            if (req.method === 'POST') {
                try {
                    const payload = await readJsonBody(req);
                    const currentState = loadSessionState();
                    const newState = { ...currentState, ...payload };
                    saveSessionState(newState);
                    sendJson(res, 200, { ok: true });
                } catch (err) {
                    sendJson(res, 400, { error: err.message });
                }
                return;
            }
        }

        if (pathname === '/api/start_campaign') {
            if (req.method === 'POST') {
                try {
                    // 1. Wipe RAG collections
                    await callRagServer('/clear', { collection: 'dnd_knowledge' }).catch(() => {});
                    await callRagServer('/clear', { collection: 'dnd_transcripts' }).catch(() => {});
                    await callRagServer('/clear', { collection: 'dnd_insights' }).catch(() => {});

                    // 2. Reset physical files on disk (the "purge" logic)
                    const filesToReset = {
                        'relationships.json': '[]',
                        'session_notes.json': '[]',
                        'session_reminders.json': '[]',
                        'session_state.json': '{"activeScene": null, "activeNpcs": [], "activeQuests": []}',
                        'ai_memory.json': '{"summaries": []}',
                        'transcript_log.txt': ''
                    };

                    Object.entries(filesToReset).forEach(([filename, defaultValue]) => {
                        const filePath = path.join(TEMP_DATA_ROOT, filename);
                        try {
                            fs.writeFileSync(filePath, defaultValue, 'utf8');
                        } catch (e) {
                            console.warn(`-> Failed to reset ${filename}:`, e.message);
                        }
                    });

                    // 3. Start the new session
                    startSessionZero();
                    sendJson(res, 200, { ok: true, message: 'Database and local memory wiped; Session Zero triggered.' });
                } catch (err) {
                    sendJson(res, 500, { error: err.message });
                }
                return;
            }
        }

        if (pathname === '/api/rag_query') {
            if (req.method === 'POST') {
                try {
                    const payload = await readJsonBody(req);
                    const response = await callRagServer('/query', {
                        collection: payload.collection || 'dnd_knowledge',
                        query_texts: [payload.query],
                        n_results: 3
                    });
                    sendJson(res, 200, response);
                } catch (err) {
                    sendJson(res, 500, { error: err.message });
                }
                return;
            }
        }

        if (pathname === '/api/health') {
            sendJson(res, 200, { ok: true });
            return;
        }

        if (pathname === '/api/purge') {
            if (req.method === 'POST') {
                try {
                    const payload = await readJsonBody(req);
                    if (payload.confirm !== 'PURGE') {
                        sendJson(res, 400, { error: 'Confirmation key "PURGE" is required.' });
                        return;
                    }

                    const filesToReset = {
                        'relationships.json': '[]',
                        'session_notes.json': '[]',
                        'session_reminders.json': '[]',
                        'session_state.json': '{"activeScene": null, "activeNpcs": [], "activeQuests": []}',
                        'ai_memory.json': '{"summaries": []}',
                        'transcript_log.txt': ''
                    };

                    Object.entries(filesToReset).forEach(([filename, defaultValue]) => {
                        const filePath = path.join(TEMP_DATA_ROOT, filename);
                        try {
                            fs.writeFileSync(filePath, defaultValue, 'utf8');
                        } catch (e) {
                            console.warn(`-> Failed to reset ${filename}:`, e.message);
                        }
                    });

                    await callRagServer('/clear', { collection: 'dnd_transcripts' }).catch(() => {});

                    console.log('-> Local campaign session data has been purged successfully.');
                    sendJson(res, 200, { ok: true, message: 'All local session data has been purged.' });
                } catch (error) {
                    sendJson(res, 500, { error: error.message });
                }
                return;
            }
        }


        if (pathname === '/api/records') {
            try {
                const query = url.searchParams.get('query') || '';
                const category = url.searchParams.get('category') || null;
                const results = await searchRecords(query, category);
                sendJson(res, 200, results);
            } catch (error) {
                sendJson(res, 500, { error: error.message });
            }
            return;
        }


        if (pathname === '/api/categories') {
            try {
                const catsPath = path.join(TEMP_DATA_ROOT, 'categories.json');
                if (fs.existsSync(catsPath)) {
                    sendJson(res, 200, JSON.parse(fs.readFileSync(catsPath, 'utf8')));
                } else {
                    sendJson(res, 200, []);
                }
            } catch (e) {
                sendJson(res, 500, { error: e.message });
            }
            return;
        }


        if (pathname === '/api/record') {
            try {
                const id = url.searchParams.get('id');
                if (!id) {
                    sendJson(res, 400, { error: 'id required' });
                    return;
                }
                
                const worldData = await getAllWorldData();
                let foundRecord = null;
                Object.values(worldData).forEach(categoryArray => {
                    if (foundRecord) return;
                    const match = categoryArray.find(r => r._id === id);
                    if (match) foundRecord = match;
                });

                if (!foundRecord) {
                    sendJson(res, 404, { error: 'record not found' });
                    return;
                }
                sendJson(res, 200, foundRecord);
            } catch (error) {
                sendJson(res, 500, { error: error.message });
            }
            return;
        }

        if (url.pathname === '/api/relationships') {
            if (req.method === 'GET') {
                sendJson(res, 200, loadRelationships());
                return;
            }

            if (req.method === 'POST') {
                try {
                    const payload = await readJsonBody(req);
                    const relationships = loadRelationships();
                    const entry = addRelationship(
                        relationships,
                        payload.source,
                        payload.target,
                        payload.type || 'related',
                        payload.sourceId || null,
                        payload.targetId || null
                    );
                    sendJson(res, 200, entry);
                } catch (error) {
                    sendJson(res, 400, { error: error.message });
                }
                return;
            }
        }

        if (url.pathname === '/api/refresh') {
            if (req.method === 'POST') {
                try {
                    const { relationships } = await initializeWorldContext();
                    const mig = migrateRelationships();
                    sendJson(res, 200, { ok: true, relationships: relationships.length, migrated: mig.migrated });
                } catch (e) {
                    sendJson(res, 500, { error: e.message });
                }
                return;
            }
        }

        if (pathname === '/api/session_notes') {
            if (req.method === 'GET') {
                sendJson(res, 200, loadSessionNotes());
                return;
            }

            if (req.method === 'POST') {
                try {
                    const payload = await readJsonBody(req);
                    const notes = loadSessionNotes();
                    const entry = addSessionNote(notes, payload);
                    sendJson(res, 200, entry);
                } catch (err) {
                    sendJson(res, 400, { error: err.message });
                }
                return;
            }
        }

        if (pathname.startsWith('/api/session_notes/')) {
            if (req.method === 'DELETE') {
                const id = pathname.split('/').pop();
                const notes = loadSessionNotes();
                const next = deleteSessionNote(notes, id);
                sendJson(res, 200, next);
                return;
            }
        }

        if (pathname === '/api/session_reminders') {
            if (req.method === 'GET') {
                const remindersPath = path.join(TEMP_DATA_ROOT, 'session_reminders.json');
                if (fs.existsSync(remindersPath)) {
                    try {
                        const data = JSON.parse(fs.readFileSync(remindersPath, 'utf8'));
                        sendJson(res, 200, data);
                    } catch (error) {
                        sendJson(res, 500, { error: error.message });
                    }
                } else {
                    sendJson(res, 200, []);
                }
                return;
            }
        }

        if (pathname === '/api/transcript_log' || url.pathname === '/api/transcript_log' || pathname === '/api/transcript_log/') {
            if (req.method === 'GET') {
                const transcriptPath = path.join(TEMP_DATA_ROOT, 'transcript_log.txt');
                                if (fs.existsSync(transcriptPath)) {
                    const content = fs.readFileSync(transcriptPath, 'utf8');
                    sendText(res, 200, content);
                } else {
                    sendText(res, 200, '');
                }
                return;
            }
        }

        if (url.pathname.startsWith('/api/relationships/')) {
            const id = url.pathname.split('/').pop();
            if (req.method === 'DELETE') {
                const relationships = loadRelationships();
                const nextRelationships = relationships.filter((entry) => entry.id !== id);
                if (nextRelationships.length !== relationships.length) {
                    saveRelationships(nextRelationships);
                    sendJson(res, 200, { ok: true });
                } else {
                    sendJson(res, 404, { error: 'Relationship not found' });
                }
                return;
            }
        }

        if (pathname === '/api/discord_users') {
            if (req.method === 'GET') {
                sendJson(res, 200, loadSeenDiscordUsers());
                return;
            }
        }

        if (pathname === '/api/entities') {
            if (req.method === 'GET') {
                const worldData = await getAllWorldData();
        
                const allCharacters = (worldData.characters || []).map(c => c.name).filter(Boolean);
        
                const allLocations = (worldData.locations || []).map(l => l.name).filter(Boolean);
        
                const allItems = (worldData.items || []).map(i => i.name).filter(Boolean);

                sendJson(res, 200, {
                    characters: allCharacters,
                    locations: allLocations,
                    items: allItems
                });
                return;
            }
        }

        if (pathname === '/api/generate_event') {
            if (req.method === 'POST') {
                try {
                    const rollingSummary = getRollingSummary();
                    
                    let currentEventData = { activeEvent: null, archivedEvents: [] };
                    const eventPath = path.join(TEMP_DATA_ROOT, 'current_event.json');
                    if (fs.existsSync(eventPath)) {
                        try {
                            currentEventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
                        } catch(e){}
                    }

                    const newEventObj = await generateNextEvent(currentEventData.archivedEvents, rollingSummary, "Manually generated event by DM");
                    
                    if (newEventObj && newEventObj.activeEvent) {
                        currentEventData.activeEvent = newEventObj.activeEvent;
                        fs.writeFileSync(eventPath, JSON.stringify(currentEventData, null, 2), 'utf8');
                        sendJson(res, 200, { activeEvent: currentEventData.activeEvent });
                    } else {
                        sendJson(res, 400, { error: 'Failed to generate event.' });
                    }
                } catch (err) {
                    sendJson(res, 500, { error: err.message });
                }
                return;
            }
        }

        if (pathname === '/api/character_map') {
            if (req.method === 'GET') {
                sendJson(res, 200, loadCharacterMap());
                return;
            }
            if (req.method === 'POST') {
                try {
                    const payload = await readJsonBody(req);
                    if (payload.action === 'bind') {
                        bindCharacter(payload.discordUser, payload.character);
                    } else if (payload.action === 'unbind') {
                        unbindCharacter(payload.discordUser, payload.character);
                    }
                    sendJson(res, 200, loadCharacterMap());
                } catch (err) {
                    sendJson(res, 400, { error: err.message });
                }
                return;
            }
        }

        if (pathname === '/api/character_logs') {
            if (req.method === 'GET') {
                sendJson(res, 200, loadCharacterLogs());
                return;
            }
        }

        if (pathname === '/api/shutdown') {
            if (req.method === 'POST') {
                console.log('-> Manual shutdown triggered. Detecting OS for cleanup...');
                
                // Check if we are on Windows or Linux
                const isWindows = os.platform() === 'win32';
                
                // Define command based on OS
                const killCmd = isWindows 
                    ? 'taskkill /F /IM python.exe /T && taskkill /F /IM node.exe /T' 
                    : 'pkill -f python3 && pkill -f node';

                exec(killCmd, (err) => {
                    if (err) console.error('-> Shutdown error:', err.message);
                });

                sendJson(res, 200, { ok: true, message: 'All services terminating...' });
                return;
            }
        }

        if (req.method === 'POST' && pathname === '/api/rag_clear') {
            try {
                const { callRagServer } = require('./context_manager');
                await callRagServer('/clear', { collection: 'dnd_knowledge' });
                await callRagServer('/clear', { collection: 'dnd_transcripts' });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: 'success' }));
            } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        const staticPath = resolveStaticPath(url.pathname);
        if (staticPath) {
            const ext = path.extname(staticPath).toLowerCase();
            const types = {
                '.html': 'text/html; charset=utf-8',
                '.js': 'application/javascript; charset=utf-8',
                '.css': 'text/css; charset=utf-8',
                '.json': 'application/json; charset=utf-8',
            };
            sendFile(res, staticPath, types[ext] || 'application/octet-stream');
            return;
        }

        if (url.pathname.startsWith('/temp_data/')) {
            const tempPath = path.join(TEMP_DATA_ROOT, url.pathname.replace('/temp_data/', ''));
            if (fs.existsSync(tempPath)) {
                sendFile(res, tempPath, 'application/json; charset=utf-8');
                return;
            }
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
    });

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.log(`-> Web editor already running on http://localhost:${PORT}`);
            return;
        }
        console.error('-> Web editor error:', error);
    });

    try {
        server.listen(PORT, () => {
            console.log(`-> Web editor listening on http://localhost:${PORT}`);
        });
    } catch (error) {
        if (error.code === 'EADDRINUSE') {
            console.log(`-> Web editor already running on http://localhost:${PORT}`);
            return null;
        }
        throw error;
    }

    return server;
}

module.exports = { startWebEditor };