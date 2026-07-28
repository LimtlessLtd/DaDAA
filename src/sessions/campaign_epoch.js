// src/sessions/campaign_epoch.js
// Bumped once by /api/start_campaign whenever it wipes session/world state. A DM turn
// (index.js runDmTurn) can have a slow LLM call already in flight when that happens - without
// this, the turn resolves after the reset and still applies its stale effects (queues TTS for
// the old campaign, overwrites the just-cleared current_event.json) on top of the fresh state.
// runDmTurn captures the epoch before its slow await and re-checks it after; a mismatch means a
// reset happened mid-flight, so the turn's reply is discarded instead of applied.
let epoch = 0;

function getCampaignEpoch() {
    return epoch;
}

function bumpCampaignEpoch() {
    epoch += 1;
    return epoch;
}

module.exports = { getCampaignEpoch, bumpCampaignEpoch };
