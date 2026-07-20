import sys
import pyttsx3
from gtts import gTTS
import os

def generate_tts(text, output_path, profile="narrator"):
    # For a high-quality narrator voice, we'll use gTTS (Google TTS)
    # For goblins, monsters, and old men, we'll fall back to pyttsx3 which allows rate/pitch modification
    
    profile = profile.lower()
    
    if profile == "narrator" or profile == "female":
        try:
            # gTTS produces much higher quality, natural-sounding audio
            # tld='co.uk' gives it a nice British narrator accent
            tts = gTTS(text=text, lang='en', tld='co.uk' if profile == "narrator" else 'com')
            tts.save(output_path)
            return
        except Exception as e:
            print(f"gTTS failed: {e}. Falling back to pyttsx3.")

    # Fallback / Character Voice handling
    engine = pyttsx3.init()
    
    voices = engine.getProperty('voices')
    voice_id = voices[0].id if voices else None
    
    rate = 150
    
    if profile == "goblin":
        rate = 220
        for v in voices:
            if "Zira" in v.name or "Hazel" in v.name or "female" in v.name.lower():
                voice_id = v.id
                break
    elif profile == "old_man":
        rate = 110
        for v in voices:
            if "David" in v.name or "male" in v.name.lower():
                voice_id = v.id
                break
    elif profile == "monster":
        rate = 100
        for v in voices:
            if "David" in v.name or "male" in v.name.lower():
                voice_id = v.id
                break

    if voice_id:
        engine.setProperty('voice', voice_id) 
    
    engine.setProperty('rate', rate)
    
    engine.save_to_file(text, output_path)
    engine.runAndWait()

if __name__ == "__main__":
    if len(sys.argv) > 2:
        profile = sys.argv[3] if len(sys.argv) > 3 else "narrator"
        generate_tts(sys.argv[1], sys.argv[2], profile)
    else:
        print("Usage: python local_tts.py <text> <output_path> [profile]")
