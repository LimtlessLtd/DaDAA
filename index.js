// index.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinAndListen, speakText, pregenerateStaticAudio } = require('./src/voice/voice_manager');
const { getVoiceConnection } = require('@discordjs/voice');
const {
    initializeWorldContext,
    appendTranscript,
    readTranscriptLog,
    loadSessionState,
    saveSessionState,
    findRelevantRecords,
    addWorldEntity,
    addWorldEntities,
    callRagServer,
    getEntityByName,
    findMentionedEntities
} = require('./src/ai/context_manager');
const {
    enqueueEntityImage,
    enqueueEventImage,
    setActiveTextChannel,
    postToActiveChannel
} = require('./src/images/image_gen_manager');
const { getEntityImage } = require('./src/images/entity_image_registry');
const { rememberAiInsight, getRollingSummary, updateRollingSummary } = require('./src/ai/ai_helper');
const { buildPrompt, callModel, generateNextEvent, generateCampaignSeed, parseCharacterIntroductions, updateBackgroundEvents } = require('./src/ai/ai_provider');
const {
    getActiveBackgroundEvents,
    applyBackgroundEventUpdates,
    resolveBackgroundEventAsSurfaced,
    buildEventTieInContext
} = require('./src/sessions/background_event_manager');
const { startWebEditor } = require('./src/web/web_editor');
const { recordTurnLatency, recordUtteranceLatency, registerLiveStatusProvider } = require('./src/telemetry/telemetry_manager');
const {
    isSessionZeroActive,
    addSessionZeroInput,
    endSessionZero,
    startCharacterIntros,
    isCharacterIntroActive,
    addCharacterIntroInput,
    endCharacterIntros,
    SESSION_ZERO_PROMPT,
    CHARACTER_INTRO_PROMPT
} = require('./src/sessions/session_manager');
const {
    addPendingCheck,
    resolvePendingCheck,
    openGroupCheck,
    getOpenGroupCheck,
    recordOpenGroupCheckRoll,
    closeOpenGroupCheck
} = require('./src/sessions/check_manager');
const { isDiceMaidenMessage, parseDiceMaidenRoll, isDiceMaidenError } = require('./src/dice/dice_maiden');
const {
    bindCharacter,
    unbindCharacter,
    addCharacterLogs,
    loadCharacterLogs,
    recordDiscordUser,
    recordDiscordNickname,
    resolveUsernameByNickname,
    getCurrentlyPlayedCharactersString,
    getBoundCharacterName,
    getAllBoundCharacterNames
} = require('./src/characters/character_manager');
const { getCharacterStateString, applyStateChanges } = require('./src/characters/character_state_manager');
const { getCampaignEpoch } = require('./src/sessions/campaign_epoch');
const { loadDdbCharacters, refreshAllLinkedCharacters, computeSkillModifier } = require('./src/characters/ddb_import');
const config = require('./config.json');

console.log('-> Starting DaDAA...');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

let worldContext = null;
let ownerUserId = process.env.BOT_OWNER_ID || null;
const TEMP_DATA_DIR = path.join(__dirname, 'temp_data');
let transcriptCounter = 0;
let backgroundEventCounter = 0;

let stats = {
    totalUtterances: 0,
    llmCalls: 0,
    importantInsights: 0,
    lastLatencyMs: 0
};

// --- SILENCE DRIVER VARIABLES ---
// Used to just fire a brand-new LLM turn ("progress the scene") after 90s of silence - replaced
// per request with a much simpler behavior: after this much silence, just repeat whatever the DM
// last said (no new LLM call, see lastSpokenTurn/handleSilenceDriver below), and keep repeating it
// every interval for as long as the silence continues.
let silenceTimer = null;
const SILENCE_TIMEOUT_MS = config.SilenceDriverConfig?.timeoutMs ?? 5 * 60 * 1000; // ms of silence before the DM repeats itself - config.json SilenceDriverConfig.timeoutMs
let lastSpeechTimestamp = Date.now();
const activeSpeakers = new Set();

// runDmTurn has three independent trigger sites (real speech, the silence driver, dice-roll
// resolution) that used to fire-and-forget straight into runDmTurn - if two triggers landed
// close together, their LLM calls ran concurrently and whichever HTTP response came back first
// queued its narration first, regardless of which trigger actually happened first. That produced
// narration in the wrong order and let a later turn build its prompt from stale session state
// that an earlier, still-in-flight turn was about to change. Chaining every call onto this promise
// forces turns to run one at a time, in trigger order.
let dmTurnQueue = Promise.resolve();

// Bridges handleSessionZeroInput() -> beginSessionOne(): the campaign intro lore is generated
// and spoken in the former, but generateNextEvent() (called from the latter, once character
// introductions are done) still needs it as scene-setting context for the opening event.
let pendingCampaignIntroLore = null;

// The most recent turn's spoken dialogue segments ({speaker, text, voiceDescription}), replayed
// verbatim by handleSilenceDriver() on sustained silence instead of generating anything new -
// updated at the end of runDmTurn()'s dialogue loop, deliberately not touched by one-off audio
// (THINKING_FILLERS, check announcements) so silence always repeats actual narration.
let lastSpokenTurn = [];

// Tracks whether a turn is currently running anywhere in dmTurnQueue (real speech, dice-roll, or
// silence-driver triggers all funnel through here) - queueDmTranscript below uses this to avoid
// committing a new filler+turn on top of one that's still cooking. Set true synchronously before
// the promise chain resumes so a burst of enqueueDmTurn calls landing back-to-back can't all read
// it as false before the first one's runDmTurn actually starts.
let dmTurnInFlight = false;

function enqueueDmTurn(transcript) {
    dmTurnInFlight = true;
    dmTurnQueue = dmTurnQueue.then(() => runDmTurn(transcript)).catch((err) => {
        console.error('-> DM turn failed:', err.message);
        return null;
    }).finally(() => {
        dmTurnInFlight = false;
    });
    return dmTurnQueue;
}

// Ollama (CPU) + Kokoro synthesis are slow enough that players often repeat themselves while
// waiting for a reply - but every enqueueDmTurn() call is a full serialized LLM+TTS turn (see
// above), so 3-4 repeats used to queue up 3-4 slow turns back-to-back, making the wait longer
// with every repeat instead of shorter. This coalesces a burst of consecutive real-speech
// utterances (arriving within DM_TURN_DEBOUNCE_MS of each other) into a single turn, and
// immediately plays a cheap filler line the moment that turn actually commits, so players get
// audible confirmation they were heard well before the real (slow) reply comes back. Only used
// for the real-speech trigger site - dice-roll and silence-driver turns are already discrete,
// one-off events with nothing to coalesce.
//
// The debounce gap alone only coalesces a tight burst (people replying to each other within
// DM_TURN_DEBOUNCE_MS) - it says nothing about whether a turn is already being processed. A table
// naturally keeps talking with gaps longer than that while waiting on a slow local model, and
// each such gap used to commit its OWN filler+turn on top of whatever was still cooking, so
// fillers piled up and played back-to-back while real replies queued up behind them, arriving
// late and out of sync. tryCommitPendingTranscript() below checks dmTurnInFlight and, if a turn
// is still running, just reschedules itself (short poll, no new filler) instead of committing -
// so everything said while the DM is "thinking" gets folded into ONE follow-up turn once it's
// actually free, rather than each gap spawning a separate one.
const DM_TURN_DEBOUNCE_MS = 3000;
const DM_TURN_INFLIGHT_POLL_MS = 1000;
const THINKING_FILLERS = [
    "Analysing.",
    "Assessing.",
    "Calculating.",
    "Computing.",
    "Evaluating.",
    "Examining.",
    "Processing.",
    "Postulating."
];
let thinkingFillerIndex = 0;
let pendingTranscriptEntries = [];
let pendingTranscriptTimer = null;

