// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinAndListen } = require('./src/voice_manager');
const { getVoiceConnection } = require('@discordjs/voice');
const { initializeWorldContext, appendTranscript, readTranscriptLog, buildDmSuggestion, loadSessionState, saveSessionState } = require('./src/context_manager');
const { rememberSummary, summarizeTranscript, rememberAiInsight, getRollingSummary, updateRollingSummary } = require('./src/ai_helper');
const { buildPrompt, callModel } = require('./src/ai_provider');
const { startWebEditor } = require('./src/web_editor');
const { loadSessionNotes, findTriggeredNotes } = require('./src/session_manager');

console.log('-> Starting DaDAA...');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
});

let worldContext = null;
let ownerUserId = process.env.BOT_OWNER_ID || null;
const TEMP_DATA_DIR = path.join(__dirname, 'temp_data');
const SESSION_REMINDERS_PATH = path.join(TEMP_DATA_DIR, 'session_reminders.json');
let transcriptCounter = 0;

let stats = {
    totalUtterances: 0,
    llmCalls: 0,
    importantInsights: 0,
    lastLatencyMs: 0
};

const LLM_DEBUG_PATH = path.join(TEMP_DATA_DIR, 'llm_debug.json');

function saveLlmDebug(debugInfo) {
    try {
        fs.mkdirSync(TEMP_DATA_DIR, { recursive: true });
        fs.writeFileSync(LLM_DEBUG_PATH, JSON.stringify(debugInfo, null, 2), 'utf8');
    } catch (e) {
        console.warn('-> Failed to save LLM debug info:', e.message);
    }
}

function saveSessionReminders(reminders) {
    fs.mkdirSync(TEMP_DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSION_REMINDERS_PATH, JSON.stringify(reminders, null, 2), 'utf8');
}

async function sendDmToOwner(content) {
    if (!ownerUserId) return;

    try {
        const user = await client.users.fetch(ownerUserId);
        if (user) await user.send(content);
    } catch (error) {
        console.warn('-> Unable to send DM to owner:', error.message);
    }
}

