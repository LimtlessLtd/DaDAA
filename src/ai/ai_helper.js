// src/ai/ai_helper.js
const fs = require('fs');
const path = require('path');
const { callModel } = require('./ai_provider');
const { callRagServer } = require('./context_manager');

const memoryPath = path.join(__dirname, '..', '..', 'temp_data', 'ai_memory.json');

function ensureMemoryFile() {
    const dir = path.dirname(memoryPath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(memoryPath)) {
        fs.writeFileSync(memoryPath, JSON.stringify({ summaries: [], rollingSummary: 'No key events recorded yet for this session.' }, null, 2));
    }
}

function loadMemory() {
    ensureMemoryFile();
    try {
        const data = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
        if (!data.rollingSummary) {
            data.rollingSummary = 'No key events recorded yet for this session.';
        }
        return data;
    } catch (error) {
        return { summaries: [], rollingSummary: 'No key events recorded yet for this session.' };
    }
}

function saveMemory(memory) {
    ensureMemoryFile();
    fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));
}

function getRollingSummary() {
    const memory = loadMemory();
    return memory.rollingSummary;
}

async function updateRollingSummary(newTranscriptLines) {
    const memory = loadMemory();
    const currentSummary = memory.rollingSummary || 'No key events recorded yet.';
    const linesText = newTranscriptLines.join('\n');

    const prompt = `
You are the Chronicle Archivist. Your job is to maintain a concise, high-level running summary of the D&D session based on the transcript log.

Current Running Summary:
"""
${currentSummary}
"""

New Transcript Segment:
"""
${linesText}
"""

STRICT GUIDELINES:
Update the Running Summary to include any new key events, actions, combat encounters, roleplaying developments, or items found. Maintain a short list of the most important developments. Keep it brief, atmospheric, and highly functional for an AI assistant. Eliminate clutter, jokes, or table talk. Output ONLY the new running summary text. Do not include any intro, outro, or wrapper formatting. Do not use bullet points or markdown lists.
`;

    try {
        const response = await callModel(prompt);
        let summaryText = '';
        if (response) {
            summaryText = response.suggestion || response || '';
        }
        if (summaryText && typeof summaryText === 'string') {
            memory.rollingSummary = summaryText.trim();
            saveMemory(memory);
            console.log('-> Updated rolling session summary:', memory.rollingSummary);
        }
    } catch (error) {
        console.warn('-> Failed to update rolling session summary:', error.message);
    }
}


function rememberAiInsight(aiResponse, transcriptChunk) {
    if (!aiResponse || aiResponse.isOOC || !aiResponse.isImportant) return null;

    let parsedSuggestion = aiResponse.suggestion;
    if (typeof parsedSuggestion === 'object' && parsedSuggestion !== null) {
        parsedSuggestion = parsedSuggestion.text || parsedSuggestion.message || JSON.stringify(parsedSuggestion);
    }

    const memory = loadMemory();
    const timestamp = new Date().toISOString();
    memory.summaries.push({
        timestamp,
        type: 'ai_insight',
        suggestion: parsedSuggestion,
        transcript: transcriptChunk,
        importance: aiResponse.isImportant
    });
    memory.summaries = memory.summaries.slice(-30);
    saveMemory(memory);

    if (callRagServer) {
        callRagServer('/add', {
            collection: 'dnd_insights',
            documents: [parsedSuggestion],
            metadatas: [{ timestamp, transcript: transcriptChunk || '' }],
            ids: [`insight_${Date.now()}_${Math.floor(Math.random() * 1000)}`]
        }).catch(() => {});
    }

    return memory;
}

module.exports = {
    loadMemory,
    rememberAiInsight,
    getRollingSummary,
    updateRollingSummary
};