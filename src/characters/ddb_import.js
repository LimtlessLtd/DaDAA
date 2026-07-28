// src/characters/ddb_import.js
// Imports core combat stats from a PUBLIC D&D Beyond character sheet. Uses the unofficial
// character-service JSON endpoint the wider D&D Beyond tooling community relies on (e.g.
// ddb-importer for FoundryVTT) - there is no official third-party API. Public sheets only:
// no Cobalt-session-cookie auth, so this can never see a private character and never stores
// anything resembling an account credential.
//
// D&D Beyond's schema splits several fields across base/bonus/override layers rather than
// exposing a single effective value, and has no direct field at all for armor class or skill
// proficiencies (those are inferred from a `modifiers` array shared with race/class/background/
// feat/item sources). The mappings below were verified against one real public character sheet,
// not just community docs, but the AC and proficient-skills derivations are still best-effort -
// see the comments on computeArmorClass/extractProficientSkills for exactly what's approximated
// and why doing this precisely would require D&D Beyond's separate, unpublished rules/options
// catalog (which real importers like ddb-importer ship a full bundled copy of).
const https = require('https');
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', '..', 'temp_data');
const ddbCharactersPath = path.join(dataDir, 'ddb_characters.json');

const ABILITY_BY_STAT_ID = { 1: 'str', 2: 'dex', 3: 'con', 4: 'int', 5: 'wis', 6: 'cha' };
const ARMOR_TYPE_BY_ID = { 1: 'light', 2: 'medium', 3: 'heavy', 4: 'shield' };
const SKILL_SUBTYPES = [
    'acrobatics', 'animal-handling', 'arcana', 'athletics', 'deception', 'history', 'insight',
    'intimidation', 'investigation', 'medicine', 'nature', 'perception', 'performance',
    'persuasion', 'religion', 'sleight-of-hand', 'stealth', 'survival'
];

function characterEndpoint(characterId) {
    return `https://character-service.dndbeyond.com/character/v5/character/${characterId}`;
}

// Accepts either a full profile URL (https://www.dndbeyond.com/characters/12345678) or a bare
// numeric ID typed directly.
function extractCharacterId(urlOrId) {
    const str = String(urlOrId || '').trim();
    const urlMatch = str.match(/dndbeyond\.com\/characters\/(\d+)/i);
    if (urlMatch) return urlMatch[1];
    const bareMatch = str.match(/^(\d+)$/);
    return bareMatch ? bareMatch[1] : null;
}

function fetchPublicCharacter(characterId) {
    return new Promise((resolve, reject) => {
        https.get(characterEndpoint(characterId), (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => {
                let parsed;
                try {
                    parsed = JSON.parse(body);
                } catch (e) {
                    reject(new Error(`Invalid response from D&D Beyond (HTTP ${res.statusCode}): ${e.message}`));
                    return;
                }
                if (res.statusCode >= 400 || parsed.success === false || !parsed.data) {
                    // D&D Beyond returns a generic 403 "An unexpected error has occurred" for
                    // both a private character and one without public sharing enabled - it never
                    // says which, to avoid confirming a character ID exists at all. Surfacing
                    // that raw text reads as a code bug, so translate it into the one thing the
                    // user can actually go fix.
                    if (res.statusCode === 403) {
                        reject(new Error('That D&D Beyond character isn\'t public. Open it on D&D Beyond, go to Privacy Settings, set visibility to "Public", then try importing again.'));
                        return;
                    }
                    reject(new Error(`D&D Beyond character fetch failed (HTTP ${res.statusCode}): ${parsed.message || 'character may be private, deleted, or does not exist'}`));
                    return;
                }
                resolve(parsed.data);
            });
        }).on('error', (e) => reject(new Error(`Could not reach D&D Beyond: ${e.message}`)));
    });
}

// override wins if set; otherwise base + bonus (either layer may be absent/null).
function effectiveStat(statId, stats, bonusStats, overrideStats) {
    const override = (overrideStats || []).find((s) => s.id === statId);
    if (override && override.value != null) return override.value;
    const base = (stats || []).find((s) => s.id === statId);
    const bonus = (bonusStats || []).find((s) => s.id === statId);
    return (base && base.value != null ? base.value : 10) + (bonus && bonus.value != null ? bonus.value : 0);
}

function computeMaxHp(d) {
    if (d.overrideHitPoints != null) return d.overrideHitPoints;
    return (d.baseHitPoints || 0) + (d.bonusHitPoints || 0);
}

function computeProficiencyBonus(totalLevel) {
    return 2 + Math.floor((Math.max(totalLevel, 1) - 1) / 4);
}

