const fs = require('fs');
const path = require('path');

const memoryPath = path.join(__dirname, '..', '..', 'temp_data', 'ai_memory.json');
const sessionStatePath = path.join(__dirname, '..', '..', 'temp_data', 'session_state.json');

const STOP_WORDS = new Set([
    'this', 'that', 'with', 'from', 'have', 'your', 'will', 'they', 'them', 'then', 
    'there', 'their', 'some', 'what', 'when', 'where', 'who', 'how', 'about', 'would', 
    'could', 'should', 'here', 'just', 'more', 'very', 'than', 'know', 'think', 'look', 
    'make', 'want', 'come', 'take', 'give', 'good', 'well', 'about', 'would', 'could'
]);

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
    // Local require to avoid circular dependency
    const { callModel } = require('./ai_provider');
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
1. Update the Running Summary to include any new key events, actions, combat encounters, roleplaying developments, or items found.
2. Maintain a bullet-pointed list (3-6 bullets maximum) of the most important developments.
3. Keep it brief, atmospheric, and highly functional for an AI assistant. Eliminate clutter, jokes, or table talk.
4. Output ONLY the new bulleted running summary text. Do not include any intro, outro, or wrapper formatting.
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

function loadLocalSessionState() {
    if (!fs.existsSync(sessionStatePath)) {
        return { activeScene: null, activeNpcs: [], activeQuests: [] };
    }
    try {
        return JSON.parse(fs.readFileSync(sessionStatePath, 'utf8'));
    } catch (e) {
        return { activeScene: null, activeNpcs: [], activeQuests: [] };
    }
}

// REMOVED knowledgeIndex argument — relies entirely on the RAG vector search now
async function summarizeTranscript(transcript) {
    const normalizedTranscript = String(transcript || '').trim();
    if (!normalizedTranscript) {
        return { transcript, relevantRecords: [], advice: 'No transcript provided.' };
    }

    const { findRelevantRecords } = require('./context_manager');
    const relevantRecords = await findRelevantRecords(normalizedTranscript);

    return {
        transcript: normalizedTranscript,
        relevantRecords: relevantRecords.slice(0, 5),
        advice: buildAdvice(normalizedTranscript, relevantRecords),
    };
}

function buildAdvice(transcript, relevantRecords) {
    const recordHints = relevantRecords.length > 0
        ? `Foundry Lore Context: ${relevantRecords.map(r => `${r.name}: ${r.description?.slice(0, 150) || 'No description'}`).join(' | ')}`
        : 'No specific lore found in database.';

    return `DM Guidance: ${transcript}\n${recordHints}\nSuggested next move: Use the lore context above to improvise the player's interaction.`;
}

function rememberAiInsight(aiResponse, transcriptChunk) {
    if (!aiResponse || aiResponse.isOOC || !aiResponse.isImportant) return null;

    const memory = loadMemory();
    const timestamp = new Date().toISOString();
    memory.summaries.push({
        timestamp,
        type: 'ai_insight',
        suggestion: aiResponse.suggestion,
        transcript: transcriptChunk,
        importance: aiResponse.isImportant
    });
    memory.summaries = memory.summaries.slice(-30);
    saveMemory(memory);

    // Save insight to RAG Database asynchronously
    const { callRagServer } = require('./context_manager');
    if (callRagServer) {
        callRagServer('/add', {
            collection: 'dnd_insights',
            documents: [aiResponse.suggestion],
            metadatas: [{ timestamp, transcript: transcriptChunk || '' }],
            ids: [`insight_${Date.now()}_${Math.floor(Math.random() * 1000)}`]
        }).catch(() => {});
    }

    return memory;
}

module.exports = {
    loadMemory,
    summarizeTranscript,
    rememberAiInsight,
    getRollingSummary,
    updateRollingSummary
};