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


def resample_to_16k(samples, source_rate=48000, target_rate=16000):
    if source_rate == target_rate or samples.size == 0:
        return samples
    step = source_rate // target_rate
    if source_rate % target_rate != 0:
        return samples
    return samples[::step]


async def audio_handler(websocket):
    user_id = None
    audio_buffer = []
    print("-> Bot connected to transcription server")

    try:
        async for message in websocket:
            if isinstance(message, str):
                try:
                    payload = json.loads(message)
                    if isinstance(payload, dict) and payload.get('type') == 'handshake':
                        user_id = payload.get('userId')
                        print(f"-> Received handshake for user {user_id}")
                        continue
                except json.JSONDecodeError:
                    pass
                continue

            if isinstance(message, (bytes, bytearray)):
                if user_id is None:
                    print("-> Warning: received audio before handshake; ignoring chunk")
                    continue

                audio_chunk = np.frombuffer(message, dtype=np.int16).astype(np.float32) / 32768.0
                audio_buffer.append(audio_chunk)

                if len(audio_buffer) >= 100:
                    full_audio = np.concatenate(audio_buffer)
                    full_audio = resample_to_16k(full_audio, source_rate=48000, target_rate=16000)
                    full_audio = normalize_audio(full_audio)
                    segments, _ = model.transcribe(full_audio, beam_size=1)
                    transcript_text = ' '.join(segment.text.strip() for segment in segments if segment.text and segment.text.strip())
                    if transcript_text:
                        print(f"-> Transcription ({user_id}): {transcript_text}")
                        try:
                            await websocket.send(json.dumps({"userId": user_id, "text": transcript_text}))
                        except Exception as send_error:
                            print(f"-> Failed to send transcription response: {send_error}")
                    audio_buffer = []
            else:
                continue

        if audio_buffer and user_id is not None:
            full_audio = np.concatenate(audio_buffer)
            full_audio = resample_to_16k(full_audio, source_rate=48000, target_rate=16000)
            full_audio = normalize_audio(full_audio)
            segments, _ = model.transcribe(full_audio, beam_size=1)
            transcript_text = ' '.join(segment.text.strip() for segment in segments if segment.text and segment.text.strip())
            if transcript_text:
                print(f"-> Final transcription ({user_id}): {transcript_text}")
                try:
                    await websocket.send(json.dumps({"userId": user_id, "text": transcript_text}))
                except Exception:
                    pass

    except websockets.exceptions.ConnectionClosedOK:
        pass
    except websockets.exceptions.ConnectionClosedError as err:
        print(f"-> Transcription connection closed with error: {err}")
    except Exception as err:
        print(f"-> Transcription handler exception: {err}")
    finally:
        print(f"-> Transcription websocket closed for user {user_id}")


async def main():
    async with websockets.serve(audio_handler, "localhost", 8765, ping_interval=None, ping_timeout=None):
        print("-> Transcription server running on ws://localhost:8765")
        await asyncio.Future()


if __name__ == "__main__":
    asyncio.run(main())