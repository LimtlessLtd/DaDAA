const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'temp_data');
const charMapPath = path.join(dataDir, 'character_map.json');
const charLogsPath = path.join(dataDir, 'character_logs.json');
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
    }
}

function unbindCharacter(discordUser, characterName) {
    const map = loadCharacterMap();
    if (!map[discordUser]) return;

    if (characterName) {
        map[discordUser] = map[discordUser].filter(c => c !== characterName);
        if (map[discordUser].length === 0) {
            delete map[discordUser];
        }
    } else {
        delete map[discordUser];
    }
    saveCharacterMap(map);
}

// Flat, de-duplicated list of every character name currently bound to a Discord user, regardless
// of which player - used as a backstop to stop the DM from ever voicing/narrating as a player
// character (see index.js runDmTurn()'s dialogue loop): the LLM prompt tells it never to use a
// bound character's name as a dialogue "speaker", but local models don't always comply, so this
// gives the code a deterministic list to filter against instead of trusting the prompt alone.
function getAllBoundCharacterNames() {
    const map = loadCharacterMap();
    return [...new Set(Object.values(map).flat())];
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

// Flat roster of who's currently player-controlled, for prompt injection - this used to be a
// timestamped "Player Logs" history of every bind/unbind event, but that log format told the
// model nothing about NET current state: a character bound then unbound minutes later (e.g. a
// name mentioned in passing during a character intro, mistakenly auto-bound as its own
// character, then manually unbound once noticed) still left both lines sitting in the prompt
// with no signal about which one still held. Reflecting only current bindings makes a corrected
// mistake disappear from the prompt automatically instead of lingering as noise.
function getCurrentlyPlayedCharactersString() {
    const names = getAllBoundCharacterNames();
    if (names.length === 0) return 'No characters currently bound to a player.';
    return names.join(', ');
}

module.exports = {
    loadCharacterMap,
    bindCharacter,
    unbindCharacter,
    getBoundCharacterName,
    getAllBoundCharacterNames,
    loadCharacterLogs,
    addCharacterLogs,
    loadSeenDiscordUsers,
    recordDiscordUser,
    recordDiscordNickname,
    resolveUsernameByNickname,
    getCurrentlyPlayedCharactersString
};
