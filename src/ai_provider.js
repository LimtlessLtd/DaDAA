const https = require('https');

function buildPrompt(transcript, context) {
    return `You are a Dungeon Master assistant for a live D&D session.\n\nTranscript: ${transcript}\n\nContext:\n${context}\n\nRespond with a short, useful DM-facing suggestion in 2-4 sentences. Focus on keeping the scene moving, adding tension, or connecting the players' words to the world.`;
}

function callModel(prompt) {
    const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    const provider = process.env.AI_PROVIDER || 'openai';

    if (!apiKey) {
        return Promise.resolve(null);
    }

    if (provider === 'anthropic') {
        return callAnthropic(apiKey, prompt);
    }

    return callOpenAI(apiKey, prompt);
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
