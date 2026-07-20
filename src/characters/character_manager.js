const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'temp_data');
const charMapPath = path.join(dataDir, 'character_map.json');
const charLogsPath = path.join(dataDir, 'character_logs.json');
const playerLogsPath = path.join(dataDir, 'player_logs.json');
const seenUsersPath = path.join(dataDir, 'seen_discord_users.json');

function ensureDataDirectories() {
    fs.mkdirSync(dataDir, { recursive: true });
}

function loadSeenDiscordUsers() {
    ensureDataDirectories();
    if (!fs.existsSync(seenUsersPath)) return [];
    try {
        return JSON.parse(fs.readFileSync(seenUsersPath, 'utf8')) || [];
    } catch (e) {
        return [];
    }
}

function recordDiscordUser(username) {
    if (!username) return;
    const users = loadSeenDiscordUsers();
    if (!users.includes(username)) {
        users.push(username);
        fs.writeFileSync(seenUsersPath, JSON.stringify(users, null, 2));
    }
}

function loadCharacterMap() {
    ensureDataDirectories();
    if (!fs.existsSync(charMapPath)) return {};
    try {
        const map = JSON.parse(fs.readFileSync(charMapPath, 'utf8')) || {};
        for (const user in map) {
            if (!Array.isArray(map[user])) {
                map[user] = [map[user]];
            }
        }
        return map;
    } catch (e) {
        console.warn('-> Could not read character map', e.message);
        return {};
    }
}

function saveCharacterMap(map) {
    ensureDataDirectories();
    fs.writeFileSync(charMapPath, JSON.stringify(map, null, 2));
}

function bindCharacter(discordUser, characterName) {
    const map = loadCharacterMap();
    if (!map[discordUser]) {
        map[discordUser] = [];
    }
    if (!map[discordUser].includes(characterName)) {
        map[discordUser].push(characterName);
        saveCharacterMap(map);
        addPlayerLog(discordUser, `Started playing as character: ${characterName}`);
    }
}

function unbindCharacter(discordUser, characterName) {
    const map = loadCharacterMap();
    if (!map[discordUser]) return;
    
    if (characterName) {
        map[discordUser] = map[discordUser].filter(c => c !== characterName);
        addPlayerLog(discordUser, `Stopped playing as character: ${characterName}`);
        if (map[discordUser].length === 0) {
            delete map[discordUser];
        }
    } else {
        const characters = map[discordUser];
        delete map[discordUser];
        addPlayerLog(discordUser, `Stopped playing as all characters: ${characters.join(', ')}`);
    }
    saveCharacterMap(map);
}

function getCharacterMapString() {
    const map = loadCharacterMap();
    const entries = Object.entries(map);
    if (entries.length === 0) return 'No players mapped yet.';
    return entries.map(([user, chars]) => `${user} -> ${chars.join(', ')}`).join('\n');
}

// NEW FUNCTION: Retrieves the bound character name for a Discord user
function getBoundCharacterName(discordUser) {
    const map = loadCharacterMap();
    if (map[discordUser] && map[discordUser].length > 0) {
        return map[discordUser][0]; // Returns the first bound character
    }
    return null;
}

function loadCharacterLogs() {
    ensureDataDirectories();
    if (!fs.existsSync(charLogsPath)) return [];
    try {
        return JSON.parse(fs.readFileSync(charLogsPath, 'utf8')) || [];
    } catch (e) {
        console.warn('-> Could not read character logs', e.message);
        return [];
    }
}

function saveCharacterLogs(logs) {
    ensureDataDirectories();
    fs.writeFileSync(charLogsPath, JSON.stringify(logs, null, 2));
}

function addCharacterLogs(newLogs) {
    if (!newLogs || !Array.isArray(newLogs) || newLogs.length === 0) return;
    const logs = loadCharacterLogs();
    
    for (const log of newLogs) {
        logs.push({
            id: `${Date.now()}-${Math.round(Math.random() * 1000)}`,
            character: String(log.character || '').trim(),
            log: String(log.log || '').trim(),
            type: String(log.type || 'plot').trim(),
            timestamp: new Date().toISOString()
        });
    }
    
    saveCharacterLogs(logs);
}

function loadPlayerLogs() {
    ensureDataDirectories();
    if (!fs.existsSync(playerLogsPath)) return [];
    try {
        return JSON.parse(fs.readFileSync(playerLogsPath, 'utf8')) || [];
    } catch (e) {
        console.warn('-> Could not read player logs', e.message);
        return [];
    }
}

function savePlayerLogs(logs) {
    ensureDataDirectories();
    fs.writeFileSync(playerLogsPath, JSON.stringify(logs, null, 2));
}

function addPlayerLog(discordUser, message) {
    if (!discordUser || !message) return;
    const logs = loadPlayerLogs();
    
    logs.push({
        id: `${Date.now()}-${Math.round(Math.random() * 1000)}`,
        discordUser: String(discordUser).trim(),
        log: String(message).trim(),
        timestamp: new Date().toISOString()
    });
    
    savePlayerLogs(logs);
}

function getPlayerLogsString() {
    const logs = loadPlayerLogs();
    if (logs.length === 0) return 'No player logs recorded yet.';
    return logs.slice(-15).map(l => `[${new Date(l.timestamp).toLocaleString()}] ${l.discordUser}: ${l.log}`).join('\n');
}

module.exports = {
    loadCharacterMap,
    bindCharacter,
    unbindCharacter,
    getCharacterMapString,
    getBoundCharacterName, // NEW EXPORT
    loadCharacterLogs,
    addCharacterLogs,
    loadSeenDiscordUsers,
    recordDiscordUser,
    loadPlayerLogs,
    addPlayerLog,
    getPlayerLogsString
};