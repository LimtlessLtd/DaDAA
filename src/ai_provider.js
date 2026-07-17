const https = require('https');
const http = require('http');
const config = require('../config.json');

function buildPrompt(transcript, context, rollingSummary = '', characterMapString = '', currentEventString = '', playerLogsString = '') {
    return `You are the sole Dungeon Master. You are a creative, narrative-focused Dungeon Master with absolute authority over the world, its rules, and its lore. You are not assisting a human DM; you ARE the DM. Your goal is to keep players immersed, enforce the rules, and run a consistent Dungeons and Dragons world. You decide what NPCs do, the outcomes of player actions, and world events.

STRICT OUTPUT FORMAT:
Respond ONLY with a JSON object:
{
  "isOOC": true/false,
  "isImportant": true/false,
  "suggestion": "Your 2-4 sentence internal reasoning or mechanical ruling here",
  "reason": "Why this is important",
  "spokenNarrative": "Optional: Write a compelling line of dialogue or narrative for YOU to speak aloud to the players, or leave empty if nothing needs to be said right now.",
  "voiceProfile": "Optional: One of [narrator, goblin, old_man, old_woman, man, woman, young_man, young_woman, child_boy, child_girl, monster] to match the character speaking. Default is narrator.",
  "characterLogs": [
    {
      "character": "Character Name",
      "log": "A brief description of the event, trauma, NPC interaction, or plot point",
      "type": "trauma | relationship | plot"
    }
  ],
  "eventResolved": true/false,
  "resolutionSummary": "If eventResolved is true, describe how the players resolved the current event (e.g., 'They smashed the door open'). Otherwise, leave empty."
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
5. In-Character Speech (spokenNarrative): If isImportant is true, you can optionally provide a "spokenNarrative". This string will be converted to Text-to-Speech and played directly into the Discord channel. Write it in your tone as a mysterious, dramatic Dungeon Master. Keep it under 2 sentences. 
6. Voice Profiles: If spokenNarrative is provided, specify the "voiceProfile" to match the speaker (e.g., "goblin" for a squeaky voice, "old_man" for a slow voice).
7. Character Logs: If the transcript contains a major character development, traumatic experience, notable NPC interaction, or major plot event for a player character, log it in "characterLogs". Leave it as an empty array [] if nothing major happened. Use the Discord User to Character Map to understand who is acting.
8. Current Event Tracking: Use the "Current Event" context to understand the immediate obstacle, puzzle, or scene the players are dealing with right now. If the transcript shows the players taking an action that resolves or clears the conditions of the Current Event, set "eventResolved" to true and provide a "resolutionSummary".
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

function callModel(prompt) {
    // Check if Ollama is enabled
    if (config.OllamaConfig?.enabled) {
        return callOllama(prompt);
    }

    const modelName = String(config.LLM || '').toLowerCase();
    let provider = 'openai';

    if (modelName.includes('gemini')) {
        provider = 'gemini';
    } else if (modelName.includes('claude')) {
        provider = 'anthropic';
    } else if (modelName.includes('gpt') || modelName.includes('o1')) {
        provider = 'openai';
    } else {
        provider = process.env.AI_PROVIDER || 'openai';
    }

    let apiKey = null;
    if (provider === 'gemini') {
        apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    } else if (provider === 'anthropic') {
        apiKey = process.env.ANTHROPIC_API_KEY;
    } else {
        apiKey = process.env.OPENAI_API_KEY;
    }

    if (!apiKey) {
        apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    }

    if (!apiKey) {
        console.warn('-> AI Provider: No API key found in .env');
        return Promise.resolve(null);
    }

    if (provider === 'gemini') {
        return callGemini(apiKey, prompt).then(text => {
            try { return JSON.parse(text); } catch(e) { return { suggestion: text, isImportant: true }; }
        });
    }

    if (provider === 'anthropic') {
        return callAnthropic(apiKey, prompt).then(text => {
            try { return JSON.parse(text); } catch(e) { return { suggestion: text, isImportant: true }; }
        });
    }

    return callOpenAI(apiKey, prompt).then(text => {
        try { return JSON.parse(text); } catch(e) { return { suggestion: text, isImportant: true }; }
    });
}

function callOllama(prompt) {
    const baseUrl = config.OllamaConfig?.baseUrl || 'http://localhost:11434';
    const model = config.OllamaConfig?.model || 'neural-chat';

    const body = JSON.stringify({
        model: model,
        prompt: prompt,
        stream: false
    });

    return requestOllama(baseUrl, body).then(text => {
        try { return JSON.parse(text); } catch(e) { return { suggestion: text, isImportant: true }; }
    });
}

function callGemini(apiKey, prompt) {
    // Sanitize any typographic en-dashes (–) or em-dashes (—) into standard hyphens (-)
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
        max_tokens: 240,
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
                        // Ollama returns newline-delimited JSON, need to parse the response
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
    const prompt = `You are an expert Dungeon Master. The players have just resolved the previous event, and you need to generate the NEXT immediate event, obstacle, puzzle, or scene they face. Be creative and think outside the box. Give hints on how to proceed occasionally.

Rolling Summary of Session:
${rollingSummary || 'No major events recorded.'}

Archived Events (Recent History):
${JSON.stringify(archivedEvents || [], null, 2)}

How they resolved the last event:
${lastResolution || 'N/A'}

Based on their actions and the current narrative, generate the new Active Event.
Respond ONLY with a JSON object in this exact format:
{
  "activeEvent": {
    "title": "Short title of the new scene/obstacle",
    "description": "What do the players see, hear, or experience right now?",
    "conditionsToClear": [
      "Condition 1 (e.g., 'Defeat the goblin ambush')",
      "Condition 2 (e.g., 'Negotiate with the goblin leader')"
    ],
    "potentialOutcomes": "What happens if they succeed or fail?"
  }
}`;

    // Check if Ollama is enabled
    if (config.OllamaConfig?.enabled) {
        return callOllama(prompt).then(res => {
            // callOllama already attempts to JSON.parse and returns an object if successful
            // so we don't need to parse it again if it's already an object
            return (typeof res === 'object') ? res : null;
        });
    }

    const modelName = String(config.LLM || '').toLowerCase();
    let provider = 'openai';

    if (modelName.includes('gemini')) {
        provider = 'gemini';
    } else if (modelName.includes('claude')) {
        provider = 'anthropic';
    } else if (modelName.includes('gpt') || modelName.includes('o1')) {
        provider = 'openai';
    } else {
        provider = process.env.AI_PROVIDER || 'openai';
    }

    let apiKey = null;
    if (provider === 'gemini') {
        apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    } else if (provider === 'anthropic') {
        apiKey = process.env.ANTHROPIC_API_KEY;
    } else {
        apiKey = process.env.OPENAI_API_KEY;
    }

    if (!apiKey) {
        apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    }

    if (!apiKey) {
        console.warn('-> AI Provider: No API key found in .env');
        return Promise.resolve(null);
    }

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
            // Strip out markdown if it exists
            if (typeof res === 'string' && res.includes('\`\`\`json')) {
                res = res.replace(/\`\`\`json/g, '').replace(/\`\`\`/g, '');
            }
            return typeof res === 'string' ? JSON.parse(res) : res;
        } catch (e) {
            console.error('Failed to parse next event JSON:', e);
            return null;
        }
    });
}

module.exports = { buildPrompt, callModel, generateNextEvent };
