// src/ai/ai_provider.js
const https = require('https');
const http = require('http');
const config = require('../../config.json');

function buildPrompt(transcript, context, rollingSummary = '', currentEventString = '', playerLogsString = '', narratorPersona = '', characterStateString = '') {
    return `You are the sole Dungeon Master (DM), with absolute authority over the world, rules, and lore, deciding all NPC actions and environmental outcomes. YOU DO NOT CONTROL PLAYER ACTIONS: only players decide what their characters say, think, feel, or do. Never put words in a player character's mouth or narrate an action they did not say they took (see guideline 5).
${narratorPersona ? `\nNarrator Persona & Tone for this campaign (stay in this voice every turn, see guideline 14): ${narratorPersona}\n` : ''}
STRICT OUTPUT FORMAT - respond ONLY with a valid JSON object:
{
    "dialogue": [ { "speaker": "narrator", "voiceDescription": null, "text": "Spoken aloud this turn - narration, hints, or a check request go here, never hidden in 'suggestion'." } ],
    "suggestion": "Internal reasoning or ruling (not read aloud).",
    "reason": "Why this is important.",
    "eventStatus": "stable | resolved | escalated | evolved",
    "isImportant": true/false,
    "isOOC": true/false,
    "resolutionSummary": "Concrete scene change this turn, any eventStatus - blank if nothing changed (guideline 11).",
    "characterLogs": [ { "character": "Exact character name", "log": "Specific, never empty", "type": "plot | trauma | npc | development" } ],
    "worldEntities": [ { "type": "npcs | locations | items | quests | lore | encounters", "name": "Proper name just invented", "description": "Reference fact for future-you to stay consistent (guideline 10)", "secret": true/false } ],
    "checkCharacter": "Exact character name rolling solo, or null if group check/no roll.",
    "isGroupCheck": true/false,
    "checkSkill": "Skill/ability tested, or null.",
    "checkDc": "DC as an integer (5-30), or null.",
    "characterStateChanges": [ { "character": "Exact character name", "hpDelta": -6, "newConditions": ["poisoned"], "removedConditions": [], "inventoryAdd": [ { "name": "Healing Potion", "quantity": 1 } ], "inventoryRemove": [] } ]
}

GUIDELINES:
1. Lore Deep-Dive: Prioritize mentioning major figures (Gods, NPCs, legendary items) found in the World Context.
2. Narrative Hooks: A major lore entity mentioned gets a specific atmospheric reaction or consequence.
3. isOOC: true for purely real-world discussion, rule disputes, jokes, side talk, or mechanical banter that doesn't progress the scene.
4. isImportant: true ONLY when:
   - A skill check is needed.
   - Players interact with major local lore objects, gods, relics, active scenes, or active NPCs.
   - A tactical opportunity, threat, combat trigger, or puzzle solution arises.
   - A player makes a critical choice with immediate consequences.
   - A player attempts an impossible/game-breaking action needing firm denial.
   - The transcript says "(Players are silent and awaiting the Dungeon Master's lead)" - you MUST progress the scene.
   Otherwise false.
5. Dialogue & Voices: "dialogue" is one or more ordered { "speaker", "voiceDescription", "text" } segments read aloud in sequence - split narration and NPC speech into separate segments (e.g. narrator sets the scene, NPC speaks, narrator closes) rather than quoting an NPC line inside narration.
   - "speaker": "narrator", or the exact name of the NPC/creature speaking in character. NEVER the name of a player character (see Character Status/Player Logs below for who's currently played) - only the human player speaks or acts for them. Do not write their dialogue, have them ask/agree/refuse/choose on the player's behalf, or narrate them performing an action they weren't just told (in the Live Transcript) to perform. React to what they said or did; never author it.
   - "voiceDescription": short (3-8 words) - gender, age, tone/texture (e.g. "gruff old male dwarf, deep and gravelly"). Required only the first time a speaker's name ever appears in "dialogue" this campaign; their voice is then locked in and reused automatically, so don't redescribe later. Always null for "narrator".
   - "text": what is actually said or narrated, in order.
6. Requesting a Roll: fill "checkSkill" and "checkDc", plus either "checkCharacter" (one character rolling alone) or "isGroupCheck": true (see 6b), so the request can be tracked against dice rolls. Leave "checkCharacter" null, "isGroupCheck" false, and "checkSkill"/"checkDc" null if no roll is requested this turn. Only one roll can be pending per character - a new request for the same character replaces the earlier one.
6b. Group Checks: when anyone present may react rather than one named roller ("everyone make a Perception check"), set "isGroupCheck" true and leave "checkCharacter" null, still filling one shared "checkSkill"/"checkDc". Any number of bound characters - all, some, or none - may roll within the response window; you'll be told the combined outcome on a later turn once it closes, so narrate it then as one collective consequence, not per person. Result is SUCCESS if at least one roller succeeded, FAILURE if everyone failed or nobody rolled - this is computed for you.
7. Reacting to Roll Results: a Live Transcript starting "[Dice Roll Result]" is the resolved outcome of a check you previously requested, not table talk. Set "isImportant" true and "isOOC" false, and "dialogue" MUST narrate a concrete, specific consequence of that exact result, never a vague acknowledgement. FAILURE: something real and negative happens now - a setback, harm, or a firm "no" with a cost. SUCCESS: describe the concrete benefit or information gained. CRITICAL SUCCESS: an exceptional, unexpectedly favorable outcome beyond normal success. CRITICAL FAILURE: something goes wrong bigger or more dramatic than the check alone would warrant. Don't request a new check in the same reply unless the fiction clearly demands one.
8. Brevity: the combined "text" across all "dialogue" segments totals 1-3 sentences. Be specific, not a lecture.
9. Character Logs: log major developments, traumas, notable NPC encounters, or plot events per character in "characterLogs" - "character" (exact character name, as seen in the Live Transcript/Player Logs/Character Status), "log" (specific, why it matters), "type" (plot | trauma | npc | development). Leave [] if nothing worth remembering occurred.
10. Inventing the World: nothing is pre-written beyond Session Zero and prior play - invent as players explore. Record any significant NEW named NPC/location/item/quest/lore in "worldEntities" the first time it appears; check World Context/Records first and don't re-record what already exists. Write "description" as the reference fact for future consistency (appearance, motives, secrets, relationships), not a narration of this moment. "secret": true for anything players haven't learned yet, else false. Leave [] if nothing new. A Record marked "[SECRET]" below is for your consistency only - inform NPC behavior/foreshadowing with it, but never state it to players directly; let it surface only through earned play.
11. Current Event Tracking: judge the immediate obstacle by what players actually attempted. A diplomatic, creative, or non-combat approach (negotiating, bribing, bluffing, sneaking) is legitimate, not a failure - react to its specific content through the NPC's actual response (accept, refuse, counter-offer, stall), never a generic "things get worse". Return "eventStatus":
   - "resolved": threat/problem neutralized, including by negotiation or agreement.
   - "escalated": players ignored the obstacle entirely, their action genuinely backfired, or an already-warned consequence actually followed through. Do NOT pick this just because an attempt hasn't fully succeeded yet - an offer still being weighed or a bluff not yet called is "stable" or "evolved", never "escalated" by default.
   - "evolved": players altered the situation creatively; parameters changed (new terms on the table, the obstacle shifted shape).
   - "stable": continues as-is, including an offer awaiting response.
   Whichever you pick, any concrete scene change this turn (item taken/destroyed, NPC died/fled, door opened, party moved on) MUST go in "resolutionSummary" regardless of eventStatus - this is what keeps remembered state accurate instead of reverting next turn.
12. Consistency: the "Current Event" block's "Current State" line, if present, always overrides "Description" on conflict (e.g. an item it says was destroyed/taken is gone even if Description still shows it). Never re-introduce or contradict something already narrated as changed.
13. Enforcing Boundaries: deny physically impossible or immersion-breaking actions, explaining the refusal in "dialogue" or offering a "No, but..." alternative.
14. Persona, Tone & Pacing: if a Narrator Persona & Tone is given above, narrate consistently in that voice every turn rather than drifting into a generic tone. Vary pacing - let quiet or character-driven moments breathe when nothing urgent is happening, and save intense prose for genuine turning points.
15. Mechanical State: stay consistent with Character Status below (below-half HP is winded/hurting; 0 HP is unconscious/dying, not dead; never give a character an item Inventory doesn't list). Record any HP/condition/inventory change this turn in "characterStateChanges"; leave [] if nothing changed. No death-save mini-game - 0 HP is simply the "unconscious"/"dying" condition.

Current Event:
${currentEventString || 'No active event.'}

Short-Term Session Memory:
${rollingSummary || 'No major events have occurred yet in this session.'}

Player Logs:
${playerLogsString || 'No player actions logged.'}

Character Status:
${characterStateString || 'No characters with tracked mechanical state yet.'}

World Context:
${context}

Live Transcript:
"${transcript}"`;
}

