// index.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinAndListen, speakText } = require('./src/voice/voice_manager');
const { getVoiceConnection } = require('@discordjs/voice');
const {
    initializeWorldContext,
    appendTranscript,
    readTranscriptLog,
    loadSessionState,
    saveSessionState,
    findRelevantRecords,
    addWorldEntities,
    callRagServer
} = require('./src/ai/context_manager');
const { rememberAiInsight, getRollingSummary, updateRollingSummary } = require('./src/ai/ai_helper');
const { buildPrompt, callModel, generateNextEvent, generateCampaignSeed } = require('./src/ai/ai_provider');
const { startWebEditor } = require('./src/web/web_editor');
const {
    isSessionZeroActive,
    addSessionZeroInput,
    endSessionZero
} = require('./src/sessions/session_manager');
const { addPendingCheck, resolvePendingCheck } = require('./src/sessions/check_manager');
const { isDiceMaidenMessage, parseDiceMaidenRoll, isDiceMaidenError } = require('./src/dice/dice_maiden');
const {
    bindCharacter,
    unbindCharacter,
    getCharacterMapString,
    addCharacterLogs,
    loadCharacterLogs,
    recordDiscordUser,
    recordDiscordNickname,
    resolveUsernameByNickname,
    getPlayerLogsString,
    getBoundCharacterName
} = require('./src/characters/character_manager');
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
const activeSpeakers = new Set();

const LLM_DEBUG_PATH = path.join(TEMP_DATA_DIR, 'llm_debug.json');

function saveLlmDebug(debugInfo) {
    try {
        fs.mkdirSync(TEMP_DATA_DIR, { recursive: true });
        fs.writeFileSync(LLM_DEBUG_PATH, JSON.stringify(debugInfo, null, 2), 'utf8');
    } catch (e) {
        console.warn('-> Failed to save LLM debug info:', e.message);
    }
}

// Deterministic backstop for check announcements: the prompt asks the model to state the skill
// and DC out loud in a dialogue segment (ai_provider.js guideline 6), but it doesn't always
// comply, leaving players unsure what they're rolling for. This runs unconditionally whenever a
// check is registered, so the requirement is always announced regardless of what was narrated.
function announceCheckRequirement(character, skill, dc) {
    const announcement = `${character}, make a ${skill} check - you need to beat a DC of ${dc}.`;
    console.log(`-> TTS Queueing (check announcement): "${announcement}"`);
    speakText(announcement, 'narrator');
    appendTranscript(announcement, 'Dungeon Master (narrator)', Date.now());
}

