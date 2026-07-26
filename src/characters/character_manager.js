const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'temp_data');
const charMapPath = path.join(dataDir, 'character_map.json');
const charLogsPath = path.join(dataDir, 'character_logs.json');
const playerLogsPath = path.join(dataDir, 'player_logs.json');
const seenUsersPath = path.join(dataDir, 'seen_discord_users.json');
const nicknamesPath = path.join(dataDir, 'discord_nicknames.json');

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

// Server nicknames/display names (e.g. what Dice Maiden prints in its roll replies) can
// differ from the Discord account username that character_map.json keys off of. This map
// bridges the two so a nickname seen in the wild resolves back to the right bound character.
function normalizeNickname(value = '') {
    return String(value).toLowerCase().trim().replace(/\s+/g, ' ');
}

function loadNicknameMap() {
    ensureDataDirectories();
    if (!fs.existsSync(nicknamesPath)) return {};
    try {
        return JSON.parse(fs.readFileSync(nicknamesPath, 'utf8')) || {};
    } catch (e) {
        return {};
    }
}

function recordDiscordNickname(nickname, username) {
    if (!nickname || !username) return;
    const normalized = normalizeNickname(nickname);
    if (!normalized) return;
    const map = loadNicknameMap();
    if (map[normalized] === username) return;
    map[normalized] = username;
    ensureDataDirectories();
    fs.writeFileSync(nicknamesPath, JSON.stringify(map, null, 2));
}

// Resolves a display name (as seen in a message, e.g. from Dice Maiden) to the Discord
// username used as the character_map.json key. Falls back to treating the input as
// already being a username if no nickname mapping is found.
function resolveUsernameByNickname(nickname) {
    if (!nickname) return null;
    const normalized = normalizeNickname(nickname);
    const map = loadNicknameMap();
    if (map[normalized]) return map[normalized];

    const seenUsers = loadSeenDiscordUsers();
    const directMatch = seenUsers.find((u) => normalizeNickname(u) === normalized);
    return directMatch || null;
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
        const character = String(log?.character || '').trim();
        const text = String(log?.log || '').trim();
        // A malformed LLM response (missing character/log) is worse than useless once it
        // hits the dashboard, so reject it here rather than storing an empty placeholder entry.
        if (!character || !text) {
            console.warn('-> Skipped malformed character log entry:', JSON.stringify(log));
            continue;
        }
        logs.push({
            id: `${Date.now()}-${Math.round(Math.random() * 1000)}`,
            character,
            log: text,
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
    getBoundCharacterName,
    loadCharacterLogs,
    addCharacterLogs,
    loadSeenDiscordUsers,
    recordDiscordUser,
    recordDiscordNickname,
    resolveUsernameByNickname,
    loadPlayerLogs,
    addPlayerLog,
    getPlayerLogsString
};