// src/ai/ai_provider.js
const https = require('https');
const http = require('http');
const config = require('../../config.json');

function buildPrompt(transcript, context, rollingSummary = '', characterMapString = '', currentEventString = '', playerLogsString = '') {
    return `You are the sole Dungeon Master. You are a creative, narrative-focused Dungeon Master with absolute authority over the world, its rules, and its lore. You are not assisting a human DM; you ARE the DM. Your goal is to keep players immersed, enforce the rules, and run a consistent Dungeons and Dragons world. You decide what NPCs do, the outcomes of player actions, and world events.

STRICT OUTPUT FORMAT:
Respond ONLY with a JSON object:
{
    "spokenNarrative": "If isImportant is true, you MUST write the narrative, dialogue, hint, or skill check request here so it is spoken aloud to the players. Do not hide important hints in 'suggestion'.",
    "suggestion": "Your internal reasoning or mechanical ruling here (this is not read aloud to players)",
    "reason": "Why this is important",
    "eventStatus": "stable | resolved | escalated | evolved",
    "voiceProfile": "A description of the narration voice",
    "isImportant": true/false,
    "isOOC": true/false,
    "resolutionSummary": "How the event has changed or evolved or escalated or been resolved.",
}

GUIDELINES:
1. Lore Deep-Dive: If the World Context contains major figures (Gods, important NPCs, legendary items or locations), prioritize mentioning them. 
2. Narrative Hooks: If a God or major lore entity is mentioned, provide a specific, atmospheric reaction or a potential consequence.
3. is Out Of Character (OOC): Set "isOOC" to true if the live transcript contains purely real-world discussion, rule disputes, jokes, side talk, food orders, or mechanical banter that does not progress the in-game scene or lore.
4. isImportant (The Critical Importance Filter): Set "isImportant" to true ONLY under the following high-stakes triggers:
   - When players are asking or doing something that requires a skill check (Athletics, Arcana, Stealth, etc.).
   - When players mention or interact with major local lore objects, gods, relics, active scenes, or active NPCs provided in the context.
   - When there is a tactical opportunity, threat, combat trigger, or puzzle solution.
   - When the player makes a critical choice that should have immediate environmental or lore consequences.
   - When a player attempts an impossible, game-breaking, or highly unrealistic action that requires a firm denial.
   - When the transcript says "(Players are silent and awaiting the Dungeon Master's lead)" you MUST set isImportant to true and provide narrative to progress the scene!
   Otherwise, set "isImportant" to false so you are not distracted by routine roleplay or basic descriptions.
5. In-Character Speech (spokenNarrative): If isImportant is true and you have guidance, a hint, or a skill check to request, you MUST include it in the "spokenNarrative" so the players hear it. For example, weave the hint into your description: "The dust on the tome seems undisturbed... perhaps an Investigation check would reveal more." This string will be converted to Text-to-Speech.
6. Voice Profiles: If spokenNarrative is provided, specify the "voiceProfile" to match the speaker (e.g., "goblin" for a squeaky voice, "old_man" for a slow voice).
7. Character Logs: If the transcript contains a major character development, traumatic experience, notable NPC interaction, or major plot event for a player character, log it in "characterLogs". Leave it as an empty array [] if nothing major happened. Use the Discord User to Character Map to understand who is acting.
8. Current Event Tracking: Use the "Current Event" context to understand the immediate obstacle, puzzle, or scene the players are dealing with right now. 
   CRITICAL EVENT EVALUATION RULE: Do not look for a binary checklist resolution. Players are creative. Evaluate their recent dialogue and actions. Have they bypassed the threat, redirected it, mitigated the stakes, or introduced a clever exploitation of the environment/NPCs?
   You must return an "eventStatus":
   - "resolved" (The threat or problem is neutralized or fundamentally settled).
   - "escalated" (The players ignored it, failed a major action, or made it worse—update the Complication!).
   - "evolved" (The players altered the situation creatively; it's not solved, but the parameters changed).
   - "stable" (The situation continues as-is).
9. Enforcing Boundaries (The "No" Rule): You have absolute authority over the world's reality. If a player attempts an action that is physically impossible, severely breaks immersion, or wildly defies the rules of D&D, you MUST deny it. Explain the refusal clearly in your "spokenNarrative" using a firm description of why it fails, or use the "No, but..." philosophy to offer a realistic alternative.

Current Event (The immediate obstacle or scene):
${currentEventString || 'No active event.'}

Short-Term Session Memory (Rolling Summary of previous key events):
${rollingSummary || 'No major events have occurred yet in this session.'}

Discord User to Character Map:
${characterMapString} || 'No players mapped yet.'}

Player Logs (Meta actions by players):
${playerLogsString || 'No player actions logged.'}

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

function fallbackToCloudProviders(prompt) {
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

    if (!provider || !apiKey) {
        console.warn('-> AI Provider: No valid cloud API keys found in .env (tried Gemini -> Anthropic -> OpenAI)');
        return Promise.resolve(null);
    }

    console.log(`-> Using ${provider} as LLM provider`);
    
    if (provider === 'gemini') {
        return callGemini(apiKey, prompt).then(text => {
            try { return JSON.parse(text); } catch(e) { return { suggestion: text, isImportant: true, eventStatus: "stable" }; }
        });
    }

    if (provider === 'anthropic') {
        return callAnthropic(apiKey, prompt).then(text => {
            try { return JSON.parse(text); } catch(e) { return { suggestion: text, isImportant: true, eventStatus: "stable" }; }
        });
    }

    return callOpenAI(apiKey, prompt).then(text => {
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
        format: "json"
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
                        resolve(response.response || data);
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

function generateNextEvent(archivedEvents, rollingSummary, lastResolution) {
    const recentEvents = Array.isArray(archivedEvents) ? archivedEvents.slice(-5) : [];

    const prompt = `You are an expert Dungeon Master. The players have just resolved the previous event, and you need to generate the NEXT immediate event, obstacle, puzzle, or scene they face. Be creative and think outside the box. 

Rolling Summary of Session:
${rollingSummary || 'No major events recorded.'}

Recent History (Last ${recentEvents.length} Events):
${JSON.stringify(recentEvents, null, 2)}

How they resolved the last event:
${lastResolution || 'N/A'}

Based on their actions and the current narrative, generate the new Active Event. Ensure you focus on STAKES (what happens if they do nothing) and COMPLICATIONS (what pushes back against them).
Respond ONLY with a JSON object in this exact format. Do not use markdown backticks:
{
  "activeEvent": {
    "title": "Short title of the new scene/obstacle",
    "description": "What do the players see, hear, or experience right now?",
    "stakes": "What happens if they do nothing or fail? (e.g., 'The town panics and prices quadruple')",
    "complication": "What is the immediate obstacle or twist pushing back against them? (e.g., 'Guards suspect the players')"
  }
}`;

    if (config.OllamaConfig?.enabled) {
        return callOllama(prompt).then(res => {
            try {
                return (typeof res === 'object') ? res : JSON.parse(res);
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

function fallbackToCloudProvidersForEvents(prompt) {
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

    if (!provider || !apiKey) {
        console.warn('-> AI Provider: Ollama is disabled and no valid cloud API keys found for event generation (tried Gemini -> Anthropic -> OpenAI)');
        return Promise.resolve(null);
    }

    console.log(`-> Using ${provider} as LLM provider for event generation`);
    
    let promise;
    if (provider === 'gemini') {
        promise = callGemini(apiKey, prompt);
    } else if (provider === 'anthropic') {
        promise = callAnthropic(apiKey, prompt);
    } else {
        promise = callOpenAI(apiKey, prompt);
    }

    return promise.then(res => {
        if (!res) return null;
        try {
            if (typeof res === 'string' && res.includes('```')) {
                res = res.replace(/```json/gi, '').replace(/```/g, '').trim();
            }
            return typeof res === 'string' ? JSON.parse(res) : res;
        } catch (e) {
            console.error(`Failed to parse next event JSON from ${provider}:`, e);
            return null;
        }
    });
}



function normaliseJson(input) {
    if (typeof input === 'object' && input !== null) {
        return flatten(input);
    }
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

    let parsed;

    try {
        parsed = JSON.parse(str);
    } catch (e1) {
        try {
            parsed = new Function(`"use strict"; return (${str});`)();
        } catch (e2) {
            const cleaned = str
                .replace(/,\s*([\}\]])/g, '$1')
                .replace(/[\r\n]+/g, ' ');
            parsed = new Function(`"use strict"; return (${cleaned});`)();
        }
    }

    return flatten(parsed);
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

module.exports = { buildPrompt, callModel, generateNextEvent };