// Best-effort only. D&D Beyond's payload can legitimately list more than one body armor as
// "equipped" at once (seen on a real test character with three different body armors all
// flagged equipped simultaneously - which items are truly worn right now isn't reliably
// determined from this field alone), so this picks the single highest-AC equipped body armor
// plus any equipped shield's bonus, and applies the Dex modifier capped per armor category
// (none for heavy, +2 max for medium, uncapped for light/unarmored). It does not account for
// class features that change this formula (e.g. monk/barbarian unarmored defense, a fighting
// style) - treat the result as a starting estimate, not a guaranteed-correct value.
function computeArmorClass(d, dexMod) {
    const equipped = (d.inventory || [])
        .filter((i) => i.equipped && i.definition && i.definition.armorClass != null)
        .map((i) => ({ ac: i.definition.armorClass, type: ARMOR_TYPE_BY_ID[i.definition.armorTypeId] }));

    const shieldBonus = equipped.filter((a) => a.type === 'shield').reduce((sum, a) => sum + a.ac, 0);
    const bodyArmors = equipped.filter((a) => a.type && a.type !== 'shield');

    if (bodyArmors.length === 0) return 10 + dexMod + shieldBonus;

    const best = bodyArmors.reduce((max, a) => (a.ac > max.ac ? a : max), bodyArmors[0]);
    const dexContribution = best.type === 'heavy' ? 0 : best.type === 'medium' ? Math.min(dexMod, 2) : dexMod;
    return best.ac + dexContribution + shieldBonus;
}

// Best-effort only. D&D Beyond represents both "this is automatically yours" and "this was one
// of several options offered by a choose-N class/background/feat feature" as the same
// type:"proficiency" modifier shape - which option(s) were actually picked from a choice list is
// recorded separately in the character's `choices` data, keyed by option IDs that only resolve
// against D&D Beyond's own rules/options catalog (not included in this payload, and not
// reasonable to reimplement here - this is most of what a full importer like ddb-importer's
// bundled ruleset exists to solve). This function therefore returns every skill the character is
// ELIGIBLE to be proficient in, which can over-include unchosen options from a "pick 2 of these
// 6" feature. Treat this as a superset, not an exact list - see the D&D Beyond import section of
// the project plan for the reasoning.
function extractProficientSkills(modifiers) {
    const all = Object.values(modifiers || {}).flat();
    const names = all
        .filter((m) => m && m.type === 'proficiency' && SKILL_SUBTYPES.includes(m.subType))
        .map((m) => m.subType);
    return [...new Set(names)];
}

function parseCharacterSheet(raw) {
    const abilityScores = {};
    for (const [statId, ability] of Object.entries(ABILITY_BY_STAT_ID)) {
        abilityScores[ability] = effectiveStat(Number(statId), raw.stats, raw.bonusStats, raw.overrideStats);
    }
    const dexMod = Math.floor((abilityScores.dex - 10) / 2);
    const totalLevel = (raw.classes || []).reduce((sum, c) => sum + (c.level || 0), 0);
    const maxHp = computeMaxHp(raw);

    return {
        name: raw.name || 'Unnamed Character',
        race: (raw.race && (raw.race.baseRaceName || raw.race.fullName)) || 'Unknown',
        classes: (raw.classes || []).map((c) => ({
            name: (c.definition && c.definition.name) || 'Unknown',
            level: c.level || 0
        })),
        maxHp,
        currentHp: Math.max(0, maxHp - (raw.removedHitPoints || 0)),
        ac: computeArmorClass(raw, dexMod),
        abilityScores,
        proficiencyBonus: computeProficiencyBonus(totalLevel),
        proficientSkills: extractProficientSkills(raw.modifiers),
        inventory: (raw.inventory || []).map((i) => ({
            name: (i.definition && i.definition.name) || 'Unknown item',
            quantity: i.quantity || 1
        })),
        backstory: (raw.notes && raw.notes.backstory) || ''
    };
}

function ensureDataDirectories() {
    fs.mkdirSync(dataDir, { recursive: true });
}

function loadDdbCharacters() {
    ensureDataDirectories();
    if (!fs.existsSync(ddbCharactersPath)) return {};
    try {
        return JSON.parse(fs.readFileSync(ddbCharactersPath, 'utf8')) || {};
    } catch (e) {
        console.warn('-> Could not read ddb_characters.json', e.message);
        return {};
    }
}

function saveDdbCharacters(map) {
    ensureDataDirectories();
    fs.writeFileSync(ddbCharactersPath, JSON.stringify(map, null, 2));
}

