const fs = require('fs');
const path = require('path');

const memoryPath = path.join(__dirname, '..', 'temp_data', 'ai_memory.json');

function ensureMemoryFile() {
    const dir = path.dirname(memoryPath);
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(memoryPath)) {
        fs.writeFileSync(memoryPath, JSON.stringify({ summaries: [] }, null, 2));
    }
}

function loadMemory() {
    ensureMemoryFile();
    try {
        return JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
    } catch (error) {
        return { summaries: [] };
    }
}

function saveMemory(memory) {
    ensureMemoryFile();
    fs.writeFileSync(memoryPath, JSON.stringify(memory, null, 2));
}

function summarizeTranscript(transcript, knowledgeIndex) {
    const normalizedTranscript = String(transcript || '').trim();
    
    // Lore Scan: Look for matches in name, category, or description
    const relevantRecords = (knowledgeIndex?.records || [])
        .filter((record) => {
            const fullText = `${record.category} ${record.name} ${record.description || ''}`.toLowerCase();
            return normalizedTranscript.toLowerCase().split(/\s+/).some((word) => 
                word.length > 4 && fullText.includes(word)
            );
        })
        .slice(0, 5);

    return {
        transcript: normalizedTranscript,
        relevantRecords,
        advice: buildAdvice(normalizedTranscript, relevantRecords),
    };
}

function buildAdvice(transcript, relevantRecords) {
    const recordHints = relevantRecords.length > 0
        ? `Foundry Lore Context: ${relevantRecords.map(r => `${r.name}: ${r.description?.slice(0, 100) || 'No description'}`).join(' | ')}`
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
    rememberAiInsight
};