import io

import numpy as np
import soundfile as sf
from kokoro import KPipeline


class TtsService:
    """Owns the Kokoro pipeline and voice-tensor cache. Which concrete voice(s) to blend for a
    given speaker is decided on the Node side (src/voice/voice_registry.js) - this service just
    synthesizes whatever [{"name", "weight"}] blend + speed it's given."""

    # The complete voice pool used anywhere in this project (see MALE_VOICES/FEMALE_VOICES/
    # NARRATOR_VOICE in src/voice/voice_registry.js) - every dynamic character voice is a blend
    # of two of these four, so there is no fifth voice any request could ever ask for. Pre-loaded
    # at startup so the first real synthesis request (whichever voice it needs) never has to
    # pay for an on-demand Hugging Face download mid-request - that download is what caused the
    # first-ever TTS call after a fresh install to blow past the client's request timeout.
    KNOWN_VOICES = ["bm_george", "bm_lewis", "bf_emma", "bf_isabella"]

    def __init__(self, lang_code="b"):
        self._pipeline = KPipeline(lang_code=lang_code)
        self._voice_tensor_cache = {}
        self._preload_known_voices()

    def _preload_known_voices(self):
        for name in self.KNOWN_VOICES:
            print(f"-> Pre-loading Kokoro voice: {name}")
            self._get_voice_tensor(name)

    def _get_voice_tensor(self, name):
        if name not in self._voice_tensor_cache:
            self._voice_tensor_cache[name] = self._pipeline.load_voice(name)
        return self._voice_tensor_cache[name]

    def _blend_voice(self, voice_specs):
        total_weight = sum(v.get('weight', 1.0) for v in voice_specs) or 1.0
        blended = None
        for v in voice_specs:
            weighted = self._get_voice_tensor(v['name']) * (v.get('weight', 1.0) / total_weight)
            blended = weighted if blended is None else blended + weighted
        return blended

    def synthesize(self, text, voice_specs, speed):
        voice_tensor = self._blend_voice(voice_specs)

        chunks = [audio for _, _, audio in self._pipeline(text, voice=voice_tensor, speed=speed)]
        if not chunks:
            raise RuntimeError("Kokoro produced no audio output")

        audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]

        buf = io.BytesIO()
        sf.write(buf, audio, 24000, format='WAV')
        return buf.getvalue()