async function callModel(prompt) {
    let botResponse;
    
    if (config.OllamaConfig?.enabled) {
        try {
            botResponse = await callOllama(prompt);
            return normaliseJson(botResponse);
        } catch (error) {
            console.warn('-> Ollama call failed, falling back to cloud providers:', error.message);
            botResponse = await fallbackToCloudProviders(prompt);
            return normaliseJson(botResponse);
        }
    } 
    
    botResponse = await fallbackToCloudProviders(prompt);
    return normaliseJson(botResponse);
}

// Shared by every "which cloud provider should handle this call" decision (main DM turn,
// event generation, campaign seed generation) - previously duplicated near-verbatim in each.
function selectCloudProvider() {
    const keys = {
        gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
        anthropic: process.env.ANTHROPIC_API_KEY,
        openai: process.env.OPENAI_API_KEY
    };

    const modelName = String(config.LLM || '').toLowerCase();
    let provider = null;
    let apiKey = null;

    if ((modelName.includes('gemini') || !modelName || modelName.includes('flash')) && keys.gemini) {
        provider = 'gemini';
        apiKey = keys.gemini;
    } else if (modelName.includes('claude') && keys.anthropic) {
        provider = 'anthropic';
        apiKey = keys.anthropic;
    } else if ((modelName.includes('gpt') || modelName.includes('o1')) && keys.openai) {
        provider = 'openai';
        apiKey = keys.openai;
    }

    if (!provider || !apiKey) {
        if (keys.gemini) {
            provider = 'gemini';
            apiKey = keys.gemini;
        } else if (keys.anthropic) {
            provider = 'anthropic';
            apiKey = keys.anthropic;
        } else if (keys.openai) {
            provider = 'openai';
            apiKey = keys.openai;
        }
    }

    return provider && apiKey ? { provider, apiKey } : null;
}

