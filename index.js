// index.js
// Implement as few discord commands as possible, it should mostly be driven by dashboard UI buttons and widgets.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinAndListen, speakText } = require('./src/voice_manager');
const { getVoiceConnection } = require('@discordjs/voice');
const { initializeWorldContext, appendTranscript, readTranscriptLog, buildDmSuggestion, loadSessionState, saveSessionState } = require('./src/context_manager');
const { rememberSummary, summarizeTranscript, rememberAiInsight, getRollingSummary, updateRollingSummary } = require('./src/ai_helper');
const { buildPrompt, callModel, generateNextEvent } = require('./src/ai_provider');
const { startWebEditor } = require('./src/web_editor');
const { loadSessionNotes, findTriggeredNotes } = require('./src/session_manager');
const { bindCharacter, unbindCharacter, getCharacterMapString, addCharacterLogs, loadCharacterLogs, recordDiscordUser, getPlayerLogsString } = require('./src/character_manager');
const config = require('./config.json');

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

// --- SILENCE DRIVER VARIABLES ---
let silenceTimer = null;
const SILENCE_TIMEOUT_MS = 45000; // 45 seconds of silence before the DM speaks up
let lastSpeechTimestamp = Date.now();

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

async function handleSilenceDriver() {
    console.log('-> Sustained silence detected. Prompting DM AI to drive the narrative...');
    if (!worldContext) return;

    // Treat silence as a "blank" transcript
    const fakeTranscript = "(Players are silent and awaiting the Dungeon Master's lead)";
    
    const summary = summarizeTranscript(fakeTranscript, worldContext.knowledgeIndex);
    const sessionState = loadSessionState();
    let currentEventString = '';
    const eventPath = path.join(TEMP_DATA_DIR, 'current_event.json');
    let currentEventData = { activeEvent: null, archivedEvents: [] };
    if (fs.existsSync(eventPath)) {
        try {
            currentEventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
            if (currentEventData.activeEvent) {
                currentEventString = `Active Event: ${currentEventData.activeEvent.title}\n${currentEventData.activeEvent.description}\nConditions: ${currentEventData.activeEvent.conditionsToClear?.join(', ')}`;
            }
        } catch(e) {}
    }
    const contextString = `
Current Scene: ${sessionState.activeScene || 'Unknown'}
Active NPCs: ${sessionState.activeNpcs?.join(', ') || 'None'}
Foundry Records: ${summary.relevantRecords.map((record) => `${record.category}: ${record.name}`).join('\n') || 'None'}
    `.trim();

    const rollingSummary = getRollingSummary();
    const characterMapStr = getCharacterMapString();
    const playerLogsStr = getPlayerLogsString();
    const prompt = buildPrompt(fakeTranscript, contextString, rollingSummary, characterMapStr, currentEventString, playerLogsStr);
    
    const activeModelName = config.LLM || 'Unknown Model';

    saveLlmDebug({
        timestamp: new Date().toISOString(),
        model: activeModelName,
        latencyMs: 0,
        transcript: "Silence",
        contextString: contextString,
        rollingSummary: rollingSummary,
        fullPrompt: prompt,
        rawResponse: { reason: "Silence Timeout Triggered" },
        stats: stats
    });

    const apiStartTime = Date.now();
    stats.llmCalls++;
    
    try {
        const aiReply = await callModel(prompt);
        const latency = Date.now() - apiStartTime;
        stats.lastLatencyMs = latency;
        
        if (aiReply) {
            console.log(`-> AI Silence evaluation: [Important: ${aiReply.isImportant}] Suggestion: ${aiReply.suggestion || 'None'}`);
            
            const isImportantInsight = aiReply.suggestion && !aiReply.isOOC; // Ignore importance flag for silence, force narrative
            if (isImportantInsight) {
                stats.importantInsights++;
                rememberAiInsight(aiReply, "Silence");
                sendDmToOwner(`DM guidance (Silence Driver):\n${aiReply.suggestion}`);
                
                if (aiReply.spokenNarrative) {
                    console.log(`-> TTS Queueing: "${aiReply.spokenNarrative}" [Voice: ${aiReply.voiceProfile || 'narrator'}]`);
                    speakText(aiReply.spokenNarrative, aiReply.voiceProfile);
                }
            }

            if (aiReply.characterLogs && Array.isArray(aiReply.characterLogs) && aiReply.characterLogs.length > 0) {
                addCharacterLogs(aiReply.characterLogs);
            }

            if (aiReply.eventResolved && currentEventData.activeEvent) {
                console.log(`-> Active Event Resolved (Silence Driver): ${currentEventData.activeEvent.title}`);
                sendDmToOwner(`Event Cleared: ${currentEventData.activeEvent.title}\nResolution: ${aiReply.resolutionSummary}`);
                
                currentEventData.archivedEvents.push({
                    title: currentEventData.activeEvent.title,
                    resolution: aiReply.resolutionSummary
                });
                if (currentEventData.archivedEvents.length > 100) {
                    currentEventData.archivedEvents.shift();
                }
                
                currentEventData.activeEvent = null;
                fs.writeFileSync(eventPath, JSON.stringify(currentEventData, null, 2), 'utf8');

                console.log('-> Generating new Active Event (Silence Driver)...');
                generateNextEvent(currentEventData.archivedEvents, rollingSummary, aiReply.resolutionSummary)
                    .then(newEventObj => {
                        if (newEventObj && newEventObj.activeEvent) {
                            currentEventData.activeEvent = newEventObj.activeEvent;
                            fs.writeFileSync(eventPath, JSON.stringify(currentEventData, null, 2), 'utf8');
                            console.log(`-> New Active Event Created: ${newEventObj.activeEvent.title}`);
                            sendDmToOwner(`New Event: ${newEventObj.activeEvent.title}\n${newEventObj.activeEvent.description}`);
                        }
                    }).catch(err => {
                        console.error('-> Failed to generate new event:', err);
                    });
            }
            
            saveLlmDebug({
                timestamp: new Date().toISOString(),
                model: activeModelName,
                latencyMs: latency,
                transcript: "Silence",
                contextString: contextString,
                rollingSummary: rollingSummary,
                fullPrompt: prompt,
                rawResponse: aiReply,
                stats: stats
            });
        }
    } catch (error) {
        console.warn('-> Silence Driver AI provider unavailable:', error.message);
    }
    
    // Automatically restart the timer for the next gap of silence
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(handleSilenceDriver, SILENCE_TIMEOUT_MS);
}

