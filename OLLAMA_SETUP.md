# Ollama Local LLM Configuration

This guide explains how to configure the Dungeon Master LLM to use a local Ollama instance instead of cloud-based LLMs like Gemini, OpenAI, or Anthropic.

## Prerequisites

1. **Ollama Installation**: Download and install Ollama from [ollama.ai](https://ollama.ai)
2. **Ollama Running**: Ensure Ollama is running on your PC (typically on `localhost:11434`)
3. **Model Downloaded**: Pull a model using Ollama, e.g., `ollama pull neural-chat`

## Setup Instructions

### Step 1: Configure config.json

Edit your `config.json` file and update the `OllamaConfig` section:

```json
{
  "foundryDataPath": "C:\\Users\\fab_f\\AppData\\Local\\FoundryVTT\\Data\\worlds\\ai-test-world\\data",
  "LLM": "gemini-3.5-flash",
  "LLMProvider": "cloud",
  "OllamaConfig": {
    "enabled": true,
    "baseUrl": "http://localhost:11434",
    "model": "neural-chat"
  }
}
```

### Step 2: Enable Ollama

Set `"enabled": true` in the `OllamaConfig` object.

### Step 3: Verify Configuration

- **baseUrl**: The URL where Ollama is running (default: `http://localhost:11434`)
- **model**: The Ollama model name you want to use (e.g., `neural-chat`, `mistral`, `llama2`)

## Available Ollama Models

Some popular models for D&D Dungeon Master use cases:

- **neural-chat** (Recommended for DM): Balanced, good at creative writing
- **mistral**: Fast, good reasoning
- **llama2**: Versatile, good general-purpose model
- **dolphin-mixtral**: Excellent instruction-following
- **openchat**: Good for creative tasks

To pull a model:
```bash
ollama pull neural-chat
```

To list available models:
```bash
ollama list
```

## Switching Between Cloud and Local

### To use Cloud LLM (Gemini, OpenAI, Claude):
```json
"OllamaConfig": {
  "enabled": false,
  ...
}
```

### To use Ollama:
```json
"OllamaConfig": {
  "enabled": true,
  "baseUrl": "http://localhost:11434",
  "model": "neural-chat"
}
```

## Troubleshooting

### Connection Error: "Cannot connect to Ollama"
- Ensure Ollama is running: Check if you can access `http://localhost:11434` in your browser
- Verify the `baseUrl` in config.json is correct
- Check that your firewall allows local connections

### Model Not Found Error
- Pull the model first: `ollama pull <model-name>`
- Verify the model name in `config.json` matches exactly

### Slow Responses
- Ollama performance depends on your hardware
- Models run on CPU or GPU (NVIDIA CUDA if available)
- Smaller models like `neural-chat` run faster than larger ones like `llama2`

### Memory Issues
- Ensure your system has enough RAM
- Smaller models require less memory (neural-chat ~4GB, mistral ~8GB)

## Performance Tips

1. **Use GPU Acceleration**: Install CUDA support for Ollama to use your NVIDIA GPU
2. **Choose Appropriate Model Size**: Smaller models are faster, larger models are more capable
3. **Monitor Resource Usage**: Watch CPU/RAM usage while running Ollama
4. **Run on Dedicated Machine**: For best performance, run Ollama on its own machine

## Example Workflow

1. Start Ollama:
   ```bash
   ollama serve
   ```

2. In another terminal, pull a model:
   ```bash
   ollama pull neural-chat
   ```

3. Update `config.json`:
   ```json
   {
     "OllamaConfig": {
       "enabled": true,
       "baseUrl": "http://localhost:11434",
       "model": "neural-chat"
     }
   }
   ```

4. Restart the D&D bot application

5. The bot will now use your local Ollama instance for all LLM calls

## Notes

- **No API Keys Required**: Using Ollama eliminates the need for cloud API keys
- **Privacy**: All data stays on your local machine
- **Cost**: No per-request costs (once model is downloaded)
- **Latency**: May be higher than cloud providers depending on your hardware
- **Both Functions Support Ollama**: Both `callModel()` and `generateNextSessionPlan()` support Ollama