function callCloudProvider(provider, apiKey, prompt) {
    if (provider === 'gemini') return callGemini(apiKey, prompt);
    if (provider === 'anthropic') return callAnthropic(apiKey, prompt);
    return callOpenAI(apiKey, prompt);
}

function fallbackToCloudProviders(prompt) {
    const selected = selectCloudProvider();
    if (!selected) {
        console.warn('-> AI Provider: No valid cloud API keys found in .env (tried Gemini -> Anthropic -> OpenAI)');
        return Promise.resolve(null);
    }

    console.log(`-> Using ${selected.provider} as LLM provider`);

    return callCloudProvider(selected.provider, selected.apiKey, prompt).then(text => {
        try { return JSON.parse(text); } catch(e) { return { suggestion: text, isImportant: true, eventStatus: "stable" }; }
    });
}

function callOllama(prompt) {
    const baseUrl = config.OllamaConfig?.baseUrl || 'http://localhost:11434';
    const model = config.OllamaConfig?.model || 'neural-chat';

    const body = JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false,
        format: "json",
        think: false, // Qwen3.x and other reasoning models otherwise route the whole JSON reply into "thinking" and leave "response" empty
        // Ollama's own default idle timeout (5 minutes) unloads the model from memory with no
        // request needed - a gap longer than that (very plausible: normal table pauses, or the
        // silence-driver repeating itself every SilenceDriverConfig.timeoutMs) would otherwise
        // force the NEXT turn to pay a full reload-from-disk cost on top of normal inference
        // time. -1 keeps it resident until Ollama itself restarts - this deployment runs one
        // model dedicated to this bot on a box with RAM to spare (see numCtx below), so there's
        // no other process it needs to make room for.
        keep_alive: -1,
        options: {
            // Ollama defaults num_ctx to 2048 regardless of the model's actual supported context -
            // our own prompt (schema + guidelines) alone is already ~2.5k tokens, so without this
            // every request was silently overflowing and getting truncated before the model ever
            // saw the world context, history, or transcript. Configurable since the right value
            // trades off against available RAM/VRAM.
            // Benchmarked on this hardware (RTX 2060 6GB) against a padded ~5.2k-token prompt (every
            // prompt section is capped in code - 8 RAG records, last 15 player logs, a 2000-char
            // rolling summary - so this is close to the real ceiling, not just today's ~3.9k-token
            // measurement): 16384 measured only ~5% slower token generation than 8192, comfortably
            // ahead of 32768's ~19% slowdown, while leaving 2x the real worst-case prompt size in
            // headroom for future growth - hence config.json's default of 16384, down from a prior
            // 32768 chosen without a benchmark. Re-run the comparison if prompts grow substantially
            // (more world records, longer rolling summary) before assuming 16384 still fits.
            num_ctx: config.OllamaConfig?.numCtx || 8192
        }
    });

    return requestOllama(baseUrl, body).then(text => {
        try { 
            return text;
        }
        catch(e) { 
            return text; 
        }
    });
}