// Lets the dashboard's Performance tab report DM-turn-queue state without telemetry_manager.js
// (required by web_editor.js, which this file requires) needing to require this file back -
// mirrors image_gen_manager.js's setActiveTextChannel push-state-in pattern. The closure reads
// dmTurnInFlight/pendingTranscriptEntries fresh on every call, not a one-time snapshot.
registerLiveStatusProvider(() => ({
    dmTurnInFlight,
    pendingTranscriptCount: pendingTranscriptEntries.length
}));

function tryCommitPendingTranscript() {
    if (dmTurnInFlight) {
        pendingTranscriptTimer = setTimeout(tryCommitPendingTranscript, DM_TURN_INFLIGHT_POLL_MS);
        return;
    }

    const entries = pendingTranscriptEntries;
    pendingTranscriptEntries = [];
    pendingTranscriptTimer = null;
    if (entries.length === 0) return;

    // Always speaker-tagged, even for a single entry - source is already resolved to the
    // bound character name (or the raw Discord username, if unbound) before it ever reaches
    // here, so the LLM sees only character names in the transcript and never needs a separate
    // Discord-user-to-character lookup table of its own (see buildPrompt()).
    const combined = entries.map((e) => `[${e.source}]: ${e.text}`).join('\n');

    speakText(THINKING_FILLERS[thinkingFillerIndex], 'narrator');
    thinkingFillerIndex = (thinkingFillerIndex + 1) % THINKING_FILLERS.length;

    enqueueDmTurn(combined);
}

function queueDmTranscript(source, transcript) {
    pendingTranscriptEntries.push({ source, text: transcript });
    if (pendingTranscriptTimer) clearTimeout(pendingTranscriptTimer);
    pendingTranscriptTimer = setTimeout(tryCommitPendingTranscript, DM_TURN_DEBOUNCE_MS);
}

// Deterministic backstop for narratorPersona's "one short sentence" instruction
// (ai_provider.js generateCampaignSeed) - local models don't always comply, and this value gets
// injected into EVERY turn's prompt for the rest of the campaign, so a model that pads it into a
// paragraph silently bloats every single prompt from then on, not just this one generation call.
// Keeps up to the first sentence-ending punctuation; a response with no punctuation at all (rare)
// falls back to a hard character cap rather than being left unbounded.
const NARRATOR_PERSONA_MAX_CHARS = 160;
function capToFirstSentence(text) {
    const trimmed = String(text || '').trim();
    const match = trimmed.match(/^[^.!?]*[.!?]/);
    let sentence = match ? match[0].trim() : trimmed;
    if (sentence.length > NARRATOR_PERSONA_MAX_CHARS) {
        const cut = sentence.slice(0, NARRATOR_PERSONA_MAX_CHARS);
        const lastSpace = cut.lastIndexOf(' ');
        sentence = (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim() + '…';
    }
    return sentence;
}

const LLM_DEBUG_PATH = path.join(TEMP_DATA_DIR, 'llm_debug.json');

function saveLlmDebug(debugInfo) {
    try {
        fs.mkdirSync(TEMP_DATA_DIR, { recursive: true });
        fs.writeFileSync(LLM_DEBUG_PATH, JSON.stringify(debugInfo, null, 2), 'utf8');
    } catch (e) {
        console.warn('-> Failed to save LLM debug info:', e.message);
    }
}

// Deterministic backstop for check announcements: the prompt asks the model to state the skill
// and DC out loud in a dialogue segment (ai_provider.js guideline 5), but it doesn't always
// comply, leaving players unsure what they're rolling for. This runs unconditionally whenever a
// check is registered, so the requirement is always announced regardless of what was narrated.
function announceCheckRequirement(character, skill, dc) {
    const announcement = `${character}, make a ${skill} check - you need to beat a DC of ${dc}.`;
    speakText(announcement, 'narrator');
    appendTranscript(announcement, 'Dungeon Master (narrator)', Date.now());
    postToActiveChannel({ content: `🎲 ${announcement}` });
}

// Same rationale as announceCheckRequirement above, for an open group check (ai_provider.js
// guideline 5b) - runs unconditionally the moment one is opened. Deliberately doesn't name
// specific characters, since unlike a solo check nobody in particular is required to respond.
function announceOpenGroupCheckRequirement(skill, dc) {
    const announcement = `Everyone, make a ${skill} check if you'd like to try - you need to beat a DC of ${dc}.`;
    speakText(announcement, 'narrator');
    appendTranscript(announcement, 'Dungeon Master (narrator)', Date.now());
    postToActiveChannel({ content: `🎲 ${announcement}` });
}

// Deterministic backstop for condition/long-rest changes, same rationale as
// announceCheckRequirement above: guideline 12 (ai_provider.js) asks the model to make a new
// condition's in-fiction cause obvious in "dialogue", but never guarantees a plain, unambiguous
// statement of *what actually changed* - without this, a condition could land with nothing but
// atmospheric prose to signal it happened at all. Runs unconditionally off applyStateChanges()'s
// return value (character_state_manager.js), not off what the narrative said.
function announceStateChanges(announcements) {
    if (!Array.isArray(announcements) || announcements.length === 0) return;
    for (const a of announcements) {
        if (a.longRest) {
            const clearedNote = a.removed.length > 0 ? `, no longer ${a.removed.join(', ')}` : '';
            const announcement = `${a.character} takes a long rest - HP fully restored${clearedNote}.`;
            speakText(announcement, 'narrator');
            appendTranscript(announcement, 'Dungeon Master (narrator)', Date.now());
            postToActiveChannel({ content: `💤 ${announcement}` });
            continue;
        }
        if (a.added.length > 0) {
            const announcement = `${a.character} is now ${a.added.join(', ')}.`;
            speakText(announcement, 'narrator');
            appendTranscript(announcement, 'Dungeon Master (narrator)', Date.now());
            postToActiveChannel({ content: `⚠️ ${announcement}` });
        }
        if (a.removed.length > 0) {
            const announcement = `${a.character} is no longer ${a.removed.join(', ')}.`;
            speakText(announcement, 'narrator');
            appendTranscript(announcement, 'Dungeon Master (narrator)', Date.now());
            postToActiveChannel({ content: `✅ ${announcement}` });
        }
    }
}

// System notice whenever the active event changes - deliberately independent of
// enqueueEventImage()'s async image job, which can fail, be disabled (ImageGenConfig.enabled), or
// simply not have finished yet; without this, a status change (or a brand new event after one
// resolves) would only ever reach players if that image happened to succeed. The narrator's own
// dialogue this turn already covers the SAME change in-fiction, but only for resolved/escalated/
// evolved on the event that just changed - a freshly generated NEXT event is produced by a
// separate, later generateNextEvent() call, so the model never had a chance to narrate it in any
// turn's "dialogue". Text-only for resolved/escalated/evolved (the narrator already spoke about
// this beat live, moments ago, in the same turn - see runDmTurn()'s dialogue loop, which always
// runs before this function). kind: 'new' ALSO speaks via TTS - there is no human DM to relay a
// Discord-only post to a table playing purely by voice, so without this a new event's very
// existence would go unannounced to anyone not reading text chat. Never called for "stable" - no
// status change, nothing to announce.
function announceEventStatusChange(kind, event, resolutionSummary) {
    const labels = { resolved: '📜 Event Resolved', escalated: '⚠️ Event Escalated', evolved: '🔄 Event Evolved', new: '📜 New Event' };
    const label = labels[kind];
    if (!label || !event) return;

    const detail = kind === 'new'
        ? [event.description, event.complication].filter(Boolean).join(' ')
        : (resolutionSummary || event.currentState || event.description);
    postToActiveChannel({ content: `${label} — **${event.title}**${detail ? `: ${detail}` : ''}` });

    if (kind === 'new' && detail) {
        const announcement = `A new development unfolds. ${detail}`;
        speakText(announcement, 'narrator');
        appendTranscript(announcement, 'Dungeon Master (narrator)', Date.now());
    }
}

// An open group check waits out a fixed response window rather than reacting to the first roll -
// unlike the "everyone must roll" style, a roll landing late (even after an earlier one already
// failed) can still flip the overall result to success, so resolving early would get the wrong
// answer, not just a less complete one. Only one group check can be open at a time (see
// check_manager.js openGroupCheck), so a single timer handle is enough - cleared the moment it
// resolves (naturally via the timeout, since there's no "everyone's answered" signal to resolve
// early on) so a stray second timer can never double-resolve it.
let openGroupCheckTimer = null;
const GROUP_CHECK_TIMEOUT_MS = config.GroupCheckConfig?.timeoutMs ?? 60000;

function scheduleOpenGroupCheckTimeout() {
    if (openGroupCheckTimer) clearTimeout(openGroupCheckTimer);
    openGroupCheckTimer = setTimeout(resolveOpenGroupCheck, GROUP_CHECK_TIMEOUT_MS);
}

// Tallies whatever voluntary rolls came in while the group check was open: a SUCCESS if at least
// one of them succeeded, a FAILURE if everyone who rolled failed or nobody rolled at all - per
// the request, this is deliberately not a majority rule, since a single success is meant to be
// enough to carry the whole group. Feeds one combined result into the normal DM-turn pipeline,
// the same way a solo check's "[Dice Roll Result]" does.
function resolveOpenGroupCheck() {
    if (openGroupCheckTimer) {
        clearTimeout(openGroupCheckTimer);
        openGroupCheckTimer = null;
    }

    const group = getOpenGroupCheck();
    if (!group) return;

    const resultEntries = Object.entries(group.results);
    const respondedCount = resultEntries.length;
    const anySucceeded = resultEntries.some(([, r]) => r.success);

    const perCharacterText = respondedCount > 0
        ? resultEntries.map(([name, r]) => `${name}: ${r.total} (${r.outcomeLabel})`).join('; ')
        : 'nobody rolled';
    const verdict = anySucceeded ? 'SUCCEEDS' : 'FAILS';

    const summary = `Group ${group.skill} check (DC ${group.dc}): ${perCharacterText} - the group ${verdict} overall.`;
    console.log(`-> ${summary}`);
    appendTranscript(summary, 'Dice', Date.now());
    closeOpenGroupCheck();

    enqueueDmTurn(`[Group Dice Roll Result] ${summary}`);
}

// Occasional, independent review of "background events" - see src/ai/ai_provider.js
// updateBackgroundEvents() and src/sessions/background_event_manager.js. Triggered from the
// utterance handler below on its own counter (config.json BackgroundEventConfig.utteranceInterval),
// deliberately decoupled from runDmTurn()/the current-event mechanic - these threads are meant to
// progress on their own schedule, not every DM turn.
async function updateCampaignBackgroundEvents() {
    const activeThreads = getActiveBackgroundEvents();
    const recentLines = readTranscriptLog().split('\n').filter(Boolean).slice(-15).join('\n');
    const result = await updateBackgroundEvents(activeThreads, getRollingSummary(), recentLines);
    if (result) {
        applyBackgroundEventUpdates(result);
        console.log(`-> Background events updated (${getActiveBackgroundEvents().length} active threads).`);
    }
}

// There is no human DM to fall back on if the model goes quiet - a player who just spoke has no
// way to tell "the DM didn't hear me" from "the DM is broken" unless something says so. Mirrors
// the fallback message generateCampaignSeed()'s failure path already speaks/posts (index.js
// handleSessionZeroInput), just not previously extended to the regular per-turn pipeline. Doesn't
// touch appendTranscript/session history - same reasoning as THINKING_FILLERS, this is a system
// notice, not narrative content.
const DM_TURN_FAILURE_MESSAGE = "Sorry, I'm having trouble gathering my thoughts right now - give me a moment and try again.";
function announceDmTurnFailure() {
    speakText(DM_TURN_FAILURE_MESSAGE, 'narrator');
    postToActiveChannel({ content: `⚠️ ${DM_TURN_FAILURE_MESSAGE}` });
}

// Shared retry wrapper around generateNextEvent() - used everywhere a new active event gets
// generated (the auto "resolved -> generate next" path below, and beginSessionOne()'s opening
// event). Both call sites used to just log-and-give-up on failure, leaving current_event.json's
// activeEvent permanently null with no player-facing signal and no automatic recovery - the only
// way to notice and fix it was a human opening the dashboard's "Generate new event" button. One
// retry catches most transient parse/provider failures; never throws, so callers don't need their
// own try/catch on top of this.
async function generateNextEventWithRetry(archivedEvents, rollingSummary, resolutionSummary, extraContext, tieInContext) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        try {
            const result = await generateNextEvent(archivedEvents, rollingSummary, resolutionSummary, extraContext, tieInContext);
            if (result && result.activeEvent) return result;
            console.warn(`-> generateNextEvent attempt ${attempt} returned no usable event.`);
        } catch (err) {
            console.error(`-> generateNextEvent attempt ${attempt} failed:`, err.message);
        }
    }
    return null;
}

