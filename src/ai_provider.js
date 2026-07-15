const https = require('https');

function buildPrompt(transcript, context) {
    return `You are a highly creative and proactive Dungeon Master Assistant for a live D&D 5e session.
Your goal is to provide short, actionable guidance to the DM based on the live transcript and world context.

STRICT OUTPUT FORMAT:
Respond ONLY with a JSON object:
{
  "suggestion": "Your 2-4 sentence advice here",
  "isImportant": true/false,
  "reason": "Brief reason why this is important or why you are staying quiet"
}

GUIDELINES:
1. Be specific. Use the names of NPCs, locations, or items provided.
2. isImportant should be true ONLY if:
   - A player says something that triggers a specific world record or relationship.
   - You have a strong suggestion to keep the scene moving.
   - A rule needs clarification.
   - A significant plot beat is happening.
3. If the transcript is just small talk or routine combat, set isImportant to false.

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