function callGemini(apiKey, prompt) {
    const model = String(config.LLM || 'gemini-1.5-flash')
        .replace(/[\u2013\u2014]/g, '-')
        .trim();

    const body = JSON.stringify({
        contents: [{
            parts: [{
                text: prompt
            }]
        }],
        generationConfig: {
            temperature: 0.7,
            responseMimeType: 'application/json'
        }
    });

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    return requestJson(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        }
    }, body).then((data) => {
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (!text) {
            throw new Error("No contents returned from Gemini completion.");
        }
        return text;
    });
}

function callOpenAI(apiKey, prompt) {
    const model = config.LLM || process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const body = JSON.stringify({
        model: model,
        messages: [{ role: 'system', content: 'You are a helpful DM assistant.' }, { role: 'user', content: prompt }],
        temperature: 0.7,
        response_format: { type: "json_object" }
    });

    return requestJson('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
    }, body).then((data) => {
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) {
            throw new Error("No choices returned from OpenAI completion.");
        }
        return text;
    });
}

function callAnthropic(apiKey, prompt) {
    const model = config.LLM || process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest';
    const body = JSON.stringify({
        model: model,
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
    });

    return requestJson('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
    }, body).then((data) => {
        const text = data?.content?.[0]?.text?.trim();
        if (!text) {
            throw new Error("No text content returned from Anthropic message.");
        }
        return text;
    });
}

