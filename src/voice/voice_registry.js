// src/voice/voice_registry.js
// Turns the LLM's free-text "voiceDescription" (see ai_provider.js buildPrompt guideline 5, e.g.
// "gruff old male dwarf, deep and gravelly") into a concrete Kokoro voice, and remembers it per
// speaker name so the same character sounds the same for the rest of the campaign. This is an
// approximation, not a literal generative match - Kokoro's entire British English catalog is 8
// voices (bm_george, bm_lewis, bm_daniel, bm_fable, bf_emma, bf_isabella, bf_alice, bf_lily), so
// variety across NPCs of the same gender comes from picking two of the four in that gender's pool
// (hash-selected from the description) and blending them with a description-derived weight, plus
// a speed nudge from age/texture keywords. Same description text always resolves to the same voice.
const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', '..', 'temp_data', 'character_voices.json');

const NARRATOR_VOICE = { voices: [{ name: 'bm_george', weight: 1 }], speed: 1.0 };

const MALE_VOICES = ['bm_george', 'bm_lewis', 'bm_daniel', 'bm_fable'];
const FEMALE_VOICES = ['bf_emma', 'bf_isabella', 'bf_alice', 'bf_lily'];

const FEMALE_KEYWORDS = ['female', 'woman', 'girl', 'she', 'her', 'lady', 'maiden', 'witch', 'queen', 'mother', 'sister', 'daughter'];
const MALE_KEYWORDS = ['male', 'man', 'boy', 'he', 'him', 'lord', 'king', 'father', 'brother', 'son'];
const DEEP_KEYWORDS = ['gruff', 'deep', 'gravel', 'gravelly', 'low', 'booming', 'growl', 'bass', 'grizzled', 'old', 'elder', 'ancient', 'weary', 'aged'];
const HIGH_KEYWORDS = ['high', 'shrill', 'squeak', 'squeaky', 'young', 'child', 'small', 'tiny', 'goblin', 'manic', 'sprightly', 'chipper'];
const SLOW_KEYWORDS = ['slow', 'weary', 'tired', 'drawl', 'drawling', 'solemn', 'ancient'];
const FAST_KEYWORDS = ['fast', 'frantic', 'hurried', 'manic', 'excitable', 'energetic', 'quick'];

function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

// Word-boundary match, not substring - plain text.includes(word) would count "female" as a
// male-keyword hit too (it contains "male"), which silently coin-flipped gender for any
// description that said "female" without another disambiguating word.
function countMatches(text, keywords) {
    return keywords.reduce((count, word) => count + (new RegExp(`\\b${word}\\b`).test(text) ? 1 : 0), 0);
}

function deriveVoiceFromDescription(description) {
    const text = (description || '').toLowerCase();
    const femaleScore = countMatches(text, FEMALE_KEYWORDS);
    const maleScore = countMatches(text, MALE_KEYWORDS);

    let pool;
    if (femaleScore > maleScore) pool = FEMALE_VOICES;
    else if (maleScore > femaleScore) pool = MALE_VOICES;
    else pool = (hashString(text) % 2 === 0) ? MALE_VOICES : FEMALE_VOICES;

    // Pick two distinct voices out of the four in this gender's pool, hash-selected from the
    // description so the same text always lands on the same pair. With 4 voices per gender this
    // gives 6 possible pairings (rather than always blending the same fixed two), before the
    // weight spread below even applies.
    const idxA = hashString(`${text}|idxA`) % pool.length;
    let idxB = hashString(`${text}|idxB`) % (pool.length - 1);
    if (idxB >= idxA) idxB += 1;

    // Spread the blend weight across [0.3, 0.7] using a hash of the description, so two
    // descriptions that land on the same voice pair still produce audibly different voices.
    const weightPrimary = 0.3 + (hashString(`${text}|w`) % 41) / 100;

    let speed = 1.0;
    if (countMatches(text, DEEP_KEYWORDS) > 0) speed -= 0.15;
    if (countMatches(text, HIGH_KEYWORDS) > 0) speed += 0.2;
    if (countMatches(text, SLOW_KEYWORDS) > 0) speed -= 0.1;
    if (countMatches(text, FAST_KEYWORDS) > 0) speed += 0.15;
    speed = Math.max(0.7, Math.min(1.45, speed));

    return {
        voices: [
            { name: pool[idxA], weight: weightPrimary },
            { name: pool[idxB], weight: 1 - weightPrimary }
        ],
        speed
    };
}

function loadRegistry() {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
        }
    } catch (e) {
        console.warn('-> Failed to read character_voices.json:', e.message);
    }
    return {};
}

function saveRegistry(registry) {
    try {
        fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
    } catch (e) {
        console.warn('-> Failed to save character_voices.json:', e.message);
    }
}

// The rule that matters: once a speaker has a voice, they keep it for the rest of the campaign -
// a different voiceDescription on a later turn is ignored, and a missing description on a first
// appearance still gets a real (if generic) voice instead of silently falling back to narrator.
function resolveSpeakerVoice(speaker, voiceDescription) {
    if (!speaker || speaker.trim().toLowerCase() === 'narrator') {
        return NARRATOR_VOICE;
    }

    const registry = loadRegistry();
    const key = speaker.trim();
    if (registry[key]) {
        return registry[key].voiceSpec;
    }

    const voiceSpec = deriveVoiceFromDescription(voiceDescription || key);
    registry[key] = { description: voiceDescription || null, voiceSpec, createdAt: new Date().toISOString() };
    saveRegistry(registry);
    console.log(`-> New character voice registered: ${key} ("${voiceDescription || 'no description given'}") -> ${JSON.stringify(voiceSpec)}`);
    return voiceSpec;
}

module.exports = { resolveSpeakerVoice, deriveVoiceFromDescription, NARRATOR_VOICE };
