const fs = require('fs');
const path = require('path');

const memoryPath = path.join(__dirname, '..', 'temp_data', 'ai_memory.json');
const sessionStatePath = path.join(__dirname, '..', 'temp_data', 'session_state.json');

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

function summarizeTranscript(transcript, knowledgeIndex) {
    const normalizedTranscript = String(transcript || '').trim();
    if (!normalizedTranscript) {
        return { transcript, relevantRecords: [], advice: 'No transcript provided.' };
    }

    const words = normalizedTranscript.toLowerCase()
        .replace(/[^a-z0-9\s]+/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 4 && !STOP_WORDS.has(w));

    const sessionState = loadLocalSessionState();
    const activeNpcs = (sessionState.activeNpcs || []).map(npc => npc.toLowerCase());
    const activeScene = (sessionState.activeScene || '').toLowerCase();

    const scoredRecords = [];

    (knowledgeIndex?.records || []).forEach((record) => {
        let score = 0;
        const nameLower = String(record.name || '').toLowerCase();
        const descLower = String(record.description || '').toLowerCase();
        const catLower = String(record.category || '').toLowerCase();

        // 1. Direct match on record name
        if (nameLower && nameLower.length > 3 && normalizedTranscript.toLowerCase().includes(nameLower)) {
            score += 15;
        }

        // 2. Active tracking boost
        if (activeScene && nameLower.includes(activeScene)) {
            score += 10;
        }
        activeNpcs.forEach(npc => {
            if (nameLower.includes(npc)) {
                score += 10;
            }
        });

        // 3. Token-based word matches
        words.forEach(word => {
            if (nameLower.includes(word)) {
                score += 5;
            } else if (descLower.includes(word)) {
                score += 2;
            } else if (catLower.includes(word)) {
                score += 1;
            }
        });

        if (score > 0) {
            scoredRecords.push({ record, score });
        }
    });

    const relevantRecords = scoredRecords
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(entry => entry.record);

    return {
        transcript: normalizedTranscript,
        relevantRecords,
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
    memory.summaries.push({
        timestamp: new Date().toISOString(),
        type: 'ai_insight',
        suggestion: aiResponse.suggestion,
        transcript: transcriptChunk,
        importance: aiResponse.isImportant
    });
    memory.summaries = memory.summaries.slice(-30);
    saveMemory(memory);
    return memory;
}

module.exports = {
    loadMemory,
    summarizeTranscript,
    rememberAiInsight,
    getRollingSummary,
    updateRollingSummary
};