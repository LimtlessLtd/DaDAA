import asyncio
import os

import numpy as np
import torch
from faster_whisper import WhisperModel
from scipy import signal


class TranscriptionEngine:
    """Owns the (expensive, shared) faster-whisper model and Silero VAD model. Stateless per
    call - all per-connection state (audio buffers, silence tracking) lives in VoiceSession,
    not here, so one engine instance is reused across every player's connection."""

    CHUNK_SIZE = 512
    VAD_THRESHOLD = 0.4
    INITIAL_PROMPT = (
        "D&D, Dungeons and Dragons, RPG, role, playing, game, Dungeon Master, DM, spells, "
        "dice rolls, d20, combats, NPCs, characters."
    )

    def __init__(self, model_name=None, device=None, compute_type=None):
        model_name = model_name or os.environ.get("WHISPER_MODEL", "medium")
        device = device or os.environ.get("WHISPER_DEVICE", "cpu")
        compute_type = compute_type or os.environ.get("WHISPER_COMPUTE", "int8")

        self._model = WhisperModel(model_name, device=device, compute_type=compute_type)

        vad_model, utils = torch.hub.load(
            repo_or_dir='snakers4/silero-vad', model='silero_vad',
            force_reload=False, trust_repo=True
        )
        self._vad_model = vad_model

    def is_speech(self, frame_16k):
        audio_tensor = torch.from_numpy(frame_16k).unsqueeze(0)
        with torch.no_grad():
            return self._vad_model(audio_tensor, 16000).item()

    def transcribe(self, full_audio):
        segments, _ = self._model.transcribe(
            full_audio,
            beam_size=3,
            language="en",
            initial_prompt=self.INITIAL_PROMPT,
            condition_on_previous_text=False
        )
        text = ' '.join(s.text.strip() for s in segments if s.text and s.text.strip())
        return self._filter_prompt_echo(text)

    def _filter_prompt_echo(self, text):
        # The initial_prompt above biases the model toward D&D vocabulary, but on near-silent
        # audio it sometimes just echoes the prompt itself back as the "transcription" - detect
        # and discard that rather than treating it as real speech.
        prompt_keywords = {w.strip(".,").lower() for w in self.INITIAL_PROMPT.split()}
        text_words = [w.strip(".,").lower() for w in text.split()]
        if 0 < len(text_words) <= len(prompt_keywords) + 2:
            match_count = sum(1 for w in text_words if w in prompt_keywords)
            if match_count / max(len(text_words), 1) > 0.7:
                return ""
        return text

    @staticmethod
    def normalize_audio(samples):
        if samples.dtype != np.float32:
            samples = samples.astype(np.float32)
        if samples.size == 0:
            return samples
        peak = np.max(np.abs(samples))
        if peak < 0.015:
            return samples
        return samples / peak * 0.9

    @staticmethod
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


class VoiceSession:
    """Per-connection state machine: buffers incoming PCM audio, runs VAD frame-by-frame, and
    decides when a chunk of speech is complete enough to transcribe. One instance per Discord
    user's WebSocket connection - keeps that state out of the shared TranscriptionEngine."""

    SILENCE_LIMIT_FRAMES = 35
    MIN_SPEECH_FRAMES = 10

    def __init__(self, engine: TranscriptionEngine, user_id=None):
        self._engine = engine
        self.user_id = user_id
        self._audio_buffer = []
        self._vad_accumulator = np.array([], dtype=np.float32)
        self._consecutive_silence_frames = 0

    async def feed(self, raw_pcm_bytes):
        """Feed raw 48kHz int16 PCM bytes. Returns transcript text if a phrase just completed
        (VAD detected enough trailing silence after speech), else None."""
        raw_audio = np.frombuffer(raw_pcm_bytes, dtype=np.int16).astype(np.float32) / 32768.0
        raw_audio_16k = self._engine.resample_to_16k(raw_audio)
        self._vad_accumulator = np.concatenate([self._vad_accumulator, raw_audio_16k])

        while len(self._vad_accumulator) >= TranscriptionEngine.CHUNK_SIZE:
            frame = self._vad_accumulator[:TranscriptionEngine.CHUNK_SIZE]
            self._vad_accumulator = self._vad_accumulator[TranscriptionEngine.CHUNK_SIZE:]
            speech_prob = self._engine.is_speech(frame)

            if speech_prob > TranscriptionEngine.VAD_THRESHOLD:
                self._audio_buffer.append(frame)
                self._consecutive_silence_frames = 0
            elif self._audio_buffer:
                self._audio_buffer.append(frame)
                self._consecutive_silence_frames += 1
                if self._consecutive_silence_frames >= self.SILENCE_LIMIT_FRAMES:
                    text = None
                    if len(self._audio_buffer) - self._consecutive_silence_frames >= self.MIN_SPEECH_FRAMES:
                        text = await self._transcribe_buffer()
                    self._reset_buffer()
                    if text:
                        return text
        return None

    async def flush_on_timeout(self):
        """Called when no audio has arrived for a while (see TIMEOUT_SECONDS in
        web/transcription_ws.py) - flushes whatever's buffered even without a VAD-detected gap."""
        text = None
        if len(self._audio_buffer) >= self.MIN_SPEECH_FRAMES:
            text = await self._transcribe_buffer()
        self._reset_buffer()
        return text

    async def _transcribe_buffer(self):
        full_audio = np.concatenate(self._audio_buffer)
        full_audio = self._engine.normalize_audio(full_audio)
        return await asyncio.to_thread(self._engine.transcribe, full_audio)

    def _reset_buffer(self):
        self._audio_buffer = []
        self._consecutive_silence_frames = 0
