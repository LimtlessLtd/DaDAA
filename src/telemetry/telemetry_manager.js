// src/telemetry/telemetry_manager.js
// Persists rolling history of per-stage pipeline latency (index.js runDmTurn's "Turn latency
// breakdown" - RAG/LLM/reply-to-audio/total - and voice_manager.js's speech-end -> transcript
// timing) so the dashboard's Performance tab can show trends/bottlenecks instead of only the
// single most-recent value that used to only ever reach a console.log line. Also aggregates a
// live snapshot of in-flight work (TTS/image-gen queues, pending checks, background events,
// whether a DM turn is currently running) pulled fresh from each subsystem's own state on every
// request - nothing here duplicates or caches that state.
const fs = require('fs');
const path = require('path');
const { loadPendingChecks, getOpenGroupCheck } = require('../sessions/check_manager');
const { getActiveBackgroundEvents } = require('../sessions/background_event_manager');
const { getTtsQueueStatus } = require('../voice/voice_manager');
const { getQueueStatus: getImageQueueStatus } = require('../images/image_gen_manager');

const TEMP_DATA_DIR = path.join(__dirname, '..', '..', 'temp_data');
const TURNS_PATH = path.join(TEMP_DATA_DIR, 'telemetry_turns.json');
const UTTERANCES_PATH = path.join(TEMP_DATA_DIR, 'telemetry_utterances.json');

// Telemetry never feeds a prompt, so there's no token budget to worry about (unlike
// MAX_ROLLING_SUMMARY_CHARS) - but an unbounded file would still grow forever on a long-running
// bot, same reasoning as MAX_ACTIVE_THREADS. 200 turns is comfortably more than a dashboard chart
// needs to show at once.
const MAX_ENTRIES = 200;

function readBounded(filePath) {
    if (!fs.existsSync(filePath)) return [];
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch (e) {
        return [];
    }
}

function appendBounded(filePath, entry) {
    const entries = readBounded(filePath);
    entries.push(entry);
    while (entries.length > MAX_ENTRIES) entries.shift();
    try {
        fs.mkdirSync(TEMP_DATA_DIR, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(entries), 'utf8');
    } catch (e) {
        console.warn('-> Failed to persist telemetry:', e.message);
    }
}

function average(values) {
    if (!values.length) return 0;
    return values.reduce((a, b) => a + b, 0) / values.length;
}

function recordTurnLatency({ ragLatencyMs, llmLatencyMs, ttsStartLatencyMs, totalMs, model, transcriptPreview, dialogueSegments }) {
    appendBounded(TURNS_PATH, {
        timestamp: new Date().toISOString(),
        ragLatencyMs: ragLatencyMs || 0,
        llmLatencyMs: llmLatencyMs || 0,
        ttsStartLatencyMs: ttsStartLatencyMs || 0,
        totalMs: totalMs || 0,
        model: model || null,
        transcriptPreview: transcriptPreview || '',
        dialogueSegments: dialogueSegments || 0
    });
}

function recordUtteranceLatency({ sttLatencyMs, source, transcriptPreview }) {
    appendBounded(UTTERANCES_PATH, {
        timestamp: new Date().toISOString(),
        sttLatencyMs: sttLatencyMs || 0,
        source: source || null,
        transcriptPreview: transcriptPreview || ''
    });
}

function getTurnTelemetry() {
    const entries = readBounded(TURNS_PATH);
    return {
        entries,
        aggregates: {
            avgRagMs: Math.round(average(entries.map((e) => e.ragLatencyMs))),
            avgLlmMs: Math.round(average(entries.map((e) => e.llmLatencyMs))),
            avgTtsStartMs: Math.round(average(entries.map((e) => e.ttsStartLatencyMs))),
            avgTotalMs: Math.round(average(entries.map((e) => e.totalMs))),
            count: entries.length
        }
    };
}

function getUtteranceTelemetry() {
    const entries = readBounded(UTTERANCES_PATH);
    return {
        entries,
        aggregates: {
            avgSttMs: Math.round(average(entries.map((e) => e.sttLatencyMs))),
            count: entries.length
        }
    };
}

// index.js registers a callback here once at startup, mirroring image_gen_manager.js's
// setActiveTextChannel pattern (push state into a module rather than requiring it back) - index.js
// already requires web_editor.js, which requires this module, so this module requiring index.js
// back for its dmTurnInFlight/pendingTranscriptEntries state would be circular.
let liveStatusProvider = () => ({});
function registerLiveStatusProvider(fn) {
    liveStatusProvider = fn;
}

function getLiveStatus() {
    const openGroupCheck = getOpenGroupCheck();
    return {
        ...liveStatusProvider(),
        ttsQueue: getTtsQueueStatus(),
        imageGenQueue: getImageQueueStatus(),
        pendingChecksCount: loadPendingChecks().length,
        openGroupCheckActive: !!(openGroupCheck && openGroupCheck.active),
        activeBackgroundEventsCount: getActiveBackgroundEvents().length
    };
}

module.exports = {
    recordTurnLatency,
    recordUtteranceLatency,
    getTurnTelemetry,
    getUtteranceTelemetry,
    registerLiveStatusProvider,
    getLiveStatus
};