client.once('clientReady', () => {
    console.log(`-> DaDAA is ready and logged in as ${client.user.tag}`);
    startWebEditor();
    initializeWorldContext()
        .then((context) => {
            worldContext = context;
            console.log(`-> Loaded ${context.knowledgeIndex.records.length} local records into context.`);
        })
        .catch((error) => {
            console.error('-> Failed to load world context:', error);
        });
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    console.log('-> Message received:', message.content);

    if (message.content.startsWith('!scene ')) {
        const scene = message.content.slice(7).trim();
        const state = loadSessionState();
        state.activeScene = scene;
        saveSessionState(state);
        message.reply(`Active scene set to: **${scene}**`);
        return;
    }

    if (message.content.startsWith('!npc ')) {
        const npc = message.content.slice(5).trim();
        const state = loadSessionState();
        if (!state.activeNpcs) state.activeNpcs = [];
        if (state.activeNpcs.includes(npc)) {
            state.activeNpcs = state.activeNpcs.filter(n => n !== npc);
            message.reply(`Removed **${npc}** from active NPCs.`);
        } else {
            state.activeNpcs.push(npc);
            message.reply(`Added **${npc}** to active NPCs.`);
        }
        saveSessionState(state);
        return;
    }

    if (message.content === '!join') {
        const voiceChannel = message.member?.voice?.channel;
        if (voiceChannel) {
            joinAndListen(client, message.guild.id, voiceChannel.id, async (userId, transcript, startTime) => {
                let sourceLabel = userId;
                try {
                    const userObj = await client.users.fetch(userId);
                    if (userObj && (userObj.username || userObj.tag)) {
                        sourceLabel = userObj.username || userObj.tag;
                    }
                } catch (e) { /* fallback to id */ }
                
                appendTranscript(transcript, sourceLabel, startTime);
                
                stats.totalUtterances++;
                
                // Every 10 voice transcriptions, trigger a background update of the rolling session summary.
                transcriptCounter++;
                if (transcriptCounter >= 10) {
                    transcriptCounter = 0;
                    const log = readTranscriptLog();
                    const logLines = log.split('\n').filter(Boolean).slice(-15);
                    if (logLines.length > 0) {
                        updateRollingSummary(logLines).catch(err => console.warn('-> Rolling summary error:', err.message));
                    }
                }
                
                if (worldContext) {
                    const sessionNotes = loadSessionNotes();
                    const triggered = findTriggeredNotes(sessionNotes, transcript);
                    saveSessionReminders(triggered);
                    if (triggered.length > 0) {
                        const dmBody = triggered.map((note) => `Trigger: ${note.trigger}\nNote: ${note.note}`).join('\n\n');
                        console.log('-> Triggered session notes:', dmBody);
                        sendDmToOwner(`Session reminder triggered:\n${dmBody}`);
                    }

                    // UPDATED: No relationships argument
                    const summary = summarizeTranscript(transcript, worldContext.knowledgeIndex);

                    const sessionState = loadSessionState();
                    const contextString = `
Current Scene: ${sessionState.activeScene || 'Unknown'}
Active NPCs: ${sessionState.activeNpcs?.join(', ') || 'None'}
Foundry Records: ${summary.relevantRecords.map((record) => `${record.category}: ${record.name}`).join('\n') || 'None'}
                    `.trim();

                    const rollingSummary = getRollingSummary();
                    const prompt = buildPrompt(transcript, contextString, rollingSummary);
                    
                    const apiStartTime = Date.now();
                    stats.llmCalls++;
                    
                    callModel(prompt)
                        .then((aiReply) => {
                            const latency = Date.now() - apiStartTime;
                            stats.lastLatencyMs = latency;
                            
                            if (aiReply) {
                                // NEW: Log EVERYTHING, even if unimportant, so you know the AI is alive
                                console.log(`-> AI DM evaluation: [OOC: ${aiReply.isOOC}] [Important: ${aiReply.isImportant}] Suggestion: ${aiReply.suggestion || 'None'}`);
                                
                                const isImportantInsight = aiReply.suggestion && !aiReply.isOOC && aiReply.isImportant;
                                if (isImportantInsight) {
                                    stats.importantInsights++;
                                    rememberAiInsight(aiReply, transcript);
                                    sendDmToOwner(`DM guidance:\n${aiReply.suggestion}`);
                                }
                                
                                // Save full debug telemetry
                                saveLlmDebug({
                                    timestamp: new Date().toISOString(),
                                    model: process.env.AI_PROVIDER === 'anthropic' ? (process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest') : (process.env.OPENAI_MODEL || 'gpt-4o-mini'),
                                    latencyMs: latency,
                                    transcript: transcript,
                                    contextString: contextString,
                                    rollingSummary: rollingSummary,
                                    fullPrompt: prompt,
                                    rawResponse: aiReply,
                                    stats: stats
                                });
                            }
                        })
                        .catch((error) => console.warn('-> AI provider unavailable:', error.message));
                }
            });
            message.reply('Listening to the channel!');
        } else {
            message.reply('You need to be in a voice channel first!');
        }
        return;
    }

    if (message.content === '!leave') {
        const connection = getVoiceConnection(message.guild.id);
        if (connection) {
            connection.destroy();
            message.reply('Disconnected from voice channel.');
        } else {
            message.reply('I am not in a voice channel.');
        }
        return;
    }

    if (message.content === '!log') {
        message.reply(`Transcript log:\n${readTranscriptLog() || 'No transcript yet.'}`);
        return;
    }

    if (message.content === '!context') {
        if (!worldContext) {
            message.reply('World context has not loaded yet.');
            return;
        }

        const transcriptLog = readTranscriptLog();
        const latestTranscript = transcriptLog
            .split('\n')
            .filter(Boolean)
            .slice(-3) 
            .map(line => line.replace(/^\[[^\]]+\]\s+\[[^\]]+\]\s+/, ''))
            .join(' ') || 'No transcript yet.';

        const sessionState = loadSessionState();
        // UPDATED: No relationships argument
        const summary = summarizeTranscript(latestTranscript, worldContext.knowledgeIndex);
        
        const contextString = `
Current Scene: ${sessionState.activeScene || 'Unknown'}
Active NPCs: ${sessionState.activeNpcs?.join(', ') || 'None'}
Foundry Records: ${summary.relevantRecords.map((record) => `${record.category}: ${record.name}`).join('\n') || 'None'}
        `.trim();

        const rollingSummary = getRollingSummary();
        const prompt = buildPrompt(latestTranscript, contextString, rollingSummary);
        callModel(prompt)
            .then((aiReply) => {
                const reply = aiReply?.suggestion || summary.advice;
                message.reply(reply);
                sendDmToOwner(`Context request:\n${reply}`);
            });
        return;
    }

    if (message.content === '!dashboard') {
        message.reply('Open the dashboard at http://localhost:8000/dashboard.html');
        return;
    }
});

client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
    console.error('-> Login failed:', err);
});