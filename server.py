import asyncio
import json
import os
import numpy as np
import websockets
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "base")
MODEL_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
MODEL_COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")

model = WhisperModel(MODEL_NAME, device=MODEL_DEVICE, compute_type=MODEL_COMPUTE)

# Buffer for incoming audio chunks
audio_buffer = []


def normalize_audio(samples):
    if samples.dtype != np.float32:
        samples = samples.astype(np.float32)
    if samples.size == 0:
        return samples
    peak = np.max(np.abs(samples))
    if peak > 0:
        return samples / peak
    return samples


async def audio_handler(websocket):
    global audio_buffer
    print("-> Bot connected to transcription server")
    async for message in websocket:
        if isinstance(message, (bytes, bytearray)):
            audio_chunk = np.frombuffer(message, dtype=np.int16).astype(np.float32) / 32768.0
            audio_buffer.append(audio_chunk)

            if len(audio_buffer) >= 100:
                full_audio = np.concatenate(audio_buffer)
                full_audio = normalize_audio(full_audio)
                segments, _ = model.transcribe(full_audio, beam_size=1)
                transcript_text = ' '.join(segment.text.strip() for segment in segments if segment.text and segment.text.strip())
                if transcript_text:
                    print(f"-> Transcription: {transcript_text}")
                    await websocket.send(json.dumps({"text": transcript_text}))
                audio_buffer = []


async def main():
    async with websockets.serve(audio_handler, "localhost", 8765):
        print("-> Transcription server running on ws://localhost:8765")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())