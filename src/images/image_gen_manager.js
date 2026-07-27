// src/images/image_gen_manager.js
// Non-blocking, rate-limited image generation queue - mirrors src/voice/voice_manager.js's
// ttsQueue/processTtsQueue pattern (push + fire-and-forget dispatch, re-entrancy guarded by a
// boolean checked synchronously before the first await, safe under JS run-to-completion
// semantics) with a time-based rate gate added on top. Callers (context_manager.js
// addWorldEntity, index.js's event-status handling) never await a job - queueing must never
// block the DM-turn pipeline, TTS, or Discord message handling, no matter how slow local image
// generation is.
//
// Python's ImageGenService has zero awareness of "kind", NPCs, events, Discord, or rate limits -
// it is a dumb prompt-in/PNG-out synthesizer, exactly like TtsService. All of that orchestration
// lives here, in Node, matching the existing precedent that voice-assignment logic for TTS also
// lives entirely in Node rather than in the Python service.
const fs = require('fs');
const path = require('path');
const http = require('http');
const config = require('../../config.json');
const { registerPortrait, getPortrait } = require('./portrait_registry');

const TEMP_DATA_DIR = path.join(__dirname, '..', '..', 'temp_data');

let activeTextChannel = null;
let imageQueue = [];
let isProcessingQueue = false;
let lastDispatchAt = 0;

function setActiveTextChannel(channel) {
    activeTextChannel = channel;
}

// Flushes anything still queued - used on "Start New Campaign" so a job for the OLD campaign's
// NPC/event can't land and get persisted/posted after the reset (mirrors voice_manager.js
// stopSpeaking() flushing ttsQueue for the same reason).
function clearImageQueue() {
    imageQueue = [];
}

function enqueueNpcPortrait(entity) {
    if (!entity || !entity.id || !entity.name) return;
    if (getPortrait(entity.name)) return; // already locked in
    if (imageQueue.some((j) => j.kind === 'npc_portrait' && j.entity.id === entity.id)) return; // already queued
    imageQueue.push({ kind: 'npc_portrait', entity });
    processQueue();
}

function enqueueEventImage(activeEvent) {
    if (!activeEvent || !activeEvent.title) return;
    // Debounce to latest: drop any still-queued (not yet dispatched) event-image job before
    // adding the new one - there's only ever one active event, so an older queued job is stale
    // the moment a newer status change happens. A job already in-flight (mid-HTTP-request) can't
    // be cancelled and will still complete/post - that's fine, it just means the interleaving is
    // "in order of dispatch," not "only ever the single latest state."
    imageQueue = imageQueue.filter((j) => j.kind !== 'event_image');
    imageQueue.push({ kind: 'event_image', activeEvent });
    processQueue();
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;

    while (imageQueue.length > 0) {
        const minInterval = config.ImageGenConfig?.minIntervalMs ?? 180000;
        const waitMs = Math.max(0, lastDispatchAt + minInterval - Date.now());
        if (waitMs > 0) await sleep(waitMs);

        const job = imageQueue.shift();
        lastDispatchAt = Date.now();
        try {
            await dispatchJob(job);
        } catch (err) {
            // Silent drop, no automatic retry here - matches this codebase's existing convention
            // for best-effort background work (e.g. a failed generateNextEvent() call just logs
            // and moves on). Portraits get a light retry from a DIFFERENT call site instead (the
            // dialogue-posting hook in index.js re-checks/re-enqueues the next time that NPC
            // speaks); event images simply get another chance the next time eventStatus changes.
            console.warn(`-> Image generation job failed (${job.kind}):`, err.message);
        }
    }

    isProcessingQueue = false;
}

function dispatchJob(job) {
    if (job.kind === 'npc_portrait') return handleNpcPortraitJob(job.entity);
    if (job.kind === 'event_image') return handleEventImageJob(job.activeEvent);
    return Promise.resolve();
}

async function handleNpcPortraitJob(entity) {
    const prompt = `fantasy RPG character portrait, painterly digital art, bust shot: ${entity.name}, ${entity.description}`;
    const pngBuffer = await requestImage(prompt, { width: 512, height: 512 });

    const relPath = `portraits/${entity.id}.png`;
    fs.mkdirSync(path.join(TEMP_DATA_DIR, 'portraits'), { recursive: true });
    fs.writeFileSync(path.join(TEMP_DATA_DIR, relPath), pngBuffer);

    registerPortrait(entity, relPath, prompt);
    console.log(`-> Portrait generated for ${entity.name}`);
    // No Discord post here - portraits are posted only when the NPC actually speaks (see
    // index.js runDmTurn()'s dialogue loop), not the moment they're generated.
}

async function handleEventImageJob(activeEvent) {
    const sceneDescription = activeEvent.currentState || activeEvent.description || '';
    const prompt = `fantasy RPG scene illustration: ${activeEvent.title}. ${sceneDescription}`;
    const pngBuffer = await requestImage(prompt, { width: 768, height: 512 });

    const relPath = 'event_images/current_event.png'; // overwritten each regen - one active event at a time
    fs.mkdirSync(path.join(TEMP_DATA_DIR, 'event_images'), { recursive: true });
    fs.writeFileSync(path.join(TEMP_DATA_DIR, relPath), pngBuffer);
    console.log(`-> Event image (re)generated for "${activeEvent.title}"`);

    await postToActiveChannel({
        content: `**${activeEvent.title}**`,
        files: [{ attachment: path.join(TEMP_DATA_DIR, relPath), name: 'event.png' }]
    });
}

function postToActiveChannel({ content, files }) {
    if (!activeTextChannel) {
        console.warn('-> Image ready but no active Discord text channel to post it to.');
        return Promise.resolve();
    }
    return activeTextChannel.send({ content, files }).catch((err) => {
        console.warn('-> Failed to post image to Discord:', err.message);
    });
}

function requestImage(prompt, { width, height, negativePrompt } = {}) {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({ prompt, negative_prompt: negativePrompt, width, height });
        const req = http.request({
            hostname: '127.0.0.1',
            port: 8768,
            path: '/generate',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            }
        }, (res) => {
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`ImageGen server HTTP ${res.statusCode}: ${Buffer.concat(chunks)}`));
                    return;
                }
                resolve(Buffer.concat(chunks));
            });
        });

        // Generous timeout - steady-state generation on a warm pipeline should be seconds, but
        // this covers queue contention plus any slower-than-expected CPU-fallback generation.
        req.setTimeout(180000, () => {
            req.destroy();
            reject(new Error('ImageGen server timeout'));
        });

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

module.exports = {
    enqueueNpcPortrait,
    enqueueEventImage,
    setActiveTextChannel,
    postToActiveChannel,
    clearImageQueue
};
