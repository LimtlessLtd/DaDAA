# server/server.py
import asyncio
import json
import os
import numpy as np
import websockets
import torch
from faster_whisper import WhisperModel
from scipy import signal

# Load Silero VAD model
vad_model, utils = torch.hub.load(repo_or_dir='snakers4/silero-vad', model='silero_vad', force_reload=False, trust_repo=True)
(get_speech_timestamps, _, read_audio, _, _) = utils

MODEL_NAME = os.environ.get("WHISPER_MODEL", "medium")
MODEL_DEVICE = os.environ.get("WHISPER_DEVICE", "cpu")
MODEL_COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")

model = WhisperModel(MODEL_NAME, device=MODEL_DEVICE, compute_type=MODEL_COMPUTE)

def normalize_audio(samples):
    if samples.dtype != np.float32:
        samples = samples.astype(np.float32)
    if samples.size == 0:
        return samples
    peak = np.max(np.abs(samples))
    if peak < 0.015:
        return samples
    return samples / peak * 0.9

def resample_to_16k(samples, source_rate=48000, target_rate=16000):
    if source_rate == target_rate or samples.size == 0:
        return samples
    step = source_rate // target_rate
    if source_rate % target_rate != 0:
        return samples
    try:
        return signal.decimate(samples, step, ftype='iir')
    except Exception:
        return samples[::step]

def run_transcription(full_audio):
    initial_prompt = "D&D, Dungeons and Dragons, RPG, role, playing, game, Dungeon Master, DM, spells, dice rolls, d20, combats, NPCs, characters."
    segments, _ = model.transcribe(
            full_audio,
            beam_size=3,
            language="en",
            initial_prompt=initial_prompt,
            condition_on_previous_text=False
        )
        
    text = ' '.join(segment.text.strip() for segment in segments if segment.text and segment.text.strip())
    prompt_keywords = {w.strip(".,").lower() for w in initial_prompt.split()}
    text_words = [w.strip(".,").lower() for w in text.split()]
    if len(text_words) > 0 and len(text_words) <= len(prompt_keywords) + 2:
        match_count = sum(1 for w in text_words if w in prompt_keywords)
        if match_count / max(len(text_words), 1) > 0.7:
            return ""

    return text

async def audio_handler(websocket):
    user_id = None
    audio_buffer = []
    vad_accumulator = np.array([], dtype=np.float32)
    consecutive_silence_frames = 0
    
    CHUNK_SIZE = 512
    SILENCE_LIMIT_FRAMES = 35
    MIN_SPEECH_FRAMES = 10
    TIMEOUT_SECONDS = 0.8
    VAD_THRESHOLD = 0.4

    try:
        while True:
            try:
                message = await asyncio.wait_for(websocket.recv(), timeout=TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                if len(audio_buffer) >= MIN_SPEECH_FRAMES:
                    full_audio = np.concatenate(audio_buffer)
                    full_audio = normalize_audio(full_audio)
                    
                    transcript_text = await asyncio.to_thread(run_transcription, full_audio)
                    if transcript_text:
                        print(f"-> Transcription ({user_id}): {transcript_text}")
                        await websocket.send(json.dumps({"userId": user_id, "text": transcript_text}))
                audio_buffer = []
                consecutive_silence_frames = 0
                continue
            except websockets.exceptions.ConnectionClosed:
                break

            if isinstance(message, str):
                try:
                    payload = json.loads(message)
                    if isinstance(payload, dict) and payload.get('type') == 'handshake':
                        user_id = payload.get('userId')
                        continue
                except: pass
                continue

            if isinstance(message, (bytes, bytearray)) and user_id:
                raw_audio = np.frombuffer(message, dtype=np.int16).astype(np.float32) / 32768.0
                raw_audio_16k = resample_to_16k(raw_audio)
                vad_accumulator = np.concatenate([vad_accumulator, raw_audio_16k])
                
                while len(vad_accumulator) >= CHUNK_SIZE:
                    frame = vad_accumulator[:CHUNK_SIZE]
                    vad_accumulator = vad_accumulator[CHUNK_SIZE:]
                    
                    audio_tensor = torch.from_numpy(frame).unsqueeze(0)
                    with torch.no_grad():
                        speech_prob = vad_model(audio_tensor, 16000).item()

                    if speech_prob > VAD_THRESHOLD:
                        audio_buffer.append(frame)
                        consecutive_silence_frames = 0
                    else:
                        if len(audio_buffer) > 0:
                            audio_buffer.append(frame)
                            consecutive_silence_frames += 1
                            
                            if consecutive_silence_frames >= SILENCE_LIMIT_FRAMES:
                                if len(audio_buffer) - consecutive_silence_frames >= MIN_SPEECH_FRAMES:
                                    full_audio = np.concatenate(audio_buffer)
                                    full_audio = normalize_audio(full_audio)
                                    
                                    transcript_text = await asyncio.to_thread(run_transcription, full_audio)
                                    if transcript_text:
                                        print(f"-> Transcription ({user_id}): {transcript_text}")
                                        await websocket.send(json.dumps({"userId": user_id, "text": transcript_text}))
                                
                                audio_buffer = []
                                consecutive_silence_frames = 0

    except Exception as err:
        print(f"-> Transcription handler exception: {err}")

async def main():
    async with websockets.serve(audio_handler, "127.0.0.1", 8765, ping_interval=None, ping_timeout=None):
        print("-> Transcription server running (Voice Only)")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())