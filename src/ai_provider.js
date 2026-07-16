const https = require('https');

function buildPrompt(transcript, context) {
    return `You are the Dungeon Master. You are a creative, narrative-focused Dungeon Master who has a deep understanding of the world and its lore. 
Your goal is to enhance the session atmosphere, keep players immersed to run a consistent Dungeons and Dragons world.

STRICT OUTPUT FORMAT:
Respond ONLY with a JSON object:
{
  "isOOC": true/false,
  "isImportant": true/false,
  "suggestion": "Your 2-4 sentence advice here",
  "reason": "Why this is important"
}

GUIDELINES:
1. Lore Deep-Dive: If the World Context contains major figures (Gods, important NPCs, legendary items or locations), prioritize mentioning them. 
2. Narrative Hooks: If a God or major lore entity is mentioned, provide a specific, atmospheric reaction or a potential consequence (e.g., "The air grows hot," or "A local priest notices this blasphemy").
3. is Out Of Character (OOC): Ignore table talk, but be active if the conversation is lore-heavy.

World Context:
${context}

Live Transcript:
"${transcript}"`;
}

function callModel(prompt) {
    const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    const provider = process.env.AI_PROVIDER || 'openai';

    if (!apiKey) {
        console.warn('-> AI Provider: No API key found in .env');
        return Promise.resolve(null);
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

function callOpenAI(apiKey, prompt) {
    const body = JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
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
        return text || null;
    });
}

function callAnthropic(apiKey, prompt) {
    const body = JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
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
        return text || null;
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
                    resolve(parsed);
                } catch (error) {
                    reject(new Error(`Invalid JSON response: ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

module.exports = { buildPrompt, callModel };
