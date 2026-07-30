// src/images/image_gen_manager.js
// Non-blocking, rate-limited image generation queue - mirrors src/voice/voice_manager.js's
// ttsQueue/processTtsQueue pattern (push + fire-and-forget dispatch, re-entrancy guarded by a
// boolean checked synchronously before the first await, safe under JS run-to-completion
// semantics) with a time-based rate gate added on top. Callers (context_manager.js
// addWorldEntity, index.js's event-status handling) never await a job - queueing must never
// block the DM-turn pipeline, TTS, or Discord message handling, no matter how slow local image
// generation is.
//
// Python's ImageGenService has zero awareness of "kind", entities, events, Discord, or rate
// limits - it is a dumb prompt-in/PNG-out synthesizer, exactly like TtsService. All of that
// orchestration lives here, in Node, matching the existing precedent that voice-assignment logic
// for TTS also lives entirely in Node rather than in the Python service.
const fs = require('fs');
const path = require('path');
const http = require('http');
const config = require('../../config.json');
const { registerEntityImage, getEntityImage } = require('./entity_image_registry');

const TEMP_DATA_DIR = path.join(__dirname, '..', '..', 'temp_data');

// Every entity type addWorldEntity() can invent gets an image, not just NPCs - each gets its own
// framing/style prefix and aspect ratio suited to what it actually is (a bust-shot portrait for
// an NPC reads oddly for a location or a quest emblem).
const ENTITY_IMAGE_STYLE = {
    npcs: { prefix: 'fantasy RPG character portrait, painterly digital art, bust shot', width: 512, height: 512 },
    locations: { prefix: 'fantasy RPG location illustration, environment concept art', width: 768, height: 512 },
    items: { prefix: 'fantasy RPG item illustration, product shot on a plain background', width: 512, height: 512 },
    quests: { prefix: 'fantasy RPG quest emblem, symbolic illustration', width: 512, height: 512 },
    lore: { prefix: 'fantasy RPG lore illustration, symbolic historical scene', width: 512, height: 512 },
    encounters: { prefix: 'fantasy RPG encounter scene illustration, dynamic action', width: 768, height: 512 }
};

let activeTextChannel = null;
let imageQueue = [];
let isProcessingQueue = false;
let lastDispatchAt = 0;
// Signature (title + scene text) of the most recently queued/generated event image - lets
// enqueueEventImage() below skip regenerating when eventStatus changed (escalated/evolved) but
// the actual visual content didn't (e.g. a turn with no resolutionSummary), instead of burning a
// generation slot on a picture that would look the same as the one already posted.
let lastEventImageSignature = null;

function setActiveTextChannel(channel) {
    activeTextChannel = channel;
}

// config.json ImageGenConfig.enabled - defaults to true (via !== false) so an existing config.json
// that predates this flag keeps working unchanged. Checked at the top of both enqueue functions
// so a disabled campaign never touches the queue, the rate gate, or the Python image server at all.
function imageGenEnabled() {
    return config.ImageGenConfig?.enabled !== false;
}

// Flushes anything still queued - used on "Start New Campaign" so a job for the OLD campaign's
// entity/event can't land and get persisted/posted after the reset (mirrors voice_manager.js
// stopSpeaking() flushing ttsQueue for the same reason).
function clearImageQueue() {
    imageQueue = [];
    lastEventImageSignature = null;
}

function eventImageSignature(activeEvent) {
    return `${activeEvent.title}::${activeEvent.currentState || activeEvent.description || ''}`;
}

function enqueueEntityImage(entity, type) {
    if (!imageGenEnabled()) return;
    if (!entity || !entity.id || !entity.name) return;
    if (!ENTITY_IMAGE_STYLE[type]) return; // unknown type - nothing sensible to generate
    if (getEntityImage(entity.name)) return; // already locked in
    if (imageQueue.some((j) => j.kind === 'entity_image' && j.entity.id === entity.id)) return; // already queued
    imageQueue.push({ kind: 'entity_image', entity, type });
    processQueue();
}

function enqueueEventImage(activeEvent) {
    if (!imageGenEnabled()) return;
    if (!activeEvent || !activeEvent.title) return;

    // Nothing actually changed (e.g. status flipped to escalated/evolved but this turn had no
    // resolutionSummary) - skip regenerating a picture that would look the same as the one
    // already generated/queued for this event.
    const signature = eventImageSignature(activeEvent);
    if (signature === lastEventImageSignature) return;
    lastEventImageSignature = signature;

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
            // and moves on). Entity images get a light retry from a DIFFERENT call site instead
            // (the dialogue-posting hook in index.js re-checks/re-enqueues the next time an NPC
            // without one speaks); event images simply get another chance the next time
            // eventStatus changes.
            console.warn(`-> Image generation job failed (${job.kind}):`, err.message);
        }
    }

    isProcessingQueue = false;
}

function dispatchJob(job) {
    if (job.kind === 'entity_image') return handleEntityImageJob(job.entity, job.type);
    if (job.kind === 'event_image') return handleEventImageJob(job.activeEvent);
    return Promise.resolve();
}

async function handleEntityImageJob(entity, type) {
    const style = ENTITY_IMAGE_STYLE[type];
    const prompt = `${style.prefix}: ${entity.name}, ${entity.description}`;
    const pngBuffer = await requestImage(prompt, { width: style.width, height: style.height });

    const relPath = `entity_images/${entity.id}.png`;
    fs.mkdirSync(path.join(TEMP_DATA_DIR, 'entity_images'), { recursive: true });
    fs.writeFileSync(path.join(TEMP_DATA_DIR, relPath), pngBuffer);

    registerEntityImage(entity, type, relPath, prompt);
    console.log(`-> Image generated for ${type}: ${entity.name}`);
    // No Discord post here for most types - an NPC's image is posted only when they actually
    // speak (see index.js runDmTurn()'s dialogue loop), not the moment it's generated. Other
    // entity types currently only surface on the dashboard - nothing else in the game loop
    // reacts to a location/item/quest/lore/encounter being invented the way dialogue does to
    // an NPC speaking.
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
        content: `**${activeEvent.title}**` + (sceneDescription ? `\n**Image description:** *${sceneDescription}*` : ''),
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

// Live snapshot for the dashboard's Performance tab - current state, not history. queuedKinds is
// a short human-readable label per queued (not-yet-dispatched) job, so the dashboard can show
// "what's waiting" without needing to know this module's internal job-shape.
function getQueueStatus() {
    return {
        queueLength: imageQueue.length,
        isProcessing: isProcessingQueue,
        enabled: imageGenEnabled(),
        minIntervalMs: config.ImageGenConfig?.minIntervalMs ?? 240000,
        msSinceLastDispatch: lastDispatchAt ? Date.now() - lastDispatchAt : null,
        queuedKinds: imageQueue.map((j) => j.kind === 'event_image' ? `event: ${j.activeEvent?.title || '?'}` : `entity: ${j.entity?.name || '?'}`)
    };
}

module.exports = {
    enqueueEntityImage,
    enqueueEventImage,
    setActiveTextChannel,
    postToActiveChannel,
    clearImageQueue,
    getQueueStatus
};