// Fetches + parses a character and stores/overwrites its baseline sheet, keyed by the character's
// name (the same key character_map.json/character_logs.json/pending_checks.json/
// character_voices.json already use). Does not touch character_state.json (live HP/inventory) -
// callers decide whether to seed that separately (see character_state_manager.js
// initializeStateFromSheet, only called for a name with no existing state row).
async function linkCharacter(urlOrId) {
    const characterId = extractCharacterId(urlOrId);
    if (!characterId) throw new Error('Could not find a character ID in that D&D Beyond link.');

    const raw = await fetchPublicCharacter(characterId);
    const sheet = parseCharacterSheet(raw);

    const map = loadDdbCharacters();
    map[sheet.name] = { ddbCharacterId: characterId, sheet, lastImportedAt: new Date().toISOString() };
    saveDdbCharacters(map);

    return { characterName: sheet.name, sheet };
}

async function refreshCharacter(characterName) {
    const map = loadDdbCharacters();
    const entry = map[characterName];
    if (!entry) throw new Error(`No D&D Beyond link found for "${characterName}".`);

    const raw = await fetchPublicCharacter(entry.ddbCharacterId);
    const sheet = parseCharacterSheet(raw);
    map[characterName] = { ...entry, sheet, lastImportedAt: new Date().toISOString() };
    saveDdbCharacters(map);

    return { characterName, sheet };
}

// Called once at bot startup - re-pulls every linked character's baseline sheet fields only
// (never touches character_state.json's live HP/conditions/inventory). Best-effort per character:
// one failed refresh (D&D Beyond unreachable, character since made private/deleted) is logged and
// skipped rather than aborting the rest.
async function refreshAllLinkedCharacters() {
    const map = loadDdbCharacters();
    const names = Object.keys(map);
    if (names.length === 0) return;

    console.log(`-> Refreshing ${names.length} D&D Beyond-linked character sheet(s)...`);
    for (const name of names) {
        try {
            await refreshCharacter(name);
            console.log(`-> Refreshed D&D Beyond sheet for ${name}`);
        } catch (e) {
            console.warn(`-> Failed to refresh D&D Beyond sheet for ${name}:`, e.message);
        }
    }
}

const SKILL_TO_ABILITY = {
    'acrobatics': 'dex', 'animal-handling': 'wis', 'arcana': 'int', 'athletics': 'str',
    'deception': 'cha', 'history': 'int', 'insight': 'wis', 'intimidation': 'cha',
    'investigation': 'int', 'medicine': 'wis', 'nature': 'int', 'perception': 'wis',
    'performance': 'cha', 'persuasion': 'cha', 'religion': 'int', 'sleight-of-hand': 'dex',
    'stealth': 'dex', 'survival': 'wis'
};
const ABILITY_NAME_TO_KEY = {
    strength: 'str', dexterity: 'dex', constitution: 'con', intelligence: 'int', wisdom: 'wis', charisma: 'cha'
};

function normalizeSkillText(text) {
    return String(text || '').toLowerCase().replace(/[^a-z\s]/g, '').trim().replace(/\s+/g, '-');
}

// Resolves the modifier for a free-text skill/ability name (e.g. "Athletics", "a Perception
// check", "Sleight of Hand check") against a character's imported sheet - the LLM writes
// checkSkill as natural language, not a fixed slug, so this matches by substring against the
// known skill list first, falling back to a raw ability check (no proficiency bonus) if no
// skill name matches but an ability name does. Returns null if nothing resolves (unrecognized
// text, or the sheet has no ability score data) - callers should fall back to trusting the dice
// roll's own total in that case, not treat null as a zero modifier.
function computeSkillModifier(sheet, skillText) {
    if (!sheet || !sheet.abilityScores) return null;
    const normalized = normalizeSkillText(skillText).replace(/-check$/, '');
    if (!normalized) return null;

    const matchedSkill = Object.keys(SKILL_TO_ABILITY).find((skill) => normalized.includes(skill));
    if (matchedSkill) {
        const ability = SKILL_TO_ABILITY[matchedSkill];
        const abilityMod = Math.floor((sheet.abilityScores[ability] - 10) / 2);
        const proficient = (sheet.proficientSkills || []).includes(matchedSkill);
        return abilityMod + (proficient ? (sheet.proficiencyBonus || 0) : 0);
    }

    const matchedAbility = Object.keys(ABILITY_NAME_TO_KEY).find((name) => normalized.includes(name));
    if (matchedAbility) {
        const ability = ABILITY_NAME_TO_KEY[matchedAbility];
        return Math.floor((sheet.abilityScores[ability] - 10) / 2);
    }

    return null;
}

module.exports = {
    extractCharacterId,
    fetchPublicCharacter,
    parseCharacterSheet,
    loadDdbCharacters,
    linkCharacter,
    refreshCharacter,
    refreshAllLinkedCharacters,
    computeSkillModifier
};
