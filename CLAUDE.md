# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Be concise and explicit in this file — no filler, no restating the obvious.

## What this is

Discord bot AI Dungeon Master: transcribes voice, feeds lore + session memory to an LLM, speaks replies back via TTS. World-building is entirely AI-generated (Session Zero + the DM inventing NPCs/locations/lore as play continues) — there is deliberately no external VTT (Foundry or otherwise) integration; don't reintroduce one.

## Run

No build/lint/test tooling exists (no `scripts` in package.json, no tests).

```
npm install
pip install -r requirements.txt
```

Then run a script in `startup_scripts/`. It starts 4 processes in order (each depends on the previous):
1. `server/rag_server.py` — RAG HTTP, port 8766, ChromaDB
2. `server/rag_ingest.py` — watches `docs/` and ingests into RAG
3. `server/server.py` — voice transcription WebSocket, port 8765 (faster-whisper + Silero VAD)
4. `node index.js` — bot + web dashboard, port 8000

Iterating on Node only: run `node index.js` directly if the Python servers are already up (bot degrades gracefully without them).

Config: `config.json` picks the LLM (`OllamaConfig.enabled` = local Ollama, default; else `LLM` field for cloud). `.env` holds `DISCORD_BOT_TOKEN`, `BOT_OWNER_ID`, cloud keys. `README.md` is authoritative on current defaults (Qwen3.5) — `OLLAMA_SETUP.md` is stale (references `neural-chat`).

## Architecture

```
Discord voice -> voice_manager.js -(opus, WS :8765)-> server.py (whisper+VAD)
             -> index.js (orchestrator)
             -> context_manager.js -(HTTP :8766)-> rag_server.py (ChromaDB) [world lore lookup]
             -> ai_provider.js buildPrompt() -> callModel(): Ollama -> Gemini -> Anthropic -> OpenAI
             -> JSON reply {spokenNarrative, suggestion, isOOC, isImportant, eventStatus, characterLogs}
             -> voice_manager.js speakText() -(spawns local_tts.py)-> Discord voice
```

