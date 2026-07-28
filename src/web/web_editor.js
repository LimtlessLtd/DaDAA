// web/web_editor.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { getAllWorldData, clearAllEntities } = require('../data/data_manager');
const {
    callRagServer,
    initializeWorldContext,
    loadSessionState,
    saveSessionState,
    readTranscriptLog,
    resetWorldCache
} = require('../ai/context_manager');
const { startSessionZero } = require('../sessions/session_manager');
const { getActiveBackgroundEvents, resolveBackgroundEventAsSurfaced, buildEventTieInContext } = require('../sessions/background_event_manager');
const { loadCharacterMap, bindCharacter, unbindCharacter, loadCharacterLogs, loadSeenDiscordUsers } = require('../characters/character_manager');
const { getRollingSummary } = require('../ai/ai_helper');
const { generateNextEvent } = require('../ai/ai_provider');
const { stopSpeaking } = require('../voice/voice_manager');
const { clearImageQueue } = require('../images/image_gen_manager');
const { getEntityImage } = require('../images/entity_image_registry');

const UI_ROOT = __dirname;
const TEMP_DATA_ROOT = path.join(__dirname, '..', '..', 'temp_data');
const PORT = Number(process.env.DA_DAA_PORT || 8000);

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
                const backgroundEventsPath = path.join(TEMP_DATA_ROOT, 'background_events.json');
                if (fs.existsSync(backgroundEventsPath)) {
                    try {
                        state.backgroundEventsData = JSON.parse(fs.readFileSync(backgroundEventsPath, 'utf8'));
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
                    // 1. Stop anything still queued/playing from the old campaign - a DM turn can
                    // queue several dialogue segments (narrator + NPC line + narrator again), so
                    // without this, whatever's still queued when the reset happens keeps playing
                    // right through it, sounding like the DM is still talking about the old game.
                    stopSpeaking();

                    // 2. Wipe RAG collections
                    await callRagServer('/clear', { collection: 'dnd_knowledge' }).catch(() => {});
                    await callRagServer('/clear', { collection: 'dnd_transcripts' }).catch(() => {});
                    await callRagServer('/clear', { collection: 'dnd_insights' }).catch(() => {});

                    // 3. Reset physical files on disk (the "purge" logic)
                    const filesToReset = {
                        'session_state.json': '{"activeScene": null, "activeNpcs": [], "activeQuests": []}',
                        'current_event.json': '{"activeEvent": null, "archivedEvents": []}',
                        'ai_memory.json': '{"summaries": []}',
                        'transcript_log.txt': '',
                        'character_map.json': '{}',
                        'character_logs.json': '[]',
                        'character_voices.json': '{}',
                        'campaign_intro.json': '{"text": null, "narratorPersona": null, "generatedAt": null}',
                        'pending_checks.json': '[]',
                        'player_logs.json': '[]',
                        'entity_images.json': '{}',
                        'background_events.json': '[]'
                    };

                    Object.entries(filesToReset).forEach(([filename, defaultValue]) => {
                        const filePath = path.join(TEMP_DATA_ROOT, filename);
                        try {
                            fs.writeFileSync(filePath, defaultValue, 'utf8');
                        } catch (e) {
                            console.warn(`-> Failed to reset ${filename}:`, e.message);
                        }
                    });

                    // 4. Wipe stored world entities (NPCs/locations/lore/etc. from the old
                    // campaign) and the in-memory cache built from them, so nothing lingers
                    // into the new campaign.
                    clearAllEntities();
                    resetWorldCache();

                    // 4b. Flush any queued image jobs and delete the actual entity/event image
                    // files - the entity_images.json manifest reset above only clears the lookup
                    // table, not the PNGs themselves, and a job for an old-campaign entity/event
                    // still mid-flight could otherwise land and get posted/persisted after this
                    // reset (same reason stopSpeaking() flushes ttsQueue in step 1).
                    clearImageQueue();
                    ['entity_images', 'event_images'].forEach((dir) => {
                        const dirPath = path.join(TEMP_DATA_ROOT, dir);
                        if (fs.existsSync(dirPath)) {
                            fs.readdirSync(dirPath).forEach((f) => {
                                try {
                                    fs.unlinkSync(path.join(dirPath, f));
                                } catch (e) {
                                    console.warn(`-> Failed to remove ${dir}/${f}:`, e.message);
                                }
                            });
                        }
                    });

                    // 5. Start Session Zero: the DM asks players for world ideas over voice.
                    // Campaign generation itself (intro lore, secret/public entities, the
                    // opening event) happens later, in index.js, once players say they're
                    // done - see handleSessionZeroInput(). This endpoint only wipes and
                    // kicks off listening; it does not wait for or trigger generation.
                    startSessionZero();

                    sendJson(res, 200, {
                        ok: true,
                        message: 'Campaign data wiped. The DM is now asking players for world ideas over voice - say "we are done" when ready to begin.'
                    });
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

        if (url.pathname === '/api/refresh') {
            if (req.method === 'POST') {
                try {
                    await initializeWorldContext();
                    sendJson(res, 200, { ok: true });
                } catch (e) {
                    sendJson(res, 500, { error: e.message });
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

                    const newEventObj = await generateNextEvent(
                        currentEventData.archivedEvents,
                        rollingSummary,
                        "Manually generated event by DM",
                        '',
                        buildEventTieInContext(getActiveBackgroundEvents(), [])
                    );

                    if (newEventObj && newEventObj.activeEvent) {
                        currentEventData.activeEvent = newEventObj.activeEvent;
                        fs.writeFileSync(eventPath, JSON.stringify(currentEventData, null, 2), 'utf8');

                        if (newEventObj.linkedBackgroundEventId) {
                            resolveBackgroundEventAsSurfaced(
                                newEventObj.linkedBackgroundEventId,
                                `Surfaced as a manually generated event: ${newEventObj.activeEvent.title}`
                            );
                        }

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

        if (pathname === '/api/campaign_intro') {
            if (req.method === 'GET') {
                const filePath = path.join(TEMP_DATA_ROOT, 'campaign_intro.json');
                if (!fs.existsSync(filePath)) {
                    sendJson(res, 200, { text: null, generatedAt: null });
                    return;
                }
                try {
                    sendJson(res, 200, JSON.parse(fs.readFileSync(filePath, 'utf8')));
                } catch (err) {
                    sendJson(res, 200, { text: null, generatedAt: null });
                }
                return;
            }
        }

        if (pathname === '/api/world_entities') {
            if (req.method === 'GET') {
                try {
                    const worldData = await getAllWorldData();
                    const types = ['npcs', 'locations', 'items', 'quests', 'lore', 'encounters'];
                    const entities = [];
                    for (const type of types) {
                        for (const record of (worldData[type] || [])) {
                            const image = getEntityImage(record.name);
                            entities.push({
                                id: record.id,
                                type,
                                name: record.name || 'Unnamed',
                                description: record.description || '',
                                secret: !!record.secret,
                                imageUrl: image ? `/temp_data/${image.path}` : null
                            });
                        }
                    }
                    entities.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
                    sendJson(res, 200, entities);
                } catch (err) {
                    sendJson(res, 500, { error: err.message });
                }
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
                await callRagServer('/clear', { collection: 'dnd_knowledge' });
                await callRagServer('/clear', { collection: 'dnd_transcripts' });
                // Without this, the in-memory worldDbCache/exactNameCache in context_manager.js
                // would keep serving the just-deleted entities until the bot restarts.
                resetWorldCache();
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
                // Previously hardcoded to application/json regardless of actual file type - harmless
                // while this path only ever served JSON/txt, but portraits/event images (.png) would
                // render broken in an <img> tag with the wrong Content-Type.
                const ext = path.extname(tempPath).toLowerCase();
                const contentTypes = {
                    '.json': 'application/json; charset=utf-8',
                    '.png': 'image/png',
                    '.txt': 'text/plain; charset=utf-8'
                };
                sendFile(res, tempPath, contentTypes[ext] || 'application/octet-stream');
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
