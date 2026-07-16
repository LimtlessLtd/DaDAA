const https = require('https');
const config = require('../config.json');

function buildPrompt(transcript, context, rollingSummary = '', characterMapString = '', nextSessionPlan = '', playerLogsString = '') {
    return `You are the Dungeon Master. You are a creative, narrative-focused Dungeon Master who has a deep understanding of the world and its lore. 
Your goal is to enhance the session atmosphere, keep players immersed and to run a consistent Dungeons and Dragons world. You run the world, you decide what NPCs the players encounter, who the NPCs attack, what world events happen. All the things a good Dungeon Master does.

STRICT OUTPUT FORMAT:
Respond ONLY with a JSON object:
{
  "isOOC": true/false,
  "isImportant": true/false,
  "suggestion": "Your 2-4 sentence advice here",
  "reason": "Why this is important",
  "spokenNarrative": "Optional: Write a compelling line of dialogue or narrative for the DM to speak aloud to the players, or leave empty if nothing needs to be said right now.",
  "voiceProfile": "Optional: One of [narrator, goblin, old_man, female, monster] to match the character speaking. Default is narrator.",
  "characterLogs": [
    {
      "character": "Character Name",
      "log": "A brief description of the event, trauma, NPC interaction, or plot point",
      "type": "trauma | relationship | plot"
    }
  ]
}

GUIDELINES:
1. Lore Deep-Dive: If the World Context contains major figures (Gods, important NPCs, legendary items or locations), prioritize mentioning them. 
2. Narrative Hooks: If a God or major lore entity is mentioned, provide a specific, atmospheric reaction or a potential consequence (e.g., "The air grows hot," or "A local priest notices this blasphemy").
3. is Out Of Character (OOC): Set "isOOC" to true if the live transcript contains purely real-world discussion, rule disputes, jokes, side talk, food orders, or mechanical banter that does not progress the in-game scene or lore.
4. isImportant (The Critical Importance Filter): Set "isImportant" to true ONLY under the following high-stakes triggers:
   - When players are asking or doing something that requires a skill check (Athletics, Arcana, Stealth, etc.).
   - When players mention or interact with major local lore objects, gods, relics, active scenes, or active NPCs provided in the context.
   - When there is a tactical opportunity, threat, combat trigger, or puzzle solution.
   - When the player makes a critical choice that should have immediate environmental or lore consequences.
   - When the transcript says "(Players are silent and awaiting the Dungeon Master's lead)" you MUST set isImportant to true and provide narrative to progress the scene!
   Otherwise, set "isImportant" to false so the DM is not distracted by routine roleplay or basic descriptions.
5. In-Character Speech (spokenNarrative): If isImportant is true, you can optionally provide a "spokenNarrative". This string will be converted to Text-to-Speech and played directly into the Discord channel. Write it in the tone of a mysterious, dramatic Dungeon Master. Keep it under 2 sentences. 
6. Voice Profiles: If spokenNarrative is provided, specify the "voiceProfile" to match the speaker (e.g., "goblin" for a squeaky voice, "old_man" for a slow voice).
7. Character Logs: If the transcript contains a major character development, traumatic experience, notable NPC interaction, or major plot event for a player character, log it in "characterLogs". Leave it as an empty array [] if nothing major happened to a character in this transcript segment. Use the Discord User to Character Map to understand which character is acting based on the speaker.
8. DM Intent & Planning: Use the "Next Session Plan" to guide your suggestions and reactions to help the DM subtly steer or prepare the players for their planned upcoming events.

Next Session Plan (DM's intent and plans for the future):
${nextSessionPlan || 'No plan provided for the next session.'}

Short-Term Session Memory (Rolling Summary of previous key events):
${rollingSummary || 'No major events have occurred yet in this session.'}

Discord User to Character Map:
${characterMapString || 'No players mapped yet.'}

Player Logs (Meta actions by players):
${playerLogsString || 'No player actions logged.'}

World Context:
${context}

Live Transcript:
"${transcript}"`;
}

function callModel(prompt) {
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

function generateNextSessionPlan(rollingSummary, transcriptLog) {
    const prompt = `You are an expert Dungeon Master assistant. Based on the session's rolling summary and recent transcript log, generate a concise plan for the next session. This plan will guide the DM and the AI in preparing and providing suggestions next time.

Rolling Summary:
${rollingSummary || 'No major events recorded.'}

Recent Transcript Log:
${transcriptLog || 'No transcript available.'}

Generate a short bulleted list of plans, unresolved threads, and likely upcoming encounters. Do NOT wrap in JSON, just output the plan as plain text.`;

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
        return Promise.resolve('No API key configured.');
    }

    if (provider === 'gemini') {
        return callGemini(apiKey, prompt);
    }

    if (provider === 'anthropic') {
        return callAnthropic(apiKey, prompt);
    }

    return callOpenAI(apiKey, prompt);
}

module.exports = { buildPrompt, callModel, generateNextSessionPlan };
