import asyncio
import json
import os
import numpy as np
import websockets
import torch
from faster_whisper import WhisperModel

# Load Silero VAD model
vad_model, utils = torch.hub.load(repo_or_dir='snakers4/silero-vad', model='silero_vad', force_reload=False)
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

def run_transcription(full_audio):
    segments, _ = model.transcribe(full_audio, beam_size=1, condition_on_previous_text=False)
    return ' '.join(segment.text.strip() for segment in segments if segment.text and segment.text.strip())

async def audio_handler(websocket):
    user_id = None
    audio_buffer = []
    
    # Accumulate downsampled 16kHz audio samples here
    vad_accumulator = np.array([], dtype=np.float32)
    
    # Track consecutive silence to trigger stops on active continuous streams
    consecutive_silence_frames = 0
    
    # Tuning Constants
    CHUNK_SIZE = 512              # 32ms at 16kHz
    SILENCE_LIMIT_FRAMES = 25     # 25 * 32ms = 800ms of room silence before transcribing
    MIN_SPEECH_FRAMES = 10        # 10 * 32ms = 320ms of speech minimum to prevent static/mic bumps
    TIMEOUT_SECONDS = 0.8         # 800ms of packet absence before triggering fallback transcription

    try:
        while True:
            try:
                # Wait for the next packet or assume silence if the stream halts
                message = await asyncio.wait_for(websocket.recv(), timeout=TIMEOUT_SECONDS)
            except asyncio.TimeoutError:
                # CASE A: Discord stopped sending packets (User stopped speaking)
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
                # 1. Convert to float32 using standard 16-bit scaling
                raw_audio = np.frombuffer(message, dtype=np.int16).astype(np.float32) / 32768.0
                
                # 2. Downsample to 16kHz
                raw_audio_16k = resample_to_16k(raw_audio)
                
                # 3. Add to our VAD accumulator
                vad_accumulator = np.concatenate([vad_accumulator, raw_audio_16k])
                
                # 4. Process all complete 512-sample frames in the accumulator
                while len(vad_accumulator) >= CHUNK_SIZE:
                    frame = vad_accumulator[:CHUNK_SIZE]
                    vad_accumulator = vad_accumulator[CHUNK_SIZE:]
                    
                    audio_tensor = torch.from_numpy(frame).unsqueeze(0)
                    
                    # Run Silero VAD without tracking gradients to prevent memory leaks
                    with torch.no_grad():
                        speech_prob = vad_model(audio_tensor, 16000).item()

                    if speech_prob > 0.3:
                        audio_buffer.append(frame)
                        consecutive_silence_frames = 0
                    else:
                        # CASE B: Client keeps sending packets, but they are quiet
                        if len(audio_buffer) > 0:
                            audio_buffer.append(frame)  # Keep trailing silence so Whisper has pacing
                            consecutive_silence_frames += 1
                            
                            if consecutive_silence_frames >= SILENCE_LIMIT_FRAMES:
                                if len(audio_buffer) - consecutive_silence_frames >= MIN_SPEECH_FRAMES:
                                    full_audio = np.concatenate(audio_buffer)
                                    full_audio = normalize_audio(full_audio)
                                    
                                    transcript_text = await asyncio.to_thread(run_transcription, full_audio)
                                    if transcript_text:
                                        print(f"-> Transcription ({user_id}): {transcript_text}")
                                        await websocket.send(json.dumps({"userId": user_id, "text": transcript_text}))
                                
                                # Reset buffers
                                audio_buffer = []
                                consecutive_silence_frames = 0

    except Exception as err:
        print(f"-> Transcription handler exception: {err}")

async def main():
    async with websockets.serve(audio_handler, "localhost", 8765, ping_interval=None, ping_timeout=None):
        print("-> Transcription server running with forced 512-sample VAD framing")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())