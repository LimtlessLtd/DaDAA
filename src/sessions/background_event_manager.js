// src/sessions/background_event_manager.js
// Small file-backed store for "background events" - concurrent narrative threads that escalate,
// intersect, or resolve independently of the single "current event" mechanic (current_event.json/
// index.js runDmTurn), and mostly without the players ever being told. Mirrors check_manager.js's
// shape: sync fs, one JSON array under temp_data/, plain load/save/mutate functions.
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'temp_data');
const backgroundEventsPath = path.join(dataDir, 'background_events.json');

// Deterministic backstop on top of the prompt's "propose at most one new thread, rarely"
// instruction (ai_provider.js updateBackgroundEvents) - keeps the prompt context these threads
// feed into (this module's own update prompt, and generateNextEvent's tie-in context) bounded,
// same pattern as MAX_ROLLING_SUMMARY_CHARS in ai_helper.js.
const MAX_ACTIVE_THREADS = 4;
const MAX_HISTORY_ENTRIES = 5;
const RECORD_DESCRIPTION_CHARS = 200;

function ensureDataDirectories() {
    fs.mkdirSync(dataDir, { recursive: true });
}

function loadBackgroundEvents() {
    ensureDataDirectories();
    if (!fs.existsSync(backgroundEventsPath)) return [];
    try {
        return JSON.parse(fs.readFileSync(backgroundEventsPath, 'utf8')) || [];
    } catch (e) {
        console.warn('-> Could not read background events', e.message);
        return [];
    }
}

function saveBackgroundEvents(threads) {
    ensureDataDirectories();
    fs.writeFileSync(backgroundEventsPath, JSON.stringify(threads, null, 2));
}

function getActiveBackgroundEvents() {
    return loadBackgroundEvents().filter((t) => t.status !== 'resolved');
}

// Applies one updateBackgroundEvents() LLM result - { updates: [...], newThread: {...}|null } -
// to the store. Existing threads are matched by id; a brand new thread is only added while under
// MAX_ACTIVE_THREADS, otherwise it's dropped (logged, not queued/retried - matches this codebase's
// existing convention for best-effort background work, e.g. image generation jobs).
function applyBackgroundEventUpdates(result) {
    if (!result) return;
    const threads = loadBackgroundEvents();
    const now = new Date().toISOString();

    if (Array.isArray(result.updates)) {
        for (const update of result.updates) {
            const thread = threads.find((t) => t.id === update?.id);
            if (!thread) continue;

            if (update.currentState) thread.currentState = update.currentState;
            if (update.status === 'resolved' || update.status === 'active') thread.status = update.status;
            thread.lastUpdatedAt = now;

            if (update.note) {
                thread.history = thread.history || [];
                thread.history.push({ note: update.note, at: now });
                thread.history = thread.history.slice(-MAX_HISTORY_ENTRIES);
            }
        }
    }

    if (result.newThread && result.newThread.title && result.newThread.description) {
        const activeCount = threads.filter((t) => t.status !== 'resolved').length;
        if (activeCount < MAX_ACTIVE_THREADS) {
            threads.push({
                id: `bgevent_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
                title: result.newThread.title,
                description: result.newThread.description,
                currentState: result.newThread.description,
                status: 'active',
                secret: result.newThread.secret !== false,
                relatedEntityNames: Array.isArray(result.newThread.relatedEntityNames) ? result.newThread.relatedEntityNames : [],
                createdAt: now,
                lastUpdatedAt: now,
                history: []
            });
        } else {
            console.log(`-> Background events at cap (${MAX_ACTIVE_THREADS}) - skipping new thread "${result.newThread.title}".`);
        }
    }

    saveBackgroundEvents(threads);
}

// Called when a background thread becomes the seed of a new current event (see
// generateNextEvent's optional "linkedBackgroundEventId" in ai_provider.js) - it stops being a
// background thread the moment it surfaces as the thing players are actually facing.
function resolveBackgroundEventAsSurfaced(id, note) {
    if (!id) return;
    const threads = loadBackgroundEvents();
    const thread = threads.find((t) => t.id === id);
    if (!thread) return;

    thread.status = 'resolved';
    thread.secret = false;
    thread.lastUpdatedAt = new Date().toISOString();
    thread.history = thread.history || [];
    thread.history.push({ note: note || 'Surfaced as the new current event.', at: thread.lastUpdatedAt });
    saveBackgroundEvents(threads);
}

// Pure formatting helper shared by index.js and web_editor.js so every generateNextEvent() call
// site builds the same prompt block instead of duplicating this text in two files. `records` is
// an optional array of already-fetched world-entity records (same shape findRelevantRecords()
// returns) - callers that don't have any handy (e.g. the opening event, the manual dashboard
// "Generate new event" button) just pass [].
function buildEventTieInContext(activeThreads = [], records = []) {
    const threadsBlock = activeThreads.length > 0
        ? activeThreads.map((t) => `- [id: ${t.id}] ${t.title}: ${t.currentState || t.description}`).join('\n')
        : 'None yet.';

    const entitiesBlock = (records || []).length > 0
        ? records.map((r) => `- ${r.category}: ${r.name} - ${(r.description || '').slice(0, RECORD_DESCRIPTION_CHARS)}`).join('\n')
        : 'None established yet.';

    return `Background Threads (DM-only - players may be unaware of these; weave one in if it fits naturally):\n${threadsBlock}\n\nEstablished World Elements you may tie this new event into instead of inventing unconnected ones:\n${entitiesBlock}`;
}

module.exports = {
    loadBackgroundEvents,
    getActiveBackgroundEvents,
    applyBackgroundEventUpdates,
    resolveBackgroundEventAsSurfaced,
    buildEventTieInContext
};
