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

function summarizeTranscript(transcript, knowledgeIndex, relationships) {
    const normalizedTranscript = String(transcript || '').trim();
    const relevantRecords = (knowledgeIndex?.records || [])
        .filter((record) => {
            const haystack = `${record.category} ${record.name}`.toLowerCase();
            return normalizedTranscript.toLowerCase().split(/\s+/).some((word) => haystack.includes(word) && word.length > 3);
        })
        .slice(0, 5);

    const recentLinks = (relationships || []).slice(-3).map((entry) => `${entry.source} → ${entry.target}`);

    return {
        headline: normalizedTranscript ? normalizedTranscript.slice(0, 120) : 'No transcript captured yet.',
        transcript: normalizedTranscript,
        relevantRecords,
        recentLinks,
        advice: buildAdvice(normalizedTranscript, relevantRecords, recentLinks),
    };
}

function buildAdvice(transcript, relevantRecords, recentLinks) {
    const trimmed = transcript.trim();
    if (!trimmed) {
        return 'No speech has been captured yet. Keep listening for the next beat of the session.';
    }

    const recordHints = relevantRecords.length > 0
        ? `Relevant known records: ${relevantRecords.map((record) => `${record.category}: ${record.name}`).join(', ')}`
        : 'No obvious local record match was found in the current world context.';

    const linkHints = recentLinks.length > 0
        ? `Recent relationships: ${recentLinks.join('; ')}`
        : 'No relationships have been saved yet.';

    return `DM guidance: ${trimmed}\n${recordHints}\n${linkHints}\nSuggested next move: ask a clarifying question, foreshadow the next scene beat, or connect the player statement to one of the linked records.`;
}

function rememberSummary(summary) {
    const memory = loadMemory();
    memory.summaries.push({
        timestamp: new Date().toISOString(),
        summary,
    });
    memory.summaries = memory.summaries.slice(-20);
    saveMemory(memory);
    return memory;
}

module.exports = {
    buildAdvice,
    loadMemory,
    rememberSummary,
    summarizeTranscript,
};