// Shared pipeline: build world context, call the LLM, and react to its reply.
// Used for real transcribed speech, the silence driver's synthetic prompt, and
// dice-roll resolutions - anywhere a "DM turn" needs to happen.
async function runDmTurn(transcript) {
    if (!worldContext) return null;

    const relevantRecords = await findRelevantRecords(transcript);
    const sessionState = loadSessionState();

    let currentEventString = '';
    const eventPath = path.join(TEMP_DATA_DIR, 'current_event.json');
    let currentEventData = { activeEvent: null, archivedEvents: [] };
    if (fs.existsSync(eventPath)) {
        try {
            currentEventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
            if (currentEventData.activeEvent) {
                currentEventString = `Active Event: ${currentEventData.activeEvent.title}\nDescription: ${currentEventData.activeEvent.description}\nStakes: ${currentEventData.activeEvent.stakes || 'Unknown'}\nComplication: ${currentEventData.activeEvent.complication || 'None'}\nCurrent State (most recent - overrides Description above wherever they conflict): ${currentEventData.activeEvent.currentState || 'No changes yet - Description above is still accurate.'}`;
            }
        } catch (e) {}
    }

    const contextString = `
Current Scene: ${sessionState.activeScene || 'Unknown'}
Active NPCs: ${sessionState.activeNpcs?.join(', ') || 'None'}
Records: ${relevantRecords.map((record) => `${record.category}${record.secret ? ' [SECRET]' : ''}: ${record.name} - ${(record.description || 'No description').slice(0, 300)}`).join('\n') || 'None'}
    `.trim();

    const rollingSummary = getRollingSummary();
    const characterMapStr = getCharacterMapString();
    const playerLogsStr = getPlayerLogsString();
    const prompt = buildPrompt(transcript, contextString, rollingSummary, characterMapStr, currentEventString, playerLogsStr);

    const activeModelName = config.OllamaConfig?.enabled
        ? config.OllamaConfig?.model || 'neural-chat'
        : config.LLM || 'Unknown Model';

    saveLlmDebug({
        timestamp: new Date().toISOString(),
        model: activeModelName,
        latencyMs: 0,
        transcript: transcript,
        contextString: contextString,
        rollingSummary: rollingSummary,
        fullPrompt: prompt,
        rawResponse: { reason: "Analyzing... (in-flight API request)" },
        stats: stats
    });

    const apiStartTime = Date.now();
    stats.llmCalls++;

    try {
        const aiReply = await callModel(prompt);
        const latency = Date.now() - apiStartTime;
        stats.lastLatencyMs = latency;

        if (aiReply) {
            console.log('-> AI evaluation:', JSON.stringify(aiReply));

            if (aiReply.dialogue && Array.isArray(aiReply.dialogue)) {
                for (const segment of aiReply.dialogue) {
                    if (!segment || !segment.text) continue;
                    const speaker = segment.speaker || 'narrator';
                    console.log(`-> TTS Queueing: "${segment.text}" [Speaker: ${speaker}]`);
                    speakText(segment.text, speaker, segment.voiceDescription);
                    appendTranscript(segment.text, `Dungeon Master (${speaker})`, Date.now());
                }
            }

            const isImportantInsight = aiReply.suggestion && !aiReply.isOOC && aiReply.isImportant;
            if (isImportantInsight) {
                stats.importantInsights++;
                rememberAiInsight(aiReply, transcript);
            }

            if (aiReply.characterLogs && Array.isArray(aiReply.characterLogs) && aiReply.characterLogs.length > 0) {
                addCharacterLogs(aiReply.characterLogs);
            }

            if (aiReply.worldEntities && Array.isArray(aiReply.worldEntities) && aiReply.worldEntities.length > 0) {
                addWorldEntities(aiReply.worldEntities).catch(err => console.warn('-> Failed to save world entities:', err.message));
            }

            if (aiReply.checkCharacter && aiReply.checkSkill && aiReply.checkDc) {
                const check = addPendingCheck(aiReply.checkCharacter, aiReply.checkSkill, aiReply.checkDc);
                if (check) {
                    console.log(`-> Pending check registered: ${check.character} - ${check.skill} DC ${check.dc}`);
                    announceCheckRequirement(check.character, check.skill, check.dc);
                }
            }

            if (currentEventData.activeEvent && aiReply.eventStatus) {
                const status = aiReply.eventStatus.toLowerCase();
                console.log(`-> Event Evaluation [${currentEventData.activeEvent.title}]: ${status.toUpperCase()}`);

                if (status === 'resolved') {
                    console.log(`-> Active Event Resolved: ${currentEventData.activeEvent.title}`);

                    currentEventData.archivedEvents.push({
                        title: currentEventData.activeEvent.title,
                        resolution: aiReply.resolutionSummary,
                        endedAt: new Date().toISOString()
                    });
                    currentEventData.activeEvent = null;
                    fs.writeFileSync(eventPath, JSON.stringify(currentEventData, null, 2), 'utf8');

                    generateNextEvent(currentEventData.archivedEvents, rollingSummary, aiReply.resolutionSummary)
                        .then(newEventObj => {
                            if (newEventObj && newEventObj.activeEvent) {
                                currentEventData.activeEvent = newEventObj.activeEvent;
                                fs.writeFileSync(eventPath, JSON.stringify(currentEventData, null, 2), 'utf8');
                            }
                        }).catch(err => console.error('-> Failed to generate new event:', err));

                } else {
                    // "stable", "escalated", or "evolved" - the event is still active, but the scene's
                    // physical state may still have changed this turn (an item taken/destroyed, an NPC
                    // killed, etc). Persist that regardless of status so the next turn's prompt doesn't
                    // contradict something that already happened - previously this was only captured on
                    // escalate/evolve, so "stable" turns silently dropped state changes entirely.
                    if (aiReply.resolutionSummary) {
                        currentEventData.activeEvent.currentState = aiReply.resolutionSummary;
                    }

                    if (status === 'escalated' || status === 'evolved') {
                        currentEventData.activeEvent.complication = aiReply.resolutionSummary || currentEventData.activeEvent.complication;
                        console.log(`⚠️ Event Shifted (${status}): ${currentEventData.activeEvent.title} New Twist: ${currentEventData.activeEvent.complication}`);
                    }

                    fs.writeFileSync(eventPath, JSON.stringify(currentEventData, null, 2), 'utf8');
                }
            }

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

        return aiReply;
    } catch (error) {
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
        return null;
    }
}

// The one and only player-idea-driven Session Zero flow. While active, every transcribed
// utterance comes here instead of runDmTurn() - buffered as raw world-building input, not
// reacted to as in-character speech. When a player signals they're done, this generates the
// actual campaign (intro lore + public/secret NPCs/locations/lore) from what was said, saves
// it, reads the introduction aloud, then generates and announces the opening event for
// Session 1. Triggered by real voice input; started by /api/start_campaign (see
// web_editor.js), which only wipes old data and kicks off listening.
const SESSION_ZERO_FINISH_REGEX = /(we('re| are) (done|finished|good|set))|(that's (it|all))|(all done)|(generate (it|the world) now)|(let's start)/i;

async function handleSessionZeroInput(sourceLabel, transcript) {
    addSessionZeroInput(sourceLabel, transcript);

    if (!SESSION_ZERO_FINISH_REGEX.test(transcript)) return;

    const compiledIdeas = endSessionZero();
    console.log('-> Session Zero complete. Generating campaign from player ideas...');

    let seed = null;
    try {
        seed = await generateCampaignSeed(compiledIdeas);
    } catch (err) {
        console.warn('-> Campaign seed generation failed:', err.message);
    }

    if (!seed) {
        speakText("Something went wrong generating the world. Please check the AI provider is configured and reachable, then start the campaign again.");
        return;
    }

    if (seed.introLore) {
        await callRagServer('/add', {
            collection: 'dnd_knowledge',
            documents: [seed.introLore],
            metadatas: [{ source: 'campaign_seed', category: 'lore', name: 'Campaign Introduction' }],
            ids: ['campaign_intro']
        }).catch(() => {});

        // Also kept as a plain file so the dashboard can display it without needing to
        // query the RAG server.
        try {
            fs.writeFileSync(
                path.join(TEMP_DATA_DIR, 'campaign_intro.json'),
                JSON.stringify({ text: seed.introLore, generatedAt: new Date().toISOString() }, null, 2),
                'utf8'
            );
        } catch (e) {
            console.warn('-> Failed to save campaign_intro.json:', e.message);
        }
    }

    if (Array.isArray(seed.worldEntities)) {
        await addWorldEntities(seed.worldEntities);
    }

    if (seed.introLore) {
        console.log('-> Speaking campaign introduction...');
        speakText(seed.introLore, 'narrator');
        appendTranscript(seed.introLore, 'Dungeon Master (narrator)', Date.now());
    }

    try {
        const eventObj = await generateNextEvent(
            [],
            seed.introLore || 'A new campaign has just begun.',
            'The players have just finished Session Zero and are ready to begin their first scene.'
        );

        if (eventObj && eventObj.activeEvent) {
            const eventPath = path.join(TEMP_DATA_DIR, 'current_event.json');
            fs.writeFileSync(eventPath, JSON.stringify({ activeEvent: eventObj.activeEvent, archivedEvents: [] }, null, 2), 'utf8');

            const announcement = `Session One begins. ${eventObj.activeEvent.description}`;
            console.log('-> Announcing opening event:', eventObj.activeEvent.title);
            speakText(announcement, 'narrator');
            appendTranscript(announcement, 'Dungeon Master (narrator)', Date.now());
        }
    } catch (err) {
        console.warn('-> Failed to generate opening event:', err.message);
    }
}

async function handleSilenceDriver() {
    console.log('-> Sustained silence detected. Prompting DM AI to drive the narrative...');

    if (isSessionZeroActive()) return;

    const fakeTranscript = "(Players are silent and awaiting the Dungeon Master's lead)";
    await runDmTurn(fakeTranscript);

    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(handleSilenceDriver, SILENCE_TIMEOUT_MS);
}

// Attributing a Dice Maiden roll to a player: prefer Discord's own interaction metadata
// (the invoking user, when Dice Maiden replied to a real slash-command interaction) since
// it's unambiguous; fall back to the display name Dice Maiden prints in the message itself,
// resolved through the nickname map recorded during voice transcription.
async function handleDiceMaidenRoll(message) {
    if (isDiceMaidenError(message.content)) {
        console.log('-> Dice Maiden rejected an invalid roll expression, ignoring:', message.content);
        return;
    }

    const roll = parseDiceMaidenRoll(message.content);
    if (!roll) {
        console.warn('-> Could not parse Dice Maiden message:', message.content);
        return;
    }

    const interactionUser = message.interactionMetadata?.user || message.interaction?.user;
    let username = interactionUser ? (interactionUser.username || interactionUser.tag) : null;
    if (!username && roll.rollerDisplayName) {
        username = resolveUsernameByNickname(roll.rollerDisplayName);
    }

    if (!username) {
        console.warn(`-> Dice roll could not be attributed to a player: "${message.content}"`);
        return;
    }

    const character = getBoundCharacterName(username);
    if (!character) {
        console.log(`-> Dice roll from ${username} (${roll.notation || 'dice'}: ${roll.total}) - no bound character, skipping.`);
        return;
    }

    const pending = resolvePendingCheck(character);
    if (!pending) {
        appendTranscript(`${character} rolled ${roll.notation || 'dice'}: ${roll.total} (no pending check)`, 'Dice', Date.now());
        return;
    }

    // Natural 20/1 override the DC math entirely (house rule) - a high-modifier character
    // can still fumble, and a poorly-built one can still pull off the impossible.
    let success = roll.total >= pending.dc;
    let outcomeLabel = success ? 'SUCCESS' : 'FAILURE';
    if (roll.isCriticalSuccess) {
        success = true;
        outcomeLabel = 'CRITICAL SUCCESS (NATURAL 20)';
    } else if (roll.isCriticalFailure) {
        success = false;
        outcomeLabel = 'CRITICAL FAILURE (NATURAL 1)';
    }

    const resultLine = `${character} rolled ${roll.total} for ${pending.skill} (DC ${pending.dc}): ${outcomeLabel}`;
    console.log(`-> ${resultLine}`);
    appendTranscript(resultLine, 'Dice', Date.now());

    runDmTurn(`[Dice Roll Result] ${resultLine}`);
}

client.once('clientReady', () => {
    console.log(`-> DaDAA is ready and logged in as ${client.user.tag}`);
    startWebEditor();
    
    const activeModel = config.OllamaConfig?.enabled 
        ? config.OllamaConfig?.model || 'neural-chat' 
        : config.LLM;
    const ollamaEnabled = config.OllamaConfig?.enabled || false;
    const hasKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

    if (ollamaEnabled) {
        console.log(`-> LLM Provider: Ollama (${config.OllamaConfig?.model || 'neural-chat'}) at ${config.OllamaConfig?.baseUrl || 'http://localhost:11434'}`);
    } else {
        const availableProviders = [];
        if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) availableProviders.push('Gemini');
        if (process.env.ANTHROPIC_API_KEY) availableProviders.push('Anthropic');
        if (process.env.OPENAI_API_KEY) availableProviders.push('OpenAI');
    
        if (availableProviders.length > 0) {
            console.log(`-> LLM Provider: Cloud (${availableProviders.join(' > ')})`);
        } else {
            console.warn(`-> WARNING: No LLM provider configured! Ollama is disabled and no cloud API keys found.`);
            console.warn(`-> The bot will run but AI responses will be disabled.`);
        }
    }

    const anyProviderAvailable = ollamaEnabled || hasKey;

    saveLlmDebug({
        timestamp: new Date().toISOString(),
        model: activeModel,
        latencyMs: 0,
        transcript: 'Awaiting first speech segment...',
        contextString: 'None',
        rollingSummary: 'None',
        fullPrompt: 'No transcripts evaluated yet.',
        rawResponse: { 
            reason: anyProviderAvailable
                ? 'Awaiting speech trigger...' 
                : 'ERROR: No LLM provider configured. Enable Ollama or add cloud API keys to activate AI responses.'
        },
        stats: stats,
        providerAvailable: anyProviderAvailable
    });

    initializeWorldContext()
        .then((context) => {
            worldContext = context;
            console.log(`-> Local World Context and RAG Engine initialized successfully.`);
        })
        .catch((error) => {
            console.error('-> Failed to load world context:', error);
        });
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) {
        if (isDiceMaidenMessage(message)) {
            await handleDiceMaidenRoll(message);
        }
        return;
    }

    if (message.content === '!join') {
        const voiceChannel = message.member?.voice?.channel;
        if (voiceChannel) {
            joinAndListen(client, message.guild.id, voiceChannel.id, async (userId, transcript, startTime) => {
                let sourceLabel = userId;
                let discordName = userId;

                try {
                    const member = await message.guild.members.fetch(userId).catch(() => null);
                    const userObj = member?.user || await client.users.fetch(userId);
                    if (userObj && (userObj.username || userObj.tag)) {
                        discordName = userObj.username || userObj.tag;

                        const charName = getBoundCharacterName(discordName);
                        sourceLabel = charName ? charName : discordName;

                        // Dice Maiden replies use the server nickname, not the account
                        // username - capture the mapping here so roll matching can resolve it later.
                        const nickname = member?.nickname || member?.displayName;
                        if (nickname) recordDiscordNickname(nickname, discordName);
                    }
                } catch (e) { /* fallback to id */ }

                console.log(`\n[Audio Transcribed] ${sourceLabel} (${discordName}): "${transcript}"`);

                recordDiscordUser(discordName);
                appendTranscript(transcript, sourceLabel, Date.now());
                
                stats.totalUtterances++;
                
                transcriptCounter++;
                if (transcriptCounter >= 10) {
                    transcriptCounter = 0;
                    const log = readTranscriptLog();
                    const logLines = log.split('\n').filter(Boolean).slice(-15);
                    if (logLines.length > 0) {
                        updateRollingSummary(logLines).catch(err => console.warn('-> Rolling summary error:', err.message));
                    }
                }
                
                lastSpeechTimestamp = Date.now();
                if (silenceTimer) {
                    clearTimeout(silenceTimer);
                    silenceTimer = null;
                }
                if (activeSpeakers.size === 0) {
                    silenceTimer = setTimeout(handleSilenceDriver, SILENCE_TIMEOUT_MS);
                }

                if (isSessionZeroActive()) {
                    handleSessionZeroInput(sourceLabel, transcript);
                } else if (worldContext) {
                    runDmTurn(transcript);
                }
            });
            message.reply('Listening to the channel!');
            
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
            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
        } else {
            message.reply('I am not in a voice channel.');
        }
        return;
    }

});

client.on('dndSpeechStart', (userId) => {
    activeSpeakers.add(userId);
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
});

client.on('dndSpeechEnd', (userId) => {
    activeSpeakers.delete(userId);
    if (activeSpeakers.size === 0) {
        lastSpeechTimestamp = Date.now();
        if (silenceTimer) {
            clearTimeout(silenceTimer);
        }
        silenceTimer = setTimeout(handleSilenceDriver, SILENCE_TIMEOUT_MS);
    }
});

client.login(process.env.DISCORD_BOT_TOKEN).catch((err) => {
    console.error('-> Login failed:', err);
});