// Shared pipeline: build world context, call the LLM, and react to its reply.
// Used for real transcribed speech, the silence driver's synthetic prompt, and
// dice-roll resolutions - anywhere a "DM turn" needs to happen.
async function runDmTurn(transcript) {
    if (!worldContext) return null;

    // Captured before any awaits - if /api/start_campaign resets mid-turn, this turn's reply
    // (built from records/state that may no longer exist) is discarded rather than applied on
    // top of the fresh campaign. See src/sessions/campaign_epoch.js.
    const epochAtStart = getCampaignEpoch();

    const turnStart = Date.now();
    const relevantRecords = await findRelevantRecords(transcript);
    const ragLatencyMs = Date.now() - turnStart;
    const sessionState = loadSessionState();

    let currentEventString = '';
    const eventPath = path.join(TEMP_DATA_DIR, 'current_event.json');
    let currentEventData = { activeEvent: null, archivedEvents: [] };
    if (fs.existsSync(eventPath)) {
        try {
            currentEventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
            if (currentEventData.activeEvent) {
                currentEventString = `Active Event: ${currentEventData.activeEvent.title}\nDescription: ${currentEventData.activeEvent.description}\nStakes: ${currentEventData.activeEvent.stakes || 'Unknown'}\nComplication: ${currentEventData.activeEvent.complication || 'None'}\nCurrent State (most recent development - overrides Description AND Complication above wherever they conflict): ${currentEventData.activeEvent.currentState || 'No changes yet - Description above is still accurate.'}`;
            }
        } catch (e) {}
    }

    // Read fresh each turn (same pattern as current_event.json above) rather than cached in
    // memory, so there's no stale-cache class of bug to worry about - this file is small and
    // only written once per campaign (handleSessionZeroInput), so the read cost is negligible.
    let narratorPersona = '';
    const campaignIntroPath = path.join(TEMP_DATA_DIR, 'campaign_intro.json');
    if (fs.existsSync(campaignIntroPath)) {
        try {
            narratorPersona = JSON.parse(fs.readFileSync(campaignIntroPath, 'utf8')).narratorPersona || '';
        } catch (e) {}
    }

    const contextString = `
Current Scene: ${sessionState.activeScene || 'Unknown'}
Active NPCs: ${sessionState.activeNpcs?.join(', ') || 'None'}
Records: ${relevantRecords.map((record) => `${record.category}${record.secret ? ' [SECRET]' : ''}: ${record.name} - ${(record.description || 'No description').slice(0, 300)}`).join('\n') || 'None'}
    `.trim();

    const rollingSummary = getRollingSummary();
    const currentlyPlayedStr = getCurrentlyPlayedCharactersString();
    const characterStateStr = getCharacterStateString();
    const prompt = buildPrompt(transcript, contextString, rollingSummary, currentEventString, currentlyPlayedStr, narratorPersona, characterStateStr);

    const activeModelName = config.OllamaConfig?.enabled
        ? config.OllamaConfig?.model || 'neural-chat'
        : config.LLM || 'Unknown Model';

    saveLlmDebug({
        timestamp: new Date().toISOString(),
        model: activeModelName,
        latencyMs: 0,
        transcript: transcript,
        contextString: contextString,
        rollingSummary: rollingSummary,
        fullPrompt: prompt,
        rawResponse: { reason: "Analyzing... (in-flight API request)" },
        stats: stats
    });

    const apiStartTime = Date.now();
    stats.llmCalls++;

    console.log(`-> DM thinking... (model: ${activeModelName}, transcript: "${transcript.length > 80 ? transcript.slice(0, 80) + '...' : transcript}")`);

    try {
        const aiReply = await callModel(prompt);
        const latency = Date.now() - apiStartTime;
        const aiReplyReceivedAt = Date.now();
        stats.lastLatencyMs = latency;

        if (epochAtStart !== getCampaignEpoch()) {
            console.log('-> Discarding DM turn: campaign was reset while this turn was in flight.');
            return null;
        }

        if (aiReply) {
            // Full raw reply already lands in llm_debug.json below (dashboard's Debug & RAG tab) -
            // this is just a one-line "did something come back, and roughly what" console summary,
            // not a duplicate full dump.
            const checkNote = aiReply.checkSkill ? `, check: ${aiReply.checkCharacter || '?'} ${aiReply.checkSkill} DC ${aiReply.checkDc}` : '';
            console.log(`-> DM responded in ${latency}ms (${aiReply.dialogue?.length || 0} dialogue line(s), event: ${aiReply.eventStatus || 'n/a'}${checkNote})`);

            if (aiReply.dialogue && Array.isArray(aiReply.dialogue)) {
                const boundCharacterNames = new Set(getAllBoundCharacterNames().map((n) => n.trim().toLowerCase()));
                const spokenThisTurn = [];
                // Only the FIRST actually-spoken segment gets timed below - that's the moment
                // this turn's audio actually starts, the last leg of the end-to-end breakdown
                // (RAG / LLM already timed above). Later segments in the same turn are pipelined
                // by voice_manager.js's TTS queue, not a fresh "reply received" event.
                let firstAudioTimed = false;
                for (const segment of aiReply.dialogue) {
                    if (!segment || !segment.text) continue;
                    const speaker = segment.speaker || 'narrator';

                    // Hard backstop: the DM narrates and voices NPCs, never a player character -
                    // players alone decide what their characters say and do (see prompt guideline
                    // 4). Local models don't always comply, so drop any segment attributed to a
                    // bound character's name entirely rather than speak/post it as if the player
                    // said it - persisting fabricated player speech into the transcript would also
                    // poison later turns' memory of what the player actually said.
                    if (boundCharacterNames.has(speaker.trim().toLowerCase())) {
                        console.warn(`-> Dropping DM dialogue segment: model tried to speak for player character "${speaker}".`);
                        continue;
                    }

                    if (!firstAudioTimed) {
                        firstAudioTimed = true;
                        speakText(segment.text, speaker, segment.voiceDescription, () => {
                            const ttsStartLatencyMs = Date.now() - aiReplyReceivedAt;
                            const totalMs = Date.now() - turnStart;
                            console.log(`-> Turn latency breakdown: RAG ${ragLatencyMs}ms | LLM ${latency}ms | reply-to-audio ${ttsStartLatencyMs}ms | total ${totalMs}ms`);
                            recordTurnLatency({
                                ragLatencyMs, llmLatencyMs: latency, ttsStartLatencyMs, totalMs,
                                model: activeModelName, transcriptPreview: transcript.slice(0, 80),
                                dialogueSegments: aiReply.dialogue.length
                            });
                        });
                    } else {
                        speakText(segment.text, speaker, segment.voiceDescription);
                    }
                    appendTranscript(segment.text, `Dungeon Master (${speaker})`, Date.now());
                    spokenThisTurn.push({ speaker, text: segment.text, voiceDescription: segment.voiceDescription });

                    const isNarrator = speaker.trim().toLowerCase() === 'narrator';
                    let speakingEntity = isNarrator ? null : getEntityByName(speaker);

                    // Backstop: guideline 9 asks the model to record every new NPC via
                    // "worldEntities", but it doesn't always comply - without this, an NPC who
                    // never got recorded that way could talk all campaign and never become
                    // eligible for an image (enqueueEntityImage below needs an entity record to
                    // build a prompt from). addWorldEntity() dedupes on name, so this is a no-op
                    // (returns null) for every later line once they're known either way.
                    if (!isNarrator && !speakingEntity) {
                        const fallbackDescription = segment.voiceDescription
                            ? `An NPC encountered during play. Voice: ${segment.voiceDescription}.`
                            : 'An NPC encountered during play - no further description recorded yet.';
                        speakingEntity = await addWorldEntity('npcs', speaker, fallbackDescription, false);
                    }

                    if (!isNarrator) {
                        const portrait = getEntityImage(speaker);
                        if (!portrait) {
                            // Light retry: this NPC has no image yet (rate limit, or this is
                            // their very first line before the image job even started) -
                            // re-check their world record and re-enqueue if one exists.
                            // enqueueEntityImage() re-checks getEntityImage()/queue membership
                            // itself, so repeated calls across many lines before the image
                            // completes are harmless.
                            if (speakingEntity) enqueueEntityImage(speakingEntity, speakingEntity.category || 'npcs');
                        }
                        // Fire-and-forget - posting text-only when no portrait exists yet is the
                        // expected, correct behavior, not a bug to fix. Caption includes the
                        // entity's description alongside the spoken line so the image is never
                        // posted without the context that generated it.
                        const caption = speakingEntity?.description ? `\n🎨 *${speakingEntity.description}*` : '';
                        postToActiveChannel({
                            content: `🗣️ **${speaker}:** ${segment.text}${caption}`,
                            files: portrait ? [{ attachment: path.join(TEMP_DATA_DIR, portrait.path), name: 'portrait.png' }] : []
                        });
                    } else {
                        // Guarantee every spoken line has a text equivalent in Discord - a narrator
                        // segment used to only get posted if it happened to mention an entity with
                        // an existing image (the "mentioned" loop below); plain narration with no
                        // mentions never appeared in text at all. Unconditional now; the mentioned-
                        // entity loop below still runs after this and may post the same text again
                        // alongside an illustration - a little duplication is an acceptable trade
                        // for every narrated line reliably having a Discord counterpart.
                        postToActiveChannel({ content: segment.text });
                    }

                    // Beyond the speaker themselves (handled above), post any OTHER already-known
                    // entity this line's text mentions by name - a narrator line describing a
                    // location, item, or NPC the party just encountered - so players see it the
                    // moment the DM brings it up, not only when that entity is the one speaking.
                    // Unlike the speaker case above, only post when an image already exists - a
                    // passing mention isn't reason enough to spam text-only posts while one
                    // generates, just enqueue it for next time.
                    const mentioned = findMentionedEntities(segment.text).filter((e) => e.id !== speakingEntity?.id);
                    for (const entity of mentioned) {
                        const portrait = getEntityImage(entity.name);
                        if (!portrait) {
                            enqueueEntityImage(entity, entity.category || 'npcs');
                            continue;
                        }
                        postToActiveChannel({
                            content: `${segment.text}${entity.description ? `\n🎨 *${entity.description}*` : ''}`,
                            files: [{ attachment: path.join(TEMP_DATA_DIR, portrait.path), name: 'portrait.png' }]
                        });
                    }
                }

                if (spokenThisTurn.length > 0) {
                    lastSpokenTurn = spokenThisTurn;
                }
            }

            const isImportantInsight = aiReply.suggestion && !aiReply.isOOC && aiReply.isImportant;
            if (isImportantInsight) {
                stats.importantInsights++;
                rememberAiInsight(aiReply, transcript);
            }

            if (aiReply.characterLogs && Array.isArray(aiReply.characterLogs) && aiReply.characterLogs.length > 0) {
                addCharacterLogs(aiReply.characterLogs);
            }

            if (aiReply.worldEntities && Array.isArray(aiReply.worldEntities) && aiReply.worldEntities.length > 0) {
                addWorldEntities(aiReply.worldEntities).catch(err => console.warn('-> Failed to save world entities:', err.message));
            }

            if (aiReply.characterStateChanges && Array.isArray(aiReply.characterStateChanges) && aiReply.characterStateChanges.length > 0) {
                announceStateChanges(applyStateChanges(aiReply.characterStateChanges));
            }

            if (aiReply.isGroupCheck && aiReply.checkSkill && aiReply.checkDc) {
                const group = openGroupCheck(aiReply.checkSkill, aiReply.checkDc);
                if (group) {
                    console.log(`-> Open group check registered: ${group.skill} DC ${group.dc}`);
                    announceOpenGroupCheckRequirement(group.skill, group.dc);
                    scheduleOpenGroupCheckTimeout();
                }
            } else if (aiReply.checkCharacter && aiReply.checkSkill && aiReply.checkDc) {
                const check = addPendingCheck(aiReply.checkCharacter, aiReply.checkSkill, aiReply.checkDc);
                if (check) {
                    console.log(`-> Pending check registered: ${check.character} - ${check.skill} DC ${check.dc}`);
                    announceCheckRequirement(check.character, check.skill, check.dc);
                }
            }

            if (currentEventData.activeEvent && aiReply.eventStatus) {
                const status = aiReply.eventStatus.toLowerCase();
                console.log(`-> Event Evaluation [${currentEventData.activeEvent.title}]: ${status.toUpperCase()}`);

                if (status === 'resolved') {
                    console.log(`-> Active Event Resolved: ${currentEventData.activeEvent.title}`);

                    // Snapshot before nulling activeEvent below - the image should reflect how
                    // this event ended, win or lose, not the event that (already null) replaces it.
                    const resolvedEventForImage = {
                        title: currentEventData.activeEvent.title,
                        description: currentEventData.activeEvent.description,
                        currentState: aiReply.resolutionSummary || currentEventData.activeEvent.currentState
                    };

                    currentEventData.archivedEvents.push({
                        title: currentEventData.activeEvent.title,
                        resolution: aiReply.resolutionSummary,
                        endedAt: new Date().toISOString()
                    });
                    currentEventData.activeEvent = null;
                    fs.writeFileSync(eventPath, JSON.stringify(currentEventData, null, 2), 'utf8');
                    announceEventStatusChange('resolved', resolvedEventForImage, aiReply.resolutionSummary);

                    generateNextEventWithRetry(
                        currentEventData.archivedEvents,
                        rollingSummary,
                        aiReply.resolutionSummary,
                        '',
                        buildEventTieInContext(getActiveBackgroundEvents(), relevantRecords)
                    ).then(newEventObj => {
                        if (epochAtStart !== getCampaignEpoch()) {
                            console.log('-> Discarding generated next-event: campaign was reset while it was in flight.');
                            return;
                        }
                        if (newEventObj && newEventObj.activeEvent) {
                            currentEventData.activeEvent = newEventObj.activeEvent;
                            fs.writeFileSync(eventPath, JSON.stringify(currentEventData, null, 2), 'utf8');
                            announceEventStatusChange('new', newEventObj.activeEvent, null);

                            if (newEventObj.linkedBackgroundEventId) {
                                resolveBackgroundEventAsSurfaced(
                                    newEventObj.linkedBackgroundEventId,
                                    `Surfaced as the new current event: ${newEventObj.activeEvent.title}`
                                );
                            }
                        } else {
                            // Both attempts failed - activeEvent is left null with nothing to
                            // resolve later either, so without a player-facing notice the table
                            // would just find things quietly go nowhere with no explanation.
                            console.error('-> Failed to generate a next event after retrying - active event left blank.');
                            const fallback = "The dust settles for now - give me a moment to figure out what happens next.";
                            speakText(fallback, 'narrator');
                            postToActiveChannel({ content: `⚠️ ${fallback}` });
                        }
                    });

                    enqueueEventImage(resolvedEventForImage);

                } else {
                    // "stable", "escalated", or "evolved" - the event is still active, but the scene's
                    // physical state may still have changed this turn (an item taken/destroyed, an NPC
                    // killed, etc). Persist that regardless of status so the next turn's prompt doesn't
                    // contradict something that already happened - previously this was only captured on
                    // escalate/evolve, so "stable" turns silently dropped state changes entirely.
                    if (aiReply.resolutionSummary) {
                        currentEventData.activeEvent.currentState = aiReply.resolutionSummary;
                    }

                    if (status === 'escalated' || status === 'evolved') {
                        // Deliberately NOT copying resolutionSummary into "complication" too (a
                        // prior version did) - currentState above already holds that exact text,
                        // and guideline 10 makes currentState the authoritative, most-recent read
                        // on the scene. Duplicating it into complication as well just produced two
                        // identically-worded fields in the prompt/dashboard with no new
                        // information in either - "complication" instead keeps showing the
                        // original pushback/obstacle framing from when the event was created.
                        console.log(`⚠️ Event Shifted (${status}): ${currentEventData.activeEvent.title} New Twist: ${aiReply.resolutionSummary || currentEventData.activeEvent.complication}`);
                        announceEventStatusChange(status, currentEventData.activeEvent, aiReply.resolutionSummary);
                    }

                    fs.writeFileSync(eventPath, JSON.stringify(currentEventData, null, 2), 'utf8');

                    // Regenerate the event image on any real change (evolved/escalated), reflecting
                    // the just-updated currentState - never on "stable" turns, per spec.
                    if (status === 'escalated' || status === 'evolved') {
                        enqueueEventImage(currentEventData.activeEvent);
                    }
                }
            }

            saveLlmDebug({
                timestamp: new Date().toISOString(),
                model: activeModelName,
                latencyMs: latency,
                transcript: transcript,
                contextString: contextString,
                rollingSummary: rollingSummary,
                fullPrompt: prompt,
                rawResponse: aiReply,
                stats: stats
            });
        } else {
            console.warn(`-> DM turn produced no reply after ${latency}ms (provider misconfigured or returned nothing usable).`);
            announceDmTurnFailure();
            saveLlmDebug({
                timestamp: new Date().toISOString(),
                model: activeModelName,
                latencyMs: 0,
                transcript: transcript,
                contextString: contextString,
                rollingSummary: rollingSummary,
                fullPrompt: prompt,
                rawResponse: {
                    isOOC: false,
                    isImportant: false,
                    suggestion: "Configure an API key in your .env file to enable live DM guidance.",
                    reason: "The AI provider returned null or failed to run successfully."
                },
                stats: stats
            });
        }

        return aiReply;
    } catch (error) {
        const latency = Date.now() - apiStartTime;
        console.warn('-> AI provider unavailable:', error.message);
        announceDmTurnFailure();
        saveLlmDebug({
            timestamp: new Date().toISOString(),
            model: "API Error",
            latencyMs: latency,
            transcript: transcript,
            contextString: contextString,
            rollingSummary: rollingSummary,
            fullPrompt: prompt,
            rawResponse: {
                isOOC: false,
                isImportant: false,
                suggestion: `Error: ${error.message}`,
                reason: "An exception occurred while connecting to the LLM endpoint."
            },
            stats: stats
        });
        return null;
    }
}

