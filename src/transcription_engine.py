# src/transcription_engine.py
import sys
from faster_whisper import WhisperModel

# Load the model
model = WhisperModel("base", device="cpu", compute_type="int8")

def transcribe(audio_path):
    segments, _ = model.transcribe(audio_path)
    text = " ".join([segment.text for segment in segments])
    print(text) # Node.js captures this print output

if __name__ == "__main__":
    audio_path = sys.argv[1]
    transcribe(audio_path)