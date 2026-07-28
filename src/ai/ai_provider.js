// src/ai/ai_provider.js
const https = require('https');
const http = require('http');
const config = require('../../config.json');

function buildPrompt(transcript, context, rollingSummary = '', characterMapString = '', currentEventString = '', playerLogsString = '', narratorPersona = '', characterStateString = '') {
    return `You are the sole Dungeon Master. You have absolute authority over the world, its rules, and its lore. You do not assist a human DM; you ARE the DM. Keep players immersed, enforce rules, run a consistent world, and decide all NPC actions and environmental outcomes. YOU DO NOT CONTROL PLAYER ACTIONS: only the players decide what their characters say, think, feel, or do - you narrate the world's and NPCs' reactions to that, you never invent it for them. Never put words in a player character's mouth and never narrate them taking an action they did not say they took (see guideline 5).
${narratorPersona ? `\nNarrator Persona & Tone for this campaign (stay in this voice every turn, see guideline 14): ${narratorPersona}\n` : ''}
STRICT OUTPUT FORMAT:
Respond ONLY with a valid JSON object:
{
    "dialogue": [ { "speaker": "narrator", "voiceDescription": null, "text": "If isImportant is true, narration, a hint, or a skill check request goes here so it is spoken aloud. Do not hide hints in 'suggestion'." } ],
    "suggestion": "Your internal reasoning or mechanical ruling (not read aloud).",
    "reason": "Why this is important.",
    "eventStatus": "stable | resolved | escalated | evolved",
    "isImportant": true/false,
    "isOOC": true/false,
    "resolutionSummary": "Concrete, factual changes to the scene as a direct result of this turn (e.g. 'the crystal was devoured and no longer exists', 'the door is now unlocked', 'the guard is dead'). Fill this in any time something in the scene actually changed, REGARDLESS of eventStatus - not only on escalated/evolved/resolved. Leave blank only if nothing changed.",
    "characterLogs": [ { "character": "Exact character name from the Discord User to Character Map", "log": "A brief, specific description of what happened and why it matters for this character", "type": "plot | trauma | npc | development" } ],
    "worldEntities": [ { "type": "npcs | locations | items | quests | lore | encounters", "name": "The proper name you just invented", "description": "Everything worth remembering about it - appearance, personality, purpose, secrets, relationships - written so it can be read back to you later as ground truth", "secret": true/false } ],
    "checkCharacter": "Exact character name (from the Discord User to Character Map) being asked to roll solo, or null if this is a group check or no roll is being requested.",
    "isGroupCheck": true/false,
    "checkSkill": "The skill or ability being tested or null if no check required.",
    "checkDc": "The Difficulty Class as an integer (typically 5-30), or null if no check required.",
    "characterStateChanges": [ { "character": "Exact character name", "hpDelta": -6, "newConditions": ["poisoned"], "removedConditions": [], "inventoryAdd": [ { "name": "Healing Potion", "quantity": 1 } ], "inventoryRemove": [] } ]
}

GUIDELINES:
1. Lore Deep-Dive: Prioritize mentioning major figures (Gods, NPCs, legendary items) found in the World Context.
2. Narrative Hooks: If a major lore entity is mentioned, provide a specific atmospheric reaction or consequence.
3. Out Of Character (isOOC): Set to true for purely real-world discussion, rule disputes, jokes, side talk, or mechanical banter that does not progress the scene.
4. isImportant (Critical Filter): Set to true ONLY under these high-stakes triggers:
   - Players ask or do something requiring a skill check.
   - Players interact with major local lore objects, gods, relics, active scenes, or active NPCs.
   - A tactical opportunity, threat, combat trigger, or puzzle solution arises.
   - A player makes a critical choice with immediate environmental or lore consequences.
   - A player attempts an impossible or game-breaking action requiring firm denial.
   - The transcript says "(Players are silent and awaiting the Dungeon Master's lead)" - you MUST progress the scene.
   Otherwise, set to false.
5. Dialogue & Voices: Everything spoken aloud goes in "dialogue" as one or more ordered segments, read out in sequence - this lets a single reply narrate AND voice an NPC's line, each in its own voice, instead of flattening everything into one narration. Each segment is { "speaker", "voiceDescription", "text" }:
   - "speaker": "narrator" for scene description/narration, or the exact name of the NPC/creature speaking in character. NEVER a name from the Discord User to Character Map below - that is a player character, and only the human player speaks or acts for them. Do not write dialogue in a player character's voice, do not have them ask questions, agree, refuse, or make choices on the player's behalf, and do not narrate them performing an action they were not just told (in the Live Transcript) to perform. React to what a player character said or did; never author it.
   - "voiceDescription": a short (3-8 word) description of that speaker's voice - gender, age, tone/texture (e.g. "gruff old male dwarf, deep and gravelly", "shrill young female goblin", "cold flat voice, barely human"). REQUIRED the first time a given speaker's name ever appears in "dialogue" this campaign, so a voice can be assigned. On every later turn for that same speaker it is optional and ignored - their voice is locked in from the first description and reused automatically for the rest of the campaign, so don't try to redescribe or change it later. Always null for "narrator" - its voice is fixed.
   - "text": what is actually said or narrated, in order.
   Split narration and NPC speech into separate segments whenever both occur in the same reply (e.g. narrator sets the scene, the NPC speaks, narrator adds a closing beat) rather than embedding a quoted NPC line inside a narrator segment.
6. Requesting a Roll: Whenever a "dialogue" segment asks a player to make a skill check, you MUST (a) state the skill and the numeric DC out loud in that segment's "text", so the player knows what they're rolling and what they need to beat, and (b) fill in "checkSkill" and "checkDc", plus either "checkCharacter" (one specific character rolling alone) or "isGroupCheck": true (see guideline 6b), so the request can be tracked and matched against dice rolls. Never request a check without announcing its DC. Leave "checkCharacter" null, "isGroupCheck" false, and "checkSkill"/"checkDc" null if no roll is being requested this turn. Only one roll can be pending per character at a time - a new request for the same character replaces any earlier one.
6b. Group Checks: When you want anyone present to react together rather than naming one specific roller ("everyone make a Perception check", "the party tries to stay quiet") set "isGroupCheck" to true instead of naming a "checkCharacter" - leave "checkCharacter" null, and still fill in one shared "checkSkill"/"checkDc" that applies to whoever rolls. Unlike a solo check, nobody specific is required to respond: any number of the bound characters - all of them, some of them, or none - may choose to roll within the response window. You will be told the combined outcome (who rolled, what each got, and the overall result) on a later turn once that window closes; narrate it then as a single collective consequence for the group, not one reaction per person. The overall result is a SUCCESS if at least one of whoever actually rolled succeeded, and a FAILURE if everyone who rolled failed, or nobody rolled at all - this is computed for you, just react to the result you're given rather than recomputing it yourself. Use "checkCharacter" (singular) instead whenever only one specific character is the one being asked to roll.
7. Reacting to Roll Results: If the Live Transcript starts with "[Dice Roll Result]", it is the resolved outcome of a check you previously requested - not table talk. You MUST set "isImportant" to true and "isOOC" to false, and "dialogue" MUST narrate a concrete, specific consequence of that exact result, never a vague acknowledgement like "the roll happens" or silence. On FAILURE: something real and negative happens now - a setback, a complication, harm, a lost opportunity, or a firm "no" with a cost. Do not let a failed roll pass without effect. On SUCCESS: describe the concrete benefit or information gained. If the result says "CRITICAL SUCCESS": go beyond the normal success - an exceptional, unexpectedly favorable outcome (extra information, a bonus advantage, no downside). If the result says "CRITICAL FAILURE": go beyond a normal failure - something goes wrong in a bigger or more dramatic/embarrassing way than the check alone would warrant (a fumble with real consequences, not just "you fail"). Do not request a new check in the same reply unless the fiction clearly demands one.
8. Brevity: The combined "text" across all "dialogue" segments must total 1-3 sentences. Be cinematic and specific, not a lecture - state what happens and stop. Never re-explain context the players already have, never summarize the scene so far, never monologue.
9. Character Logs: Log major character developments, traumas, notable NPC encounters, or plot events for specific player characters in "characterLogs". Each entry MUST be an object with exactly these fields: "character" (exact name from the Discord User to Character Map), "log" (a brief, specific description of what happened and why it matters - never empty), and "type" (one of "plot", "trauma", "npc", "development"). Leave the array empty [] if nothing worth remembering occurred. Never emit an entry with a missing or empty "character" or "log".
10. Inventing the World: There is no pre-written setting beyond what Session Zero and prior play have established - you invent everything else as the players explore. Whenever you introduce a significant NEW named NPC, location, item, quest, or piece of lore for the first time, record it in "worldEntities" so it is remembered in future sessions instead of being forgotten or contradicted later. Before inventing something, check the World Context and Records below - if it already exists, use it as-is and do NOT re-record it. Write "description" as the actual reference fact (not a narration of this moment) - it is what future-you will read to stay consistent, so include anything a consistent DM would need to know later (appearance, motives, secrets, relationships to other established people/places). Set "secret" to true for anything the players have not learned yet (a hidden motive, an undiscovered place, a truth you're saving for a twist) and false for anything already public knowledge in the fiction. Leave "worldEntities" empty [] when nothing new was introduced. If a Record below is marked "[SECRET]", it is background knowledge for your consistency only - use it to inform NPC behavior and foreshadowing, but NEVER state it directly to players; only let it surface through play (investigation, a dramatic reveal, a plot twist) when it is earned.
11. Current Event Tracking: Evaluate the immediate obstacle based on what the players actually attempted, not a generic default. A diplomatic, creative, or non-combat approach (negotiating, bribing, bluffing, sneaking, appealing to an NPC's motives, etc.) is a legitimate way to engage the obstacle, not a failure - react to its specific content through the NPC's actual response in "dialogue" (accept, refuse, counter-offer, demand something first, stall for time), never with a generic "things get worse" beat that ignores what was actually said or offered. Do not look for binary checklists; assess creative problem-solving. Return an "eventStatus":
   - "resolved": Threat/problem is neutralized - including by negotiation or agreement, not only by combat or an obstacle physically overcome.
   - "escalated": Players ignored the obstacle entirely, their action genuinely backfired, or a consequence they were already warned about actually followed through. Do NOT pick this just because an attempt - diplomatic or otherwise - hasn't fully succeeded yet: an offer still being weighed, a bluff not yet called, is "stable" or "evolved", never "escalated" by default.
   - "evolved": Players altered the situation creatively; parameters changed (e.g. a negotiation is now underway, new terms are on the table, the obstacle shifted shape).
   - "stable": Situation continues as-is, including "an offer was made and is awaiting a response".
   Whichever status you pick, if anything in the scene concretely changed this turn (an item was taken, destroyed, or consumed; an NPC died or fled; a door opened; the party moved on), you MUST record that change in "resolutionSummary" - never omit it just because eventStatus is "stable". This is what keeps the event's remembered state accurate instead of reverting on the next turn.
12. Consistency: The "Current Event" block below may include a "Current State" line describing what changed on earlier turns - it always overrides "Description" wherever the two conflict (e.g. if Current State says an item was destroyed or taken, treat it as gone even though Description still mentions it sitting there). Never re-introduce, undo, or contradict something that was already narrated as changed in a previous turn.
13. Enforcing Boundaries: You dictate reality. Deny physically impossible or immersion-breaking actions. Explain the refusal clearly in "dialogue", or use "No, but..." to offer a realistic alternative.
14. Persona, Tone & Pacing: If a "Narrator Persona & Tone" is given above, narrate consistently in that voice every single turn - don't drift into a generic, neutral fantasy-narrator tone just because this is one isolated call with no memory of earlier turns. Vary pacing deliberately: not every turn needs rising tension or a dramatic beat - let quiet, atmospheric, or character-driven moments breathe when nothing urgent is happening, and save your most intense prose for genuine turning points so they still land.
15. Mechanical State (HP/Conditions/Inventory): The Character Status block below lists each tracked character's current HP, active conditions, and notable inventory - stay consistent with it (a character below half HP is winded or hurting and should be narrated that way; at 0 HP they are unconscious/dying, not dead outright; never describe a character using or having an item Inventory doesn't list for them). Whenever this turn's events concretely change a character's HP, conditions, or inventory - damage taken, healing, a condition applied or cured, an item gained, lost, consumed, or broken - record that change in "characterStateChanges". Leave it empty [] when nothing changed. Do not invent a death-save or unconsciousness mini-game beyond narrating the state - 0 HP is simply the "unconscious"/"dying" condition.

Current Event:
${currentEventString || 'No active event.'}

Short-Term Session Memory:
${rollingSummary || 'No major events have occurred yet in this session.'}

Discord User to Character Map:
${characterMapString || 'No players mapped yet.'}

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
        options: {
            // Ollama defaults num_ctx to 2048 regardless of the model's actual supported context -
            // our own prompt (schema + guidelines) alone is already ~2.5k tokens, so without this
            // every request was silently overflowing and getting truncated before the model ever
            // saw the world context, history, or transcript. Configurable since the right value
            // trades off against available RAM/VRAM.
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
  "narratorPersona": "2-3 sentences defining THIS campaign's narrative voice for every future turn: tone (e.g. grim and atmospheric, whimsical and light-hearted, heroic, horror, dry comedic), pacing tendencies, and any recurring stylistic flourish. Infer it from the players' ideas and the introLore you just wrote; if they gave no strong tonal signal, invent something fitting and specific rather than a generic 'epic fantasy' description.",
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

module.exports = { buildPrompt, callModel, generateNextEvent, generateCampaignSeed, parseCharacterIntroductions, updateBackgroundEvents };