import sys
import pyttsx3

def generate_tts(text, output_path, profile="narrator"):
    engine = pyttsx3.init()
    
    voices = engine.getProperty('voices')
    voice_id = voices[0].id if voices else None
    
    # Default narrator settings
    rate = 150
    pitch_modifier = 0  # pitch is hard to modify across OSs with pyttsx3, so we mainly use rate/voice
    
    # Apply voice profiles
    profile = profile.lower()
    if profile == "goblin":
        rate = 220
        # Try to find a lighter or different voice if available
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
    elif profile == "female":
        rate = 160
        for v in voices:
            if "Zira" in v.name or "Hazel" in v.name or "female" in v.name.lower():
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
