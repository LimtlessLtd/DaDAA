# D&D AI Assistant (DaDAA)

A Discord bot that acts as an AI Dungeon Master for Dungeons & Dragons games.

## Features

- Real-time voice transcription and analysis
- AI-powered Dungeon Master responses
- Character and session management
- Event generation and tracking
- Local data storage with RAG (Retrieval-Augmented Generation)
- Web dashboard for monitoring and control

## Setup

1. Rename `.env.example` to `.env` and add your API keys, if you just want to use Ollama you do not need to create your own .env file.
2. Update `config.json` with your preferred settings, if using the default Ollama (local LLM), please follow the steps below to setup Ollama.
3. Run `npm install` to install node dependencies
4. Run `pip install requirements.txt` to install python dependencies
5. Start the servers & services by running the appropriate script in the startup scripts folder located in /startup_scripts/ folder.

### Default: Ollama (Local)

Ollama is the **default and recommended** provider when enabled. To use Ollama:

1. Install Ollama from [ollama.ai](https://ollama.ai)
2. Pull a model: `ollama pull qwen3.5` (or other compatible models)
3. Ensure Ollama is running by going to the correct local URL (usually `http://localhost:11434`)
4. Ensure your `config.json` looks like the following:

```json
{
  "LLM": "gemini-3.5-flash", /*only used if Ollama "enabled" is set to false*/
  "OllamaConfig": {
    "enabled": true,
    "baseUrl": "http://localhost:11434",
    "model": "qwen3.5"
  }
}
```

### Cloud Provider Fallback

When Ollama is disabled (`"enabled": false`) or unavailable, the system falls back to cloud providers in this priority order:

1. **Gemini** (Google) - Requires `GEMINI_API_KEY` or `GOOGLE_API_KEY`
2. **Anthropic** (Claude) - Requires `ANTHROPIC_API_KEY`
3. **OpenAI** (GPT) - Requires `OPENAI_API_KEY`

Set your preferred provider in `.env`:

```
GEMINI_API_KEY=your_gemini_api_key
# or
ANTHROPIC_API_KEY=your_anthropic_api_key
# or
OPENAI_API_KEY=your_openai_api_key
```

## Discord Commands

- `!join` - Join the voice channel and start listening
- `!leave` - Leave the voice channel

## License
This project is proprietary. All rights reserved.