function requestOllama(baseUrl, body) {
    return new Promise((resolve, reject) => {
        const url = new URL(`${baseUrl}/api/generate`);
        const isHttps = url.protocol === 'https:';
        const protocol = isHttps ? https : http;

        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = protocol.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`Ollama API Error (HTTP ${res.statusCode}): ${data}`));
                    } else {
                        const response = JSON.parse(data);
                        // Reasoning models may still emit the answer in "thinking" instead of
                        // "response" even with think:false requested - fall back to that before
                        // ever falling back to the raw HTTP payload (which is not the model's reply).
                        resolve(response.response || response.thinking || data);
                    }
                } catch (error) {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`Ollama HTTP Error ${res.statusCode}`));
                    } else {
                        reject(new Error(`Invalid Ollama response: ${data}`));
                    }
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function requestJson(url, headers, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, headers, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (res.statusCode && res.statusCode >= 400) {
                        const errMsg = parsed.error?.message || parsed.error || JSON.stringify(parsed);
                        reject(new Error(`API Error (HTTP ${res.statusCode}): ${errMsg}`));
                    } else {
                        resolve(parsed);
                    }
                } catch (error) {
                    if (res.statusCode && res.statusCode >= 400) {
                        reject(new Error(`API HTTP Error ${res.statusCode} (Invalid JSON response)`));
                    } else {
                        reject(new Error(`Invalid JSON response: ${data}`));
                    }
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function generateNextEvent(archivedEvents, rollingSummary, lastResolution, extraContext = '', tieInContext = '') {
    const recentEvents = Array.isArray(archivedEvents) ? archivedEvents.slice(-5) : [];

    const prompt = `You are an expert Dungeon Master. The players have just resolved the previous event, and you need to generate the NEXT immediate event, obstacle, puzzle, or scene they face. Be creative and think outside the box.

Rolling Summary of Session:
${rollingSummary || 'No major events recorded.'}

Recent History (Last ${recentEvents.length} Events):
${JSON.stringify(recentEvents, null, 2)}

How they resolved the last event:
${lastResolution || 'N/A'}
${extraContext ? `\n${extraContext.trim()}\n` : ''}
${tieInContext ? `\n${tieInContext.trim()}\n` : ''}
Based on their actions and the current narrative, generate the new Active Event. Ensure you focus on STAKES (what happens if they do nothing) and COMPLICATIONS (what pushes back against them). Prefer tying the new event into an established Background Thread or World Element listed above when one fits naturally, rather than inventing an unconnected cast from scratch - recurring threats and threads should feel connected, not one-off.
Respond ONLY with a JSON object in this exact format. Do not use markdown backticks:
{
  "activeEvent": {
    "title": "Short title of the new scene/obstacle",
    "description": "What do the players see, hear, or experience right now?",
    "stakes": "What happens if they do nothing or fail? (e.g., 'The town panics and prices quadruple')",
    "complication": "What is the immediate obstacle or twist pushing back against them? (e.g., 'Guards suspect the players')"
  },
  "linkedBackgroundEventId": "The exact id of the Background Thread above this event grew out of, or null if this event isn't tied to any of them."
}`;

    if (config.OllamaConfig?.enabled) {
        return callOllama(prompt).then(res => {
            try {
                return parseJsonLoose(res);
            } catch(e) {
                console.warn('-> Ollama response parsing failed, falling back to cloud providers:', e.message);
                return fallbackToCloudProvidersForEvents(prompt);
            }
        }).catch(error => {
            console.warn('-> Ollama call failed for event generation, falling back to cloud providers:', error.message);
            return fallbackToCloudProvidersForEvents(prompt);
        });
    }

    return fallbackToCloudProvidersForEvents(prompt);
}

// Occasional, low-frequency review of "background events" - narrative threads that progress
// independently of the single "current event" the players are directly facing (index.js's
// updateCampaignBackgroundEvents(), triggered every N utterances, see config.json
// BackgroundEventConfig.utteranceInterval). Deliberately framed as private/DM-only and
// change-averse: most threads should stay exactly as they are on most calls. Returns
// { updates: [...], newThread: {...}|null } or null. Nested shape (updates is an array of
// objects, newThread is a nested object) - parsed with parseJsonLoose, never normaliseJson, same
// reasoning as generateNextEvent's { activeEvent: {...} } above.
function updateBackgroundEvents(activeThreads, rollingSummary, recentTranscript) {
    const threadsJson = JSON.stringify((activeThreads || []).map((t) => ({
        id: t.id,
        title: t.title,
        currentState: t.currentState || t.description,
        status: t.status
    })), null, 2);

    const prompt = `You are the Dungeon Master's private background-events tracker. Background events are slow-burn threads happening in the world independently of whatever the players are directly facing right now (the "current event") - a cult gathering, a rival adventuring party's progress, a political feud, a plague spreading, etc. They evolve occasionally and quietly; the players may never learn of most of them directly unless they surface through play.

Existing Background Threads:
${(activeThreads && activeThreads.length > 0) ? threadsJson : 'None yet.'}

Short-Term Session Memory:
${rollingSummary || 'No major events recorded.'}

Recent Transcript:
${recentTranscript || 'N/A'}

Review the existing threads above against recent play. For each one, decide if it should progress (a small, specific change to its "currentState"), resolve (concludes, for better or worse), or stay exactly as-is (omit it from "updates" entirely if nothing changed - most threads should NOT change most of the time). Only propose ONE new background thread, and only if something in recent play plausibly seeds one (an offhand rumor, an unresolved detail, a named threat left unaddressed) - most reviews should propose no new thread at all (null). Keep changes subtle and low-frequency; this is slow-burn worldbuilding, not another current event.

Respond ONLY with a JSON object in this exact format. Do not use markdown backticks:
{
  "updates": [ { "id": "the exact id of an existing thread above", "status": "active | resolved", "currentState": "A short, specific update to what's happening now", "note": "One sentence for the DM's own log of what changed and why" } ],
  "newThread": { "title": "Short title", "description": "The premise - what's actually going on, written as a DM-only reference fact", "relatedEntityNames": ["Existing NPC/location/lore names this ties into, if any"], "secret": true } | null
}`;

    if (config.OllamaConfig?.enabled) {
        return callOllama(prompt).then(res => {
            try {
                return parseJsonLoose(res);
            } catch (e) {
                console.warn('-> Ollama background-event parsing failed, falling back to cloud providers:', e.message);
                return fallbackToCloudProvidersForBackgroundEvents(prompt);
            }
        }).catch(error => {
            console.warn('-> Ollama call failed for background-event update, falling back to cloud providers:', error.message);
            return fallbackToCloudProvidersForBackgroundEvents(prompt);
        });
    }

    return fallbackToCloudProvidersForBackgroundEvents(prompt);
}

function fallbackToCloudProvidersForBackgroundEvents(prompt) {
    const selected = selectCloudProvider();
    if (!selected) {
        console.warn('-> AI Provider: Ollama is disabled and no valid cloud API keys found for background-event update (tried Gemini -> Anthropic -> OpenAI)');
        return Promise.resolve(null);
    }

    console.log(`-> Using ${selected.provider} as LLM provider for background-event update`);

    return callCloudProvider(selected.provider, selected.apiKey, prompt).then(res => {
        if (!res) return null;
        try {
            return parseJsonLoose(res);
        } catch (e) {
            console.error(`Failed to parse background-event JSON from ${selected.provider}:`, e);
            return null;
        }
    });
}

// One-shot "invent a whole campaign starting point" call - triggered when players finish
// describing their Session Zero ideas (see index.js handleSessionZeroInput). Not part of the
// regular per-turn DM pipeline. Returns { introLore, worldEntities } or null.
function generateCampaignSeed(playerIdeas = '', characterBackstories = '') {
    const ideasSection = playerIdeas && playerIdeas.trim()
        ? `The players described these ideas for the setting - honor them as the foundation of what you invent:\n"""\n${playerIdeas.trim()}\n"""`
        : 'The players did not give any specific ideas - invent freely, staying broadly appropriate for a fantasy tabletop RPG.';

    // Only populated when one or more players linked a pre-made character (e.g. via D&D Beyond)
    // before the campaign was generated - empty for voice-only character intros, since those
    // happen after this call (see beginSessionOne's findRelevantRecords-based tie-in instead,
    // which covers backstories that weren't known yet at this point).
    const backstorySection = characterBackstories && characterBackstories.trim()
        ? `\nThe following characters already exist, created by the players before this session - weave elements of their backstories into the world you invent below wherever it genuinely fits (a mentioned hometown could become a real starting location, a rival or mentor could become an NPC, a hinted-at threat could become secret lore) rather than treating them as separate from the setting:\n"""\n${characterBackstories.trim()}\n"""\n`
        : '';

    const prompt = `You are a creative fantasy Dungeon Master turning the players' Session Zero ideas into the actual starting point of a brand new campaign. Do not reuse a well-known published D&D setting, novel, or other IP.

${ideasSection}
${backstorySection}
Respond ONLY with a valid JSON object in this exact format. Do not use markdown backticks:
{
  "introLore": "3 to 4 paragraphs, written to be read aloud to players at the very start of the campaign: the tone, the world, where the party begins, and an immediate hook that gives them a reason to act. Build on the players' ideas above. PUBLIC information only - do not reference anything secret here.",
  "narratorPersona": "ONE short sentence (max ~15 words) defining THIS campaign's narrative voice for every future turn - tone only (e.g. 'Grim and atmospheric, with dry gallows humor.'), not pacing notes or a list of stylistic flourishes. Infer it from the players' ideas and the introLore you just wrote; if they gave no strong tonal signal, invent something fitting and specific rather than a generic 'epic fantasy' description. This gets injected into every single turn's prompt for the rest of the campaign, so keep it tight.",
  "worldEntities": [
    { "type": "locations | npcs | items | quests | lore | encounters", "name": "Proper name", "description": "Everything worth remembering about it, written as a reference fact for a future DM to stay consistent - not a narration.", "secret": true or false }
  ]
}

GUIDELINES - your "worldEntities" array MUST include ALL SIX of the following, not just some:
- "locations": the party's actual starting location ("secret": false - players need somewhere to begin), plus 2-4 more, a mix of public (nearby, known of) and secret (not yet discovered).
- "npcs": 3-5, a mix of public (people the party could plausibly know or meet immediately) and secret (their true motives, allegiance, or even existence is not yet known to the players).
- "items": at least 1-2 notable items - something the party starts with, or a known/legendary item tied to the local lore. Mix of public and secret (a hidden relic's true nature, for instance).
- "quests": at least 1, "secret": false, giving the party an immediate, concrete reason to act right now.
- "lore": 2-3 entries, mostly "secret": true - hidden history, a looming threat, a secret organization, the real cause behind something mentioned in introLore. This is groundwork for future reveals and twists - make it specific and interesting, tied to the NPCs/locations/items above, not generic.
- "encounters": at least 1 - an immediate tactical, environmental, or social challenge the party could plausibly run into very soon (not necessarily right this second).
- "secret": true entries are for the DM's own future reference only - never leak them into introLore, and never state them to players until they are earned or discovered through play.
- If pre-made characters and their backstories were given above, prefer tying "worldEntities" into them over inventing unconnected ones - but don't force a connection that doesn't fit. A speculative or twisty connection (e.g. secretly linking a character's backstory to the campaign's looming threat) should be "secret": true, same as any other DM-only groundwork.`;

    if (config.OllamaConfig?.enabled) {
        return callOllama(prompt).then(res => {
            try {
                return normaliseJson(res);
            } catch (e) {
                console.warn('-> Ollama campaign seed parsing failed, falling back to cloud providers:', e.message);
                return fallbackToCloudProvidersForCampaignSeed(prompt);
            }
        }).catch(error => {
            console.warn('-> Ollama call failed for campaign seed generation, falling back to cloud providers:', error.message);
            return fallbackToCloudProvidersForCampaignSeed(prompt);
        });
    }

    return fallbackToCloudProvidersForCampaignSeed(prompt);
}

function fallbackToCloudProvidersForCampaignSeed(prompt) {
    const selected = selectCloudProvider();
    if (!selected) {
        console.warn('-> AI Provider: No valid cloud API keys found for campaign seed generation');
        return Promise.resolve(null);
    }

    console.log(`-> Using ${selected.provider} as LLM provider for campaign seed generation`);

    return callCloudProvider(selected.provider, selected.apiKey, prompt).then(res => {
        if (!res) return null;
        try {
            return normaliseJson(res);
        } catch (e) {
            console.error(`Failed to parse campaign seed JSON from ${selected.provider}:`, e);
            return null;
        }
    });
}

// One-shot "who's playing what" call - triggered once players finish introducing themselves
// and their characters, between the campaign intro and Session 1's opening event (see
// index.js handleCharacterIntroInput/beginSessionOne). Not part of the regular per-turn DM
// pipeline. Returns { characters: [{ discordUser, characterName, description, openingAction }] }
// or null.
function parseCharacterIntroductions(compiledIntros = '') {
    const prompt = `You are extracting structured character information from a transcript of players introducing themselves at the start of a tabletop RPG session. Each line is tagged with the Discord username who said it, e.g. "[SomeUser]: ...".

Transcript:
"""
${compiledIntros.trim() || 'No introductions were heard.'}
"""

For each distinct Discord username who introduced a character, produce one entry - if a username speaks multiple times, combine everything they said into a single entry for them. Ignore lines that are not an introduction (off-topic chatter, the DM's own prompt, etc).

Respond ONLY with a valid JSON object in this exact format. Do not use markdown backticks:
{
  "characters": [
    { "discordUser": "The exact Discord username tag from the transcript", "characterName": "The character's name as stated", "description": "A brief description of the character - appearance, personality, class/role - as stated or reasonably inferred", "openingAction": "What they said they're doing as the scene opens, or a short reasonable default if not stated" }
  ]
}`;

    if (config.OllamaConfig?.enabled) {
        return callOllama(prompt).then(res => {
            try {
                return parseJsonLoose(res);
            } catch (e) {
                console.warn('-> Ollama character-intro parsing failed, falling back to cloud providers:', e.message);
                return fallbackToCloudProvidersForCharacterIntros(prompt);
            }
        }).catch(error => {
            console.warn('-> Ollama call failed for character-intro parsing, falling back to cloud providers:', error.message);
            return fallbackToCloudProvidersForCharacterIntros(prompt);
        });
    }

    return fallbackToCloudProvidersForCharacterIntros(prompt);
}

function fallbackToCloudProvidersForCharacterIntros(prompt) {
    const selected = selectCloudProvider();
    if (!selected) {
        console.warn('-> AI Provider: No valid cloud API keys found for character-intro parsing');
        return Promise.resolve(null);
    }

    console.log(`-> Using ${selected.provider} as LLM provider for character-intro parsing`);

    return callCloudProvider(selected.provider, selected.apiKey, prompt).then(res => {
        if (!res) return null;
        try {
            return parseJsonLoose(res);
        } catch (e) {
            console.error(`Failed to parse character-intro JSON from ${selected.provider}:`, e);
            return null;
        }
    });
}

function fallbackToCloudProvidersForEvents(prompt) {
    const selected = selectCloudProvider();
    if (!selected) {
        console.warn('-> AI Provider: Ollama is disabled and no valid cloud API keys found for event generation (tried Gemini -> Anthropic -> OpenAI)');
        return Promise.resolve(null);
    }

    console.log(`-> Using ${selected.provider} as LLM provider for event generation`);

    return callCloudProvider(selected.provider, selected.apiKey, prompt).then(res => {
        if (!res) return null;
        try {
            return parseJsonLoose(res);
        } catch (e) {
            console.error(`Failed to parse next event JSON from ${selected.provider}:`, e);
            return null;
        }
    });
}



// Robust "make a JSON-ish LLM response into an object" parser, without flattening nested
// structure - use this directly when the expected shape has meaningful nesting (e.g.
// generateNextEvent's { activeEvent: {...} }). normaliseJson() below layers flatten() on
// top for the main DM-turn schema, where any nesting is a model mistake to be repaired.
function parseJsonLoose(input) {
    if (typeof input === 'object' && input !== null) return input;
    if (typeof input !== 'string') return input;

    let str = input.replace(/```(?:json|javascript|js)?/gi, '').replace(/```/g, '').trim();

    const start = str.indexOf('{');
    const end = str.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
        str = str.slice(start, end + 1);
    }

    str = str
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/\bTrue\b/g, 'true')
        .replace(/\bFalse\b/g, 'false')
        .replace(/\bNone\b/g, 'null');

    try {
        return JSON.parse(str);
    } catch (e1) {
        try {
            return new Function(`"use strict"; return (${str});`)();
        } catch (e2) {
            const cleaned = str
                .replace(/,\s*([\}\]])/g, '$1')
                .replace(/[\r\n]+/g, ' ');
            return new Function(`"use strict"; return (${cleaned});`)();
        }
    }
}

function normaliseJson(input) {
    return flatten(parseJsonLoose(input));
}

function flatten(obj, result = {}) {
    for (const key of Object.keys(obj)) {
        const val = obj[key];

        if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
            flatten(val, result);
        } else {
            result[key] = val;
        }
    }
    return result;
}

module.exports = { 
    buildPrompt,
    callModel,
    generateNextEvent,
    generateCampaignSeed,
    parseCharacterIntroductions,
    updateBackgroundEvents
};