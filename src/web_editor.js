const http = require('http');
const fs = require('fs');
const path = require('path');
const { getAllWorldData } = require('./data_manager');
const { buildKnowledgeIndex, loadRelationships, saveRelationships, addRelationship, initializeWorldContext, migrateRelationships } = require('./context_manager');
const { loadSessionNotes, saveSessionNotes, addSessionNote, deleteSessionNote } = require('./session_manager');

const UI_ROOT = path.join(__dirname, '..', 'UI');
const TEMP_DATA_ROOT = path.join(__dirname, '..', 'temp_data');
const PORT = Number(process.env.DA_DAA_PORT || 8000);

function formatRecordLabel(record) {
    const name = record.name || record.title || record.label || record._id || 'Unnamed';
    return `${record.category || 'unknown'}: ${name}`;
}

async function loadRecordIndex() {
    const worldData = await getAllWorldData();
    return buildKnowledgeIndex(worldData);
}

function searchRecords(knowledgeIndex, query = '') {
    const normalized = String(query).trim().toLowerCase();
    const records = Array.from(knowledgeIndex.records || []);

    if (!normalized) {
        return records.slice(0, 80).map((record) => ({
            id: record._id,
            label: formatRecordLabel(record),
            category: record.category,
            name: record.name || record.title || record._id,
        }));
    }

    return records
        .filter((record) => {
            const label = formatRecordLabel(record).toLowerCase();
            return label.includes(normalized);
        })
        .slice(0, 80)
        .map((record) => ({
            id: record._id,
            label: formatRecordLabel(record),
            category: record.category,
            name: record.name || record.title || record._id,
        }));
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
            // small debug hook: uncomment to log incoming api paths
            // console.log('-> web-editor request', pathname);

        if (pathname === '/api/health') {
            sendJson(res, 200, { ok: true });
            return;
        }

        if (pathname === '/api/records') {
            try {
                const knowledgeIndex = await loadRecordIndex();
                const query = url.searchParams.get('query') || '';
                const category = url.searchParams.get('category') || null;
                let results = searchRecords(knowledgeIndex, query);
                if (category) {
                    results = results.filter((r) => String(r.category) === String(category)).slice(0, 200);
                }
                sendJson(res, 200, results);
            } catch (error) {
                sendJson(res, 500, { error: error.message });
            }
            return;
        }
        if (pathname === '/api/categories') {
            try {
                const knowledgeIndex = await loadRecordIndex();
                const cats = Array.from((knowledgeIndex.categories || new Map()).entries()).map(([k, v]) => ({ category: k, count: (v || []).length }));
                sendJson(res, 200, cats.sort((a, b) => b.count - a.count));
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
                const knowledgeIndex = await loadRecordIndex();
                // Some LevelDB keys can be strings — fall back to scanning records array if Map lookup fails
                let rec = null;
                try {
                    rec = knowledgeIndex.byId && knowledgeIndex.byId.get && knowledgeIndex.byId.get(id);
                } catch (e) {
                    rec = null;
                }
                if (!rec) {
                    rec = (knowledgeIndex.records || []).find((r) => String(r._id) === String(id));
                }
                if (!rec) {
                    sendJson(res, 404, { error: 'record not found' });
                    return;
                }
                sendJson(res, 200, rec);
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
                    // payload may include sourceId/targetId from the UI
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
                    const { worldData, knowledgeIndex, relationships } = await initializeWorldContext();
                    // attempt migration to enrich relationships with ids
                    const mig = migrateRelationships(knowledgeIndex);
                    // write categories to temp_data for UI fallback
                    try {
                        const cats = Array.from((knowledgeIndex.categories || new Map()).entries()).map(([k, v]) => ({ category: k, count: (v || []).length }));
                        const categoriesPath = path.join(TEMP_DATA_ROOT, 'categories.json');
                        fs.mkdirSync(TEMP_DATA_ROOT, { recursive: true });
                        fs.writeFileSync(categoriesPath, JSON.stringify(cats.sort((a, b) => b.count - a.count), null, 2));
                    } catch (e) {
                        // ignore
                    }
                    sendJson(res, 200, { ok: true, records: knowledgeIndex.records.length, relationships: relationships.length, migrated: mig.migrated });
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

        if (pathname === '/api/transcript_log') {
            if (req.method === 'GET') {
                const transcriptPath = path.join(TEMP_DATA_ROOT, 'transcript_log.txt');
                if (fs.existsSync(transcriptPath)) {
                    sendText(res, 200, fs.readFileSync(transcriptPath, 'utf8'));
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