// The one and only player-idea-driven Session Zero flow. While active, every transcribed
// utterance comes here instead of runDmTurn() - buffered as raw world-building input, not
// reacted to as in-character speech. When a player signals they're done, this generates the
// actual campaign (intro lore + public/secret NPCs/locations/lore) from what was said, saves
// it, reads the introduction aloud, then hands off to the character-introduction phase below
// (beginSessionOne only runs once THAT finishes). Triggered by real voice input; started by
// /api/start_campaign (see web_editor.js), which only wipes old data and kicks off listening.
const SESSION_ZERO_FINISH_REGEX = /(we('re| are) (done|finished|good|set))|(that's (it|all))|(all done)|(generate (it|the world) now)|(let's start)/i;

async function handleSessionZeroInput(sourceLabel, transcript) {
    addSessionZeroInput(sourceLabel, transcript);

    if (!SESSION_ZERO_FINISH_REGEX.test(transcript)) return;

    const compiledIdeas = endSessionZero();
    console.log('-> Session Zero complete. Generating campaign from player ideas...');

    // Only non-empty when one or more players linked a D&D Beyond character before finishing
    // Session Zero (via the dashboard's Character Mapping panel) - lets the invented world tie
    // into their backstories from the very start, rather than only after character intros (see
    // beginSessionOne's findRelevantRecords-based tie-in for characters introduced by voice only).
    const ddbCharacters = loadDdbCharacters();
    const characterBackstories = Object.entries(ddbCharacters)
        .filter(([, entry]) => entry?.sheet?.backstory)
        .map(([name, entry]) => `${name}: ${entry.sheet.backstory}`)
        .join('\n\n');

    let seed = null;
    try {
        seed = await generateCampaignSeed(compiledIdeas, characterBackstories);
    } catch (err) {
        console.warn('-> Campaign seed generation failed:', err.message);
    }

    if (!seed) {
        const failureMsg = "Something went wrong generating the world. Please check the AI provider is configured and reachable, then start the campaign again.";
        speakText(failureMsg);
        postToActiveChannel({ content: failureMsg });
        return;
    }

    if (seed.introLore) {
        await callRagServer('/add', {
            collection: 'dnd_knowledge',
            documents: [seed.introLore],
            metadatas: [{ source: 'campaign_seed', category: 'lore', name: 'Campaign Introduction' }],
            ids: ['campaign_intro']
        }).catch(() => {});

        // Also kept as a plain file so the dashboard can display it without needing to
        // query the RAG server. narratorPersona rides along here too - runDmTurn() reads it
        // back out of this same file every turn so the DM's narrative voice stays consistent
        // for the whole campaign instead of drifting turn to turn. Capped to one sentence here
        // (capToFirstSentence) rather than trusting the model's own "one short sentence"
        // instruction to always hold - see the function's comment above.
        try {
            fs.writeFileSync(
                path.join(TEMP_DATA_DIR, 'campaign_intro.json'),
                JSON.stringify({ text: seed.introLore, narratorPersona: capToFirstSentence(seed.narratorPersona), generatedAt: new Date().toISOString() }, null, 2),
                'utf8'
            );
        } catch (e) {
            console.warn('-> Failed to save campaign_intro.json:', e.message);
        }
    }

    if (Array.isArray(seed.worldEntities)) {
        await addWorldEntities(seed.worldEntities);
    }

    if (seed.introLore) {
        console.log('-> Speaking campaign introduction...');
        speakText(seed.introLore, 'narrator');
        appendTranscript(seed.introLore, 'Dungeon Master (narrator)', Date.now());
        postToActiveChannel({ content: seed.introLore });
    }

    pendingCampaignIntroLore = seed.introLore || null;
    startCharacterIntros();
}

// Runs once, after Session Zero's campaign intro is read aloud and before Session 1's opening
// event: each player states their name, character, a brief description, and what that character
// is doing as the scene opens. handleSessionZeroInput() kicks this phase off (via
// startCharacterIntros()) instead of going straight to the opening event; every transcribed
// utterance is routed here instead of runDmTurn() while it's active (see the messageCreate
// handler below), the same way Session Zero itself works.
async function handleCharacterIntroInput(sourceLabel, transcript) {
    addCharacterIntroInput(sourceLabel, transcript);

    if (!SESSION_ZERO_FINISH_REGEX.test(transcript)) return;

    await beginSessionOne(endCharacterIntros());
}

// Parses the compiled character introductions, binds each Discord user to their character
// (character_manager.js bindCharacter - the same map the messageCreate handler reads via
// getBoundCharacterName() to resolve a speaker's name before it ever reaches the LLM), logs
// each character's opening description
// so it's remembered, then generates and announces Session 1's opening event with those
// introductions as extra context so it can acknowledge where each character actually is.
async function beginSessionOne(compiledIntros) {
    console.log('-> Character introductions complete. Parsing characters...');

    let introResult = null;
    try {
        introResult = await parseCharacterIntroductions(compiledIntros);
    } catch (err) {
        console.warn('-> Character introduction parsing failed:', err.message);
    }

    const ddbCharacters = loadDdbCharacters();
    let openingContext = '';
    if (introResult && Array.isArray(introResult.characters)) {
        for (const entry of introResult.characters) {
            const discordUser = String(entry?.discordUser || '').trim();
            let characterName = String(entry?.characterName || '').trim();
            if (!discordUser) continue;

            // A player already linked via D&D Beyond is bound before this phase even starts (see
            // the /api/ddb_link dashboard route) - trust that existing binding over whatever name
            // the LLM parsed from voice (which may be misspelled or absent if they only stated
            // their opening action), and use their imported backstory instead of a possibly
            // hallucinated description. All we actually still need from them here is what their
            // character is doing as the scene opens.
            const alreadyBoundName = getBoundCharacterName(discordUser);
            const linkedSheet = alreadyBoundName ? ddbCharacters[alreadyBoundName]?.sheet : null;

            let description = String(entry?.description || '').trim();
            const openingAction = String(entry?.openingAction || '').trim();

            if (linkedSheet) {
                characterName = alreadyBoundName;
                description = linkedSheet.backstory || `${linkedSheet.race} ${linkedSheet.classes.map((c) => `${c.name} ${c.level}`).join('/')}.`;
            } else {
                if (!characterName) continue;
                bindCharacter(discordUser, characterName);
            }

            const logText = [description, openingAction ? `As the scene opens: ${openingAction}` : ''].filter(Boolean).join(' ');
            if (logText) {
                addCharacterLogs([{ character: characterName, log: logText, type: 'development' }]);
            }

            openingContext += `${characterName} (played by ${discordUser}): ${description}${openingAction ? ` As the scene opens, ${openingAction}` : ''}\n`;
        }
    }

    if (!openingContext) {
        console.warn('-> No character introductions were parsed - proceeding to the opening event without them.');
        const fallback = "I didn't quite catch everyone's introductions there - I'll pick up who's who as we go, so introduce yourselves again in character whenever you get the chance.";
        speakText(fallback, 'narrator');
        postToActiveChannel({ content: fallback });
    }

    try {
        // Previously passed [] here, meaning the opening event could never tie into anything
        // established - including a linked character's D&D Beyond backstory or campaign-seed
        // lore, even though openingContext (built above) often names exactly that. Querying RAG
        // with it surfaces whatever's semantically relevant, the same way every later turn's
        // tie-in context works off a real transcript.
        const openingRecords = await findRelevantRecords(openingContext);
        const eventObj = await generateNextEventWithRetry(
            [],
            pendingCampaignIntroLore || 'A new campaign has just begun.',
            'The players have just finished Session Zero and introduced their characters, and are ready to begin their first scene.',
            openingContext ? `Player Characters and Their Opening Positions:\n${openingContext}` : '',
            buildEventTieInContext(getActiveBackgroundEvents(), openingRecords)
        );

        if (eventObj && eventObj.activeEvent) {
            const eventPath = path.join(TEMP_DATA_DIR, 'current_event.json');
            fs.writeFileSync(eventPath, JSON.stringify({ activeEvent: eventObj.activeEvent, archivedEvents: [] }, null, 2), 'utf8');

            // The opening scene never got an image before - every OTHER event-image trigger
            // (escalated/evolved/resolved) lives in runDmTurn()'s event-status handling, but the
            // very first event (created here, not there) never passed through that code.
            enqueueEventImage(eventObj.activeEvent);

            if (eventObj.linkedBackgroundEventId) {
                resolveBackgroundEventAsSurfaced(
                    eventObj.linkedBackgroundEventId,
                    `Surfaced as the opening event: ${eventObj.activeEvent.title}`
                );
            }

            const announcement = `Session One begins. ${eventObj.activeEvent.description}`;
            console.log('-> Announcing opening event:', eventObj.activeEvent.title);
            speakText(announcement, 'narrator');
            appendTranscript(announcement, 'Dungeon Master (narrator)', Date.now());
            postToActiveChannel({ content: announcement });
        } else {
            // Both attempts failed - without this, Session One would silently begin with no
            // active event and no explanation, and (since nothing is ever active to resolve) no
            // automatic path to ever generate one later either.
            console.error('-> Failed to generate an opening event after retrying.');
            const fallback = "Session One begins - I'm still picturing the opening scene, so let's dive in and I'll set the stage as we go.";
            speakText(fallback, 'narrator');
            appendTranscript(fallback, 'Dungeon Master (narrator)', Date.now());
            postToActiveChannel({ content: fallback });
        }
    } catch (err) {
        console.warn('-> Failed to generate opening event:', err.message);
    }

    pendingCampaignIntroLore = null;
}

function handleSilenceDriver() {
    // Reschedule unconditionally, before any early return below - otherwise a fire that lands
    // while Session Zero/character intros are active (or while there's nothing yet to repeat)
    // never requeues itself, permanently killing the repeat-on-silence chain for the rest of the
    // session until some unrelated speech event happens to re-arm a fresh timer.
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(handleSilenceDriver, SILENCE_TIMEOUT_MS);

    if (isSessionZeroActive() || isCharacterIntroActive()) return;

    console.log(`-> Sustained silence detected.${lastSpokenTurn.length > 0 ? ' Repeating the last thing the DM said.' : ' Nothing spoken yet this campaign - nothing to repeat.'}`);
    for (const segment of lastSpokenTurn) {
        speakText(segment.text, segment.speaker, segment.voiceDescription);
    }
}

// Attributing a Dice Maiden roll to a player: prefer Discord's own interaction metadata
// (the invoking user, when Dice Maiden replied to a real slash-command interaction) since
// it's unambiguous; fall back to the display name Dice Maiden prints in the message itself,
// resolved through the nickname map recorded during voice transcription.
// Shared by solo checks and voluntary open-group-check rolls: computes the effective total,
// preferring the character's D&D Beyond sheet modifier over whatever the player typed into their
// roll (see the comment at the solo-check call site for why), and the resulting success/failure
// including the natural-20/1 override.
function evaluateRoll(roll, character, skill, dc) {
    const linkedSheet = loadDdbCharacters()[character]?.sheet;
    const correctedModifier = (linkedSheet && typeof roll.natural === 'number')
        ? computeSkillModifier(linkedSheet, skill)
        : null;
    const usingCorrectedTotal = correctedModifier !== null;
    const effectiveTotal = usingCorrectedTotal ? roll.natural + correctedModifier : roll.total;

    let success = effectiveTotal >= dc;
    let outcomeLabel = success ? 'SUCCESS' : 'FAILURE';
    if (roll.isCriticalSuccess) {
        success = true;
        outcomeLabel = 'CRITICAL SUCCESS (NATURAL 20)';
    } else if (roll.isCriticalFailure) {
        success = false;
        outcomeLabel = 'CRITICAL FAILURE (NATURAL 1)';
    }

    return { effectiveTotal, success, outcomeLabel, usingCorrectedTotal, correctedModifier };
}

async function handleDiceMaidenRoll(message) {
    if (isDiceMaidenError(message.content)) {
        console.log('-> Dice Maiden rejected an invalid roll expression, ignoring:', message.content);
        return;
    }

    const roll = parseDiceMaidenRoll(message.content);
    if (!roll) {
        console.warn('-> Could not parse Dice Maiden message:', message.content);
        return;
    }

    const interactionUser = message.interactionMetadata?.user || message.interaction?.user;
    let username = interactionUser ? (interactionUser.username || interactionUser.tag) : null;
    if (!username && roll.rollerDisplayName) {
        username = resolveUsernameByNickname(roll.rollerDisplayName);
    }

    if (!username) {
        console.warn(`-> Dice roll could not be attributed to a player: "${message.content}"`);
        return;
    }

    const character = getBoundCharacterName(username);
    if (!character) {
        console.log(`-> Dice roll from ${username} (${roll.notation || 'dice'}: ${roll.total}) - no bound character, skipping.`);
        return;
    }

    // Prefer recomputing from the character's actual D&D Beyond sheet over trusting whatever
    // modifier the player typed into their roll (e.g. "/roll 1d20+100") - Dice Maiden's own total
    // has no way to know if that modifier is correct or was left over from a different check, so
    // trusting it verbatim lets a mistyped or inflated modifier silently decide the outcome. Only
    // possible when the natural d20 result is known (dice_maiden.js only extracts this for a
    // plain single-d20 roll, not multi-die/advantage notations) AND the character has a linked
    // sheet with a resolvable modifier for the requested skill/ability - otherwise this falls
    // back to trusting roll.total exactly as before. See evaluateRoll() above.
    const pending = resolvePendingCheck(character);
    if (pending) {
        const { effectiveTotal, success, outcomeLabel, usingCorrectedTotal, correctedModifier } = evaluateRoll(roll, character, pending.skill, pending.dc);
        const resultLine = usingCorrectedTotal
            ? `${character} rolled a natural ${roll.natural} for ${pending.skill} - applying their sheet modifier (${correctedModifier >= 0 ? '+' : ''}${correctedModifier}) instead of the roll's own: ${effectiveTotal} vs DC ${pending.dc} - ${outcomeLabel}`
            : `${character} rolled ${roll.total} for ${pending.skill} (DC ${pending.dc}): ${outcomeLabel}`;
        console.log(`-> ${resultLine}`);
        appendTranscript(resultLine, 'Dice', Date.now());

        enqueueDmTurn(`[Dice Roll Result] ${resultLine}`);
        return;
    }

    // No solo check pending for this character - are they voluntarily answering an open group
    // check (ai_provider.js guideline 5b)? Unlike a solo check, nobody specific is required to
    // roll for one of these: record this roll into the shared scoreboard and let it sit there -
    // the DM only reacts once the response window closes (scheduleOpenGroupCheckTimeout in
    // resolveOpenGroupCheck), not per individual roll, since a later roll can still flip an
    // all-failures-so-far result to an overall success.
    const openCheck = getOpenGroupCheck();
    if (!openCheck) {
        appendTranscript(`${character} rolled ${roll.notation || 'dice'}: ${roll.total} (no pending check)`, 'Dice', Date.now());
        return;
    }

    const { effectiveTotal, success, outcomeLabel, usingCorrectedTotal, correctedModifier } = evaluateRoll(roll, character, openCheck.skill, openCheck.dc);
    const resultLine = usingCorrectedTotal
        ? `${character} rolled a natural ${roll.natural} for the team ${openCheck.skill} check - applying their sheet modifier (${correctedModifier >= 0 ? '+' : ''}${correctedModifier}) instead of the roll's own: ${effectiveTotal} vs DC ${openCheck.dc} - ${outcomeLabel}`
        : `${character} rolled ${roll.total} for the team ${openCheck.skill} check (DC ${openCheck.dc}): ${outcomeLabel}`;
    console.log(`-> ${resultLine} [open group check]`);
    appendTranscript(resultLine, 'Dice', Date.now());

    recordOpenGroupCheckRoll(character, { total: effectiveTotal, success, outcomeLabel });
}

client.once('clientReady', () => {
    console.log(`-> DaDAA is ready and logged in as ${client.user.tag}`);
    startWebEditor();
    
    const activeModel = config.OllamaConfig?.enabled 
        ? config.OllamaConfig?.model || 'neural-chat' 
        : config.LLM;
    const ollamaEnabled = config.OllamaConfig?.enabled || false;
    const hasKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

    if (ollamaEnabled) {
        console.log(`-> LLM Provider: Ollama (${config.OllamaConfig?.model || 'neural-chat'}) at ${config.OllamaConfig?.baseUrl || 'http://localhost:11434'}`);
    } else {
        const availableProviders = [];
        if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) availableProviders.push('Gemini');
        if (process.env.ANTHROPIC_API_KEY) availableProviders.push('Anthropic');
        if (process.env.OPENAI_API_KEY) availableProviders.push('OpenAI');
    
        if (availableProviders.length > 0) {
            console.log(`-> LLM Provider: Cloud (${availableProviders.join(' > ')})`);
        } else {
            console.warn(`-> WARNING: No LLM provider configured! Ollama is disabled and no cloud API keys found.`);
            console.warn(`-> The bot will run but AI responses will be disabled.`);
        }
    }

    const anyProviderAvailable = ollamaEnabled || hasKey;

    saveLlmDebug({
        timestamp: new Date().toISOString(),
        model: activeModel,
        latencyMs: 0,
        transcript: 'Awaiting first speech segment...',
        contextString: 'None',
        rollingSummary: 'None',
        fullPrompt: 'No transcripts evaluated yet.',
        rawResponse: { 
            reason: anyProviderAvailable
                ? 'Awaiting speech trigger...' 
                : 'ERROR: No LLM provider configured. Enable Ollama or add cloud API keys to activate AI responses.'
        },
        stats: stats,
        providerAvailable: anyProviderAvailable
    });

    initializeWorldContext()
        .then((context) => {
            worldContext = context;
            console.log(`-> Local World Context and RAG Engine initialized successfully.`);
        })
        .catch((error) => {
            console.error('-> Failed to load world context:', error);
        });

    // Best-effort, never blocks startup - re-pulls each linked character's baseline sheet fields
    // only (level/HP/AC/abilities/proficiencies/inventory-as-imported/backstory), never touching
    // character_state.json's live HP/conditions/inventory. See ddb_import.js for details.
    refreshAllLinkedCharacters().catch((error) => {
        console.warn('-> Failed to refresh D&D Beyond-linked characters:', error.message);
    });

    // Best-effort, never blocks startup - synthesizes every fixed line that's ever spoken
    // verbatim so the first real use during play hits a warm cache instead of paying Kokoro's
    // synthesis latency in the moment. See voice_manager.js pregenerateStaticAudio().
    pregenerateStaticAudio([...THINKING_FILLERS, SESSION_ZERO_PROMPT, CHARACTER_INTRO_PROMPT]).catch((error) => {
        console.warn('-> Failed to pre-generate static TTS audio:', error.message);
    });
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) {
        if (isDiceMaidenMessage(message)) {
            await handleDiceMaidenRoll(message);
        }
        return;
    }

    if (message.content === '!join') {
        const voiceChannel = message.member?.voice?.channel;
        if (voiceChannel) {
            // No Discord interaction ever triggers a portrait/event-image completion (it happens
            // on a background timer, long after any incoming message) - image_gen_manager.js
            // needs a persisted TextChannel reference to post into later, so capture it here the
            // same way currentVoiceConnection is captured for voice.
            setActiveTextChannel(message.channel);
            joinAndListen(client, message.guild.id, voiceChannel.id, async (userId, transcript, startTime, endTime) => {
                let sourceLabel = userId;
                let discordName = userId;

                try {
                    const member = await message.guild.members.fetch(userId).catch(() => null);
                    const userObj = member?.user || await client.users.fetch(userId);
                    if (userObj && (userObj.username || userObj.tag)) {
                        discordName = userObj.username || userObj.tag;

                        const charName = getBoundCharacterName(discordName);
                        sourceLabel = charName ? charName : discordName;

                        // Dice Maiden replies use the server nickname, not the account
                        // username - capture the mapping here so roll matching can resolve it later.
                        const nickname = member?.nickname || member?.displayName;
                        if (nickname) recordDiscordNickname(nickname, discordName);
                    }
                } catch (e) { /* fallback to id */ }

                // Pure STT turnaround (speech-end -> transcript-received) - kept separate from
                // any debounce/queueing delay applied below, since that's deliberate coalescing,
                // not transcription cost. See CLAUDE.md Phase 6 / voice_manager.js utteranceEndTimes.
                const sttLatencyMs = endTime ? Date.now() - endTime : null;
                console.log(`\n[Audio Transcribed] ${sourceLabel} (${discordName}) in ${sttLatencyMs}ms: "${transcript}"`);
                if (sttLatencyMs !== null) {
                    recordUtteranceLatency({ sttLatencyMs, source: sourceLabel, transcriptPreview: transcript.slice(0, 80) });
                }

                recordDiscordUser(discordName);
                appendTranscript(transcript, sourceLabel, Date.now());
                
                stats.totalUtterances++;
                
                transcriptCounter++;
                if (transcriptCounter >= 10) {
                    transcriptCounter = 0;
                    const log = readTranscriptLog();
                    const logLines = log.split('\n').filter(Boolean).slice(-15);
                    if (logLines.length > 0) {
                        updateRollingSummary(logLines).catch(err => console.warn('-> Rolling summary error:', err.message));
                    }
                }

                backgroundEventCounter++;
                if (backgroundEventCounter >= (config.BackgroundEventConfig?.utteranceInterval ?? 25)) {
                    backgroundEventCounter = 0;
                    updateCampaignBackgroundEvents().catch(err => console.warn('-> Background events error:', err.message));
                }

                lastSpeechTimestamp = Date.now();
                if (silenceTimer) {
                    clearTimeout(silenceTimer);
                    silenceTimer = null;
                }
                if (activeSpeakers.size === 0) {
                    silenceTimer = setTimeout(handleSilenceDriver, SILENCE_TIMEOUT_MS);
                }

                if (isSessionZeroActive()) {
                    handleSessionZeroInput(sourceLabel, transcript);
                } else if (isCharacterIntroActive()) {
                    // Deliberately the raw Discord username, not sourceLabel - a player linked via
                    // D&D Beyond is already bound to a character by this point (see /api/ddb_link),
                    // so sourceLabel would already be their character name here, not their Discord
                    // username. parseCharacterIntroductions() tags each line by Discord username
                    // and beginSessionOne() looks up the binding itself, so this must stay the
                    // username regardless of any pre-existing binding.
                    handleCharacterIntroInput(discordName, transcript);
                } else if (worldContext) {
                    queueDmTranscript(sourceLabel, transcript);
                }
            });
            message.reply('Listening to the channel!');
            
            lastSpeechTimestamp = Date.now();
            if (silenceTimer) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(handleSilenceDriver, SILENCE_TIMEOUT_MS);
            
        } else {
            message.reply('You need to be in a voice channel first!');
        }
        return;
    }

    if (message.content === '!leave') {
        const connection = getVoiceConnection(message.guild.id);
        if (connection) {
            connection.destroy();
            message.reply('Disconnected from voice channel.');
            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
        } else {
            message.reply('I am not in a voice channel.');
        }
        return;
    }

});

client.on('dndSpeechStart', (userId) => {
    activeSpeakers.add(userId);
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
});

client.on('dndSpeechEnd', (userId) => {
    activeSpeakers.delete(userId);
    if (activeSpeakers.size === 0) {
        lastSpeechTimestamp = Date.now();
        if (silenceTimer) {
            clearTimeout(silenceTimer);
        }
        silenceTimer = setTimeout(handleSilenceDriver, SILENCE_TIMEOUT_MS);
    }
});

client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
    console.error('-> Login failed:', err);
});