async function sendDmToOwner(content) {
    // Discord DM messaging disabled per user request
    return;
}

client.once('clientReady', () => {
    console.log(`-> DaDAA is ready and logged in as ${client.user.tag}`);
    startWebEditor();
    
    const activeModel = config.LLM;

    const hasKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

    // Write initial telemetry state so the debug panel doesn't appear empty at startup
    saveLlmDebug({
        timestamp: new Date().toISOString(),
        model: activeModel,
        latencyMs: 0,
        transcript: 'Awaiting first speech segment...',
        contextString: 'None',
        rollingSummary: 'None',
        fullPrompt: 'No transcripts evaluated yet.',
        rawResponse: { 
            reason: hasKey 
                ? 'Awaiting speech trigger...' 
                : 'ERROR: No API key found. Please create a .env file containing GEMINI_API_KEY or OPENAI_API_KEY or ANTHROPIC_API_KEY to activate live suggestions.' 
        },
        stats: stats
    });

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
                
                recordDiscordUser(sourceLabel);
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
                
                // --- RESET SILENCE TIMER ---
                lastSpeechTimestamp = Date.now();
                if (silenceTimer) {
                    clearTimeout(silenceTimer);
                }
                silenceTimer = setTimeout(handleSilenceDriver, SILENCE_TIMEOUT_MS);

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
                    let currentEventString = '';
                    const eventPath = path.join(TEMP_DATA_DIR, 'current_event.json');
                    let currentEventData = { activeEvent: null, archivedEvents: [] };
                    if (fs.existsSync(eventPath)) {
                        try {
                            currentEventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
                            if (currentEventData.activeEvent) {
                                currentEventString = `Active Event: ${currentEventData.activeEvent.title}\n${currentEventData.activeEvent.description}\nConditions: ${currentEventData.activeEvent.conditionsToClear?.join(', ')}`;
                            }
                        } catch(e) {}
                    }
                    const contextString = `
Current Scene: ${sessionState.activeScene || 'Unknown'}
Active NPCs: ${sessionState.activeNpcs?.join(', ') || 'None'}
Foundry Records: ${summary.relevantRecords.map((record) => `${record.category}: ${record.name}`).join('\n') || 'None'}
                    `.trim();

                    const rollingSummary = getRollingSummary();
                    const characterMapStr = getCharacterMapString();
                    const playerLogsStr = getPlayerLogsString();
                    const prompt = buildPrompt(transcript, contextString, rollingSummary, characterMapStr, currentEventString, playerLogsStr);
                    
                    const activeModelName = config.LLM || 'Unknown Model';

                    // Immediately write "Analyzing..." status so the user knows the AI is actively thinking!
                    saveLlmDebug({
                        timestamp: new Date().toISOString(),
                        model: activeModelName,
                        latencyMs: 0,
                        transcript: transcript,
                        contextString: contextString,
                        rollingSummary: rollingSummary,
                        fullPrompt: prompt,
                        rawResponse: { reason: "Analyzing speech in background... (In-flight API request)" },
                        stats: stats
                    });

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
                                    
                                    if (aiReply.spokenNarrative) {
                                        console.log(`-> TTS Queueing: "${aiReply.spokenNarrative}" [Voice: ${aiReply.voiceProfile || 'narrator'}]`);
                                        speakText(aiReply.spokenNarrative, aiReply.voiceProfile);
                                    }
                                }

                                if (aiReply.characterLogs && Array.isArray(aiReply.characterLogs) && aiReply.characterLogs.length > 0) {
                                    addCharacterLogs(aiReply.characterLogs);
                                }

                                if (aiReply.eventResolved && currentEventData.activeEvent) {
                                    console.log(`-> Active Event Resolved: ${currentEventData.activeEvent.title}`);
                                    sendDmToOwner(`Event Cleared: ${currentEventData.activeEvent.title}\nResolution: ${aiReply.resolutionSummary}`);
                                    
                                    currentEventData.archivedEvents.push({
                                        title: currentEventData.activeEvent.title,
                                        resolution: aiReply.resolutionSummary
                                    });
                                    // keep only last 100 archived events to avoid bloating context
                                    if (currentEventData.archivedEvents.length > 100) {
                                        currentEventData.archivedEvents.shift();
                                    }
                                    
                                    // Save the archived state first so UI updates immediately
                                    const oldTitle = currentEventData.activeEvent.title;
                                    currentEventData.activeEvent = null;
                                    fs.writeFileSync(eventPath, JSON.stringify(currentEventData, null, 2), 'utf8');

                                    // Trigger next event generation
                                    console.log('-> Generating new Active Event...');
                                    generateNextEvent(currentEventData.archivedEvents, rollingSummary, aiReply.resolutionSummary)
                                        .then(newEventObj => {
                                            if (newEventObj && newEventObj.activeEvent) {
                                                currentEventData.activeEvent = newEventObj.activeEvent;
                                                fs.writeFileSync(eventPath, JSON.stringify(currentEventData, null, 2), 'utf8');
                                                console.log(`-> New Active Event Created: ${newEventObj.activeEvent.title}`);
                                                sendDmToOwner(`New Event: ${newEventObj.activeEvent.title}\n${newEventObj.activeEvent.description}`);
                                            }
                                        }).catch(err => {
                                            console.error('-> Failed to generate new event:', err);
                                        });
                                }
                                
                                // Save full debug telemetry
                                saveLlmDebug({
                                    timestamp: new Date().toISOString(),
                                    model: activeModelName,
                                    latencyMs: latency,
                                    transcript: transcript,
                                    contextString: contextString,
                                    rollingSummary: rollingSummary,
                                    fullPrompt: prompt,
                                    rawResponse: aiReply,
                                    stats: stats
                                });
                            } else {
                                // Save empty/error telemetry when model returns null (e.g. unconfigured key)
                                saveLlmDebug({
                                    timestamp: new Date().toISOString(),
                                    model: activeModelName,
                                    latencyMs: 0,
                                    transcript: transcript,
                                    contextString: contextString,
                                    rollingSummary: rollingSummary,
                                    fullPrompt: prompt,
                                    rawResponse: { 
                                        isOOC: false,
                                        isImportant: false,
                                        suggestion: "Configure an API key in your .env file to enable live DM guidance.",
                                        reason: "The AI provider returned null or failed to run successfully."
                                    },
                                    stats: stats
                                });
                            }
                        })
                        .catch((error) => {
                            const latency = Date.now() - apiStartTime;
                            console.warn('-> AI provider unavailable:', error.message);
                            saveLlmDebug({
                                timestamp: new Date().toISOString(),
                                model: "API Error",
                                latencyMs: latency,
                                transcript: transcript,
                                contextString: contextString,
                                rollingSummary: rollingSummary,
                                fullPrompt: prompt,
                                rawResponse: { 
                                    isOOC: false,
                                    isImportant: false,
                                    suggestion: `Error: ${error.message}`,
                                    reason: "An exception occurred while connecting to the LLM endpoint."
                                },
                                stats: stats
                            });
                        });
                }
            });
            message.reply('Listening to the channel!');
            
            // --- START INITIAL SILENCE TIMER ---
            lastSpeechTimestamp = Date.now();
            if (silenceTimer) clearTimeout(silenceTimer);
            silenceTimer = setTimeout(handleSilenceDriver, SILENCE_TIMEOUT_MS);
            
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
            // --- CLEAR SILENCE TIMER ---
            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
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