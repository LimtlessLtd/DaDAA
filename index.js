// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits } = require('discord.js');
const { joinAndListen } = require('./src/voice_manager');
const { getVoiceConnection } = require('@discordjs/voice');
const { initializeWorldContext, addRelationship, appendTranscript, readTranscriptLog, buildDmSuggestion } = require('./src/context_manager');
const { rememberSummary, summarizeTranscript } = require('./src/ai_helper');
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

function saveSessionReminders(reminders) {
    fs.mkdirSync(TEMP_DATA_DIR, { recursive: true });
    fs.writeFileSync(SESSION_REMINDERS_PATH, JSON.stringify(reminders, null, 2), 'utf8');
}

async function sendDmToOwner(content) {
    if (!ownerUserId) {
        return;
    }

    try {
        const user = await client.users.fetch(ownerUserId);
        if (user) {
            await user.send(content);
        }
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

    if (message.content === '!join') {
        const voiceChannel = message.member?.voice?.channel;
        if (voiceChannel) {
            joinAndListen(client, message.guild.id, voiceChannel.id, async (userId, transcript) => {
                appendTranscript(transcript, userId);
                if (worldContext) {
                    const sessionNotes = loadSessionNotes();
                    const triggered = findTriggeredNotes(sessionNotes, transcript);
                    saveSessionReminders(triggered);
                    if (triggered.length > 0) {
                        const dmBody = triggered.map((note) => `Trigger: ${note.trigger}\nNote: ${note.note}`).join('\n\n');
                        console.log('-> Triggered session notes:', dmBody);
                        sendDmToOwner(`Session reminder triggered:\n${dmBody}`);
                    }

                    const summary = summarizeTranscript(transcript, worldContext.knowledgeIndex, worldContext.relationships);
                    rememberSummary(summary);
                    const prompt = buildPrompt(transcript, `${summary.relevantRecords.map((record) => `${record.category}: ${record.name}`).join('\n') || 'No local records matched.'}\n\nRelationships:\n${summary.recentLinks.join('\n') || 'None'}`);
                    callModel(prompt)
                        .then((aiReply) => {
                            if (aiReply) {
                                console.log(`-> AI DM reply: ${aiReply}`);
                                sendDmToOwner(`DM guidance:\n${aiReply}`);
                            }
                        })
                        .catch((error) => console.warn('-> AI provider unavailable:', error.message));
                    const suggestion = buildDmSuggestion(transcript, worldContext.knowledgeIndex, worldContext.relationships);
                    console.log(`-> DM suggestion: ${suggestion}`);
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

    if (message.content.startsWith('!link ')) {
        if (!worldContext) {
            message.reply('World context has not loaded yet.');
            return;
        }

        const parts = message.content.slice(6).split('|').map((part) => part.trim());
        if (parts.length < 2) {
            message.reply('Format: !link <source> | <target> [type]');
            return;
        }

        const [source, target, type = 'related'] = parts;
        const sourceRecord = worldContext.knowledgeIndex.records.find((record) =>
            `${record.category}: ${record.name}`.toLowerCase().includes(source.toLowerCase())
        );
        const targetRecord = worldContext.knowledgeIndex.records.find((record) =>
            `${record.category}: ${record.name}`.toLowerCase().includes(target.toLowerCase())
        );

        if (!sourceRecord || !targetRecord) {
            message.reply('I could not resolve those records from the local Foundry data.');
            return;
        }

        addRelationship(worldContext.relationships, `${sourceRecord.category}:${sourceRecord.name}`, `${targetRecord.category}:${targetRecord.name}`, type);
        message.reply(`Linked ${sourceRecord.name} to ${targetRecord.name} as ${type}.`);
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
            .slice(-1)[0]
            ?.replace(/^\[[^\]]+\]\s+\[[^\]]+\]\s+/, '') || 'No transcript yet.';
        const summary = summarizeTranscript(latestTranscript, worldContext.knowledgeIndex, worldContext.relationships);
        const prompt = buildPrompt(latestTranscript, `${summary.relevantRecords.map((record) => `${record.category}: ${record.name}`).join('\n') || 'No local records matched.'}\n\nRelationships:\n${summary.recentLinks.join('\n') || 'None'}`);
        callModel(prompt)
            .then((aiReply) => {
                const reply = aiReply || summary.advice;
                message.reply(reply);
                sendDmToOwner(`Context request:\n${reply}`);
            })
            .catch((error) => {
                message.reply(summary.advice);
                console.warn('-> AI provider unavailable:', error.message);
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