- **index.js** is the orchestrator, not a thin entrypoint. `runDmTurn(transcript)` is the shared pipeline (build context -> call LLM -> react to reply); three call sites feed it: the `messageCreate` transcript handler (real speech), `handleSilenceDriver()` (fires after 45s silence with a synthetic transcript), and `handleDiceMaidenRoll()` (fires after a tracked skill check resolves). Don't re-duplicate this logic for a fourth reactive trigger - extend `runDmTurn`. The one deliberate exception is Session Zero (`handleSessionZeroInput()`, below) - it bypasses `runDmTurn` entirely because it isn't a reactive DM turn, it's one-shot campaign generation with direct `speakText()` control over exactly what gets read aloud and when.
- **LLM output contract**: model must return one JSON object (shape in `ai_provider.js buildPrompt()`), including `checkCharacter`/`checkSkill`/`checkDc` (null unless a roll is being requested this turn). Local models emit malformed JSON often, so `ai_provider.js normaliseJson()` does defensive repair (strip code fences, fix smart quotes/Python literals, brace-scan, `Function()` eval fallback, flatten nested objects). Trust that function, not raw output. Because `flatten()` merges any nested object's keys straight into the top level (destroying the parent key), new LLM fields must stay flat, not nested.
- **Dice roll matching** (the trickiest part): a check request sets a pending entry (`check_manager.js`, one per character, `temp_data/pending_checks.json`). `messageCreate` special-cases Dice Maiden's bot messages (`src/dice/dice_maiden.js isDiceMaidenMessage()`, tag configured via `config.json DiceMaidenTag`) before the normal "ignore bots" guard, parses the roll total via regex (`parseDiceMaidenRoll()` - only trusts the trailing `= <total>`, not bracket contents, since modifiers vary; strips Discord markdown `**`/`` ` `` first since Dice Maiden's real replies are bold/code-formatted, e.g. `` Roll: `[8]` = **8** ``), then attributes it to a player via Discord interaction metadata first, falling back to Dice Maiden's printed display name resolved through a nickname->username map (`character_manager.js recordDiscordNickname`/`resolveUsernameByNickname`, `temp_data/discord_nicknames.json`) - necessary because Dice Maiden shows the server nickname, not the account username that `character_map.json` is keyed on. Nicknames are captured opportunistically whenever a bound player's voice is transcribed. `isDiceMaidenError()` filters out Dice Maiden's own "invalid expression" replies so those aren't logged as parse failures.
- **Provider fallback**: Ollama first if enabled, else/on-failure `fallbackToCloudProviders()` tries Gemini -> Anthropic -> OpenAI based on which `.env` key exists and matches `config.LLM`. `ai_provider.js selectCloudProvider()`/`callCloudProvider()` are the shared provider-selection helpers - every new LLM-calling function (there are three: `callModel`, `generateNextEvent`, `generateCampaignSeed`) should reuse these rather than re-duplicating the key/provider matching logic. Similarly, `parseJsonLoose()` (robust cleanup, no flattening) vs `normaliseJson()` (`parseJsonLoose` + `flatten()`) - use `parseJsonLoose` when the expected shape has meaningful nesting you need to keep (like `generateNextEvent`'s `{activeEvent: {...}}`), `normaliseJson` when the shape is flat-or-arrays-only (the main DM schema, `generateCampaignSeed`'s `{introLore, worldEntities: [...]}`).
- **World knowledge is AI-generated, not imported**: `data_manager.js` loads structured entities from `temp_data/<type>/*.json` (npcs/locations/items/quests/lore/encounters); everything - including entities the DM invents mid-session - lives in a **single** ChromaDB collection, `dnd_knowledge` (tagged with a `type` metadata field, not split per category). This is deliberate: `findRelevantRecords()` (the function that actually feeds every prompt) only ever queries `dnd_knowledge`, so anything synced anywhere else would be invisible to the DM - don't reintroduce per-category collections without also updating `findRelevantRecords()`. `context_manager.js syncKnowledgeToRAG()` does the bulk sync at startup; `context_manager.js addWorldEntities()` is the incremental path - called from `runDmTurn()` whenever the LLM reply includes a `worldEntities` array (guideline 11 in `ai_provider.js`), it dedupes against already-known names (`exactNameCache`) before calling `data_manager.js saveEntity()` and pushing straight into `dnd_knowledge`, so newly-invented lore is queryable on the very next turn without a restart. `rag_ingest.py` separately watches `docs/` for static lore files, but that folder doesn't exist in this project - it's currently a no-op process, not a bug, just unused.
- **Entities can be `secret: true`**: background lore/NPCs/locations the DM knows but hasn't revealed to players. Guideline 11 tells the model to set this when inventing something not yet public, and to never state a Record tagged `[SECRET]` (added by `runDmTurn`'s `contextString` formatting in `index.js`) directly to players - only let it surface through play.
- **Session Zero is one flow, voice-driven end to end** (there used to be two - a dead one in `ai_helper.js` that was never wired up, and a synchronous one that generated before asking players anything - both removed). Sequence:
  1. Dashboard "Start New Campaign" -> `web_editor.js /api/start_campaign`: wipes RAG collections, session-scoped files (including `character_map.json`/`character_logs.json`), all stored entities (`data_manager.js clearAllEntities()`), and the in-memory world cache (`context_manager.js resetWorldCache()` - without this the cache would still serve deleted entities until a restart). Then calls `session_manager.js startSessionZero()`, which speaks a fixed prompt asking players for world ideas, and returns immediately - it does **not** generate anything itself.
  2. While `isSessionZeroActive()` is true, `index.js`'s transcript handler routes every utterance to `handleSessionZeroInput()` instead of `runDmTurn()` - buffered via `addSessionZeroInput()`, not reacted to as in-character speech. `handleSilenceDriver()` also no-ops while active, so the 45s silence timer doesn't interrupt brainstorming.
  3. `handleSessionZeroInput()` checks each utterance against `SESSION_ZERO_FINISH_REGEX` (a completion-phrase detector - note contractions need `('re| are)` as one alternation, not `(are|'re)`, since `"we're"` has no space before `'re`). On match: `endSessionZero()` returns the compiled ideas, which get passed to `ai_provider.js generateCampaignSeed(playerIdeas)` - a one-shot LLM call producing `{introLore, worldEntities}` built on what the players actually said. The intro lore is saved to `dnd_knowledge` and spoken aloud via `speakText()`; the entities (public and secret) go through `addWorldEntities()`; then `generateNextEvent()` produces the Session 1 opening event, written to `current_event.json` and also spoken aloud.
- **Event state machine**: `temp_data/current_event.json` holds one `activeEvent` + `archivedEvents[]`. Reply's `eventStatus` drives it: `resolved` archives + calls `generateNextEvent()`; `escalated`/`evolved` mutates the complication in place.
- **Session memory**: `ai_helper.js` keeps a rolling text summary (`temp_data/ai_memory.json`), refreshed by an LLM call every 10 utterances. `character_manager.js` maps Discord users -> character names (`temp_data/character_map.json`) + per-character/per-player logs. All of this gets injected into every prompt.
- **Web dashboard** (`src/web/web_editor.js`, port 8000, static in `UI/`): CRUD API over world records/relationships/session notes/character bindings, plus a live view of `temp_data/llm_debug.json` (overwritten on every LLM call) — fastest way to inspect prompts/replies without Discord running.
- **Storage**: flat JSON under `temp_data/` + ChromaDB in `chroma_db/`, both git-ignored, both are per-campaign save state. Clearing both resets the world; they're independent stores.
