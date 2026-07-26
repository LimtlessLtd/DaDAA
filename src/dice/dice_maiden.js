// src/dice/dice_maiden.js
const config = require('../../config.json');

function isDiceMaidenMessage(message) {
    if (!message?.author?.bot) return false;
    const configuredTag = config.DiceMaidenTag || 'Dice Maiden#9678';
    const configuredUsername = configuredTag.split('#')[0];
    return message.author.tag === configuredTag || message.author.username === configuredUsername;
}

// Dice Maiden wraps parts of its reply in Discord markdown, e.g.:
// "🎲 **DM (DM) (Fabian)** Request: `1d20` Roll: `[8]` = **8**"
// Strip it before matching so the parser doesn't care whether a given reply happens to be
// bold/coded or not.
function stripMarkdown(content) {
    return content.replace(/\*\*/g, '').replace(/`/g, '');
}

// Dice Maiden replies with an error (e.g. "20" isn't valid dice notation) rather than a roll
// when the player's command was malformed. That's not a parse failure on our end - it's Dice
// Maiden correctly rejecting bad input - so callers should skip it quietly, not warn.
function isDiceMaidenError(content) {
    return /❌|\*\*Error\*\*/i.test(content || '');
}

// Dice Maiden format: "🎲 <display name> Request: <notation> Roll: [<rolls>] = <total>"
// The bracket contents vary with modifiers (e.g. "[4, 2] + 3"), so only the trailing
// "= <total>" is treated as reliable; notation/name are best-effort for logging/fallback matching.
function parseDiceMaidenRoll(content) {
    if (!content || isDiceMaidenError(content)) return null;

    const cleaned = stripMarkdown(content);

    const totalMatch = cleaned.match(/=\s*(-?\d+)\s*$/);
    if (!totalMatch) return null;

    const nameMatch = cleaned.match(/^[^\w]*\s*(.+?)\s*Request:/i);
    const notationMatch = cleaned.match(/Request:\s*(.+?)\s*Roll:/i);
    const notation = notationMatch ? notationMatch[1].trim() : null;

    // Natural die value (pre-modifier) - only extracted for a plain single d20 roll, since
    // that's the only case where "the natural roll" is unambiguous (not multi-die, not
    // advantage/disadvantage syntax). Used to flag critical success/failure.
    let natural = null;
    if (notation && /^1?d20([+-]\d+)?$/i.test(notation.replace(/\s+/g, ''))) {
        const bracketMatch = cleaned.match(/Roll:\s*\[([^\]]*)\]/i);
        if (bracketMatch && /^-?\d+$/.test(bracketMatch[1].trim())) {
            natural = parseInt(bracketMatch[1].trim(), 10);
        }
    }

    return {
        rollerDisplayName: nameMatch ? nameMatch[1].trim() : null,
        notation,
        total: parseInt(totalMatch[1], 10),
        natural,
        isCriticalSuccess: natural === 20,
        isCriticalFailure: natural === 1
    };
}

module.exports = { isDiceMaidenMessage, parseDiceMaidenRoll, isDiceMaidenError };
