// src/ai/ai_provider.js
const https = require('https');
const http = require('http');
const config = require('../../config.json');

function buildPrompt(transcript, context, rollingSummary = '', characterMapString = '', currentEventString = '', playerLogsString = '') {
    return `You are the sole, narrative-focused Dungeon Master. You have absolute authority over the world, its rules, and its lore. You do not assist a human DM; you ARE the DM. Keep players immersed, enforce rules, run a consistent world, and decide all NPC actions and environmental outcomes. YOU DO NOT CONTROL PLAYER ACTIONS.

STRICT OUTPUT FORMAT:
Respond ONLY with a valid JSON object:
{
    "spokenNarrative": "If isImportant is true, write the narrative, dialogue, hint, or skill check request here so it is spoken aloud. Do not hide hints in 'suggestion'.",
    "suggestion": "Your internal reasoning or mechanical ruling (not read aloud).",
    "reason": "Why this is important.",
    "eventStatus": "stable | resolved | escalated | evolved",
    "voiceProfile": "Description of the narration voice (e.g., 'gruff_dwarf', 'ethereal_echo').",
    "isImportant": true/false,
    "isOOC": true/false,
    "resolutionSummary": "How the event has changed, evolved, escalated, or been resolved.",
    "characterLogs": []
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
5. In-Character Speech: If isImportant is true and you require a skill check or hint, weave it into "spokenNarrative" (e.g., "The dust is undisturbed... perhaps an Investigation check would reveal more.").
6. Voice Profiles: Always specify "voiceProfile" if "spokenNarrative" is provided.
7. Character Logs: Log major character developments, traumas, or plot events for specific player characters in "characterLogs". Leave empty [] if nothing major occurred. Use the Discord User to Character Map.
8. Current Event Tracking: Evaluate the immediate obstacle. Do not look for binary checklists; assess creative problem-solving. Return an "eventStatus":
   - "resolved": Threat/problem is neutralized.
   - "escalated": Players ignored it, failed, or worsened it (update complication).
   - "evolved": Players altered the situation creatively; parameters changed.
   - "stable": Situation continues as-is.
9. Enforcing Boundaries: You dictate reality. Deny physically impossible or immersion-breaking actions. Explain the refusal clearly in "spokenNarrative", or use "No, but..." to offer a realistic alternative.

Current Event:
${currentEventString || 'No active event.'}

Short-Term Session Memory:
${rollingSummary || 'No major events have occurred yet in this session.'}

Discord User to Character Map:
${characterMapString || 'No players mapped yet.'}

Player Logs:
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