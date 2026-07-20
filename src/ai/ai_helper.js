// src/ai/ai_helper.js
const fs = require('fs');
const path = require('path');
const { isSessionZeroActive, addSessionZeroInput, endSessionZero } = require('../sessions/session_manager');
const { callModel, generateNextEvent } = require('./ai_provider');
const { callRagServer } = require('./context_manager');

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

async function processSessionZeroIntent(source, text) {
    if (!isSessionZeroActive()) return false;

    addSessionZeroInput(source, text);

    const finishIntentRegex = /(we (are|'re) (done|finished|good|set))|(that's (it|all))|(all done)|(generate (it|the world) now)|(let's start)/i;
    
    if (finishIntentRegex.test(text)) {
        const compiledIdeas = endSessionZero();
        console.log('-> Session Zero complete. Generating lore...');
        
        const prompt = `You are an expert dungeon master. Generate a cohesive world setting based on the following player ideas:
        
        ${compiledIdeas}
        
        Write one paragraph for the geography, followed by one paragraph for the factions, and one paragraph for the recent history. Do not use bullet points or markdown lists in your response. Output only the lore paragraphs.`;
        
        try {
            const response = await callModel(prompt);
            const loreText = response.suggestion || response || '';
            
            if (loreText) {
                if (callRagServer) {
                    await callRagServer('/add', {
                        collection: 'dnd_knowledge',
                        documents: [loreText],
                        metadatas: [{ category: 'lore', name: 'World Setting', source: 'Session Zero' }],
                        ids: [`lore_${Date.now()}`]
                    });
                    console.log('-> Lore saved to ChromaDB.');
                }
                
                const eventObj = await generateNextEvent([], 'New Campaign started. Players just created the world.', 'Generate an introduction session event.');
                const eventPath = path.join(__dirname, '..', '..', 'temp_data', 'current_event.json');
                fs.writeFileSync(eventPath, JSON.stringify({ activeEvent: eventObj.activeEvent, archivedEvents: [] }, null, 2), 'utf8');
                console.log('-> Intro event generated.');
            }
        } catch(e) {
            console.error('-> Lore generation failed:', e.message);
        }
    }
    return true; 
}

async function summarizeTranscript(transcript, source = 'System') {
    const normalizedTranscript = String(transcript || '').trim();
    if (!normalizedTranscript) {
        return { transcript, relevantRecords: [], advice: 'No transcript provided.' };
    }

    const handledBySessionZero = await processSessionZeroIntent(source, normalizedTranscript);
    if (handledBySessionZero) {
        return { transcript: normalizedTranscript, relevantRecords: [], advice: 'Session Zero active. Buffering ideas.' };
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
    summarizeTranscript,
    rememberAiInsight,
    getRollingSummary,
    updateRollingSummary,
    processSessionZeroIntent
};