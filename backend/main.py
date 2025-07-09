import time
import sounddevice as sd
from fastapi import FastAPI
import threading

app = FastAPI()

mic_found = False

def check_microphone():
    global mic_found
    while True:
        devices = sd.query_devices()
        input_devices = [d for d in devices if d['max_input_channels'] > 0]
        if input_devices:
            if not mic_found:
                print(f"Microphone detected: {input_devices[0]['name']}")
                mic_found = True
            # Start streaming audio and print text based on what the mic hears
            stream_audio()
        else:
            if mic_found:
                print("Microphone disconnected. Waiting for a microphone...")
                mic_found = False
            else:
                print("No microphone detected. Waiting for a microphone...")
        time.sleep(2)

def stream_audio():
    def callback(indata, frames, time_info, status):
        # Simple volume detection as a placeholder for more complex processing
        volume_norm = (indata**2).mean()**0.5
        if volume_norm > 0.01:
            print("Heard something! Volume:", round(volume_norm, 3))
        else:
            print("Silence...")
    try:
        with sd.InputStream(callback=callback):
            print("Listening to microphone...")
            time.sleep(5)  # Listen for 5 seconds, then re-check mic
    except Exception as e:
        print("Error accessing microphone:", e)

@app.on_event("startup")
def startup_event():
    threading.Thread(target=check_microphone, daemon=True).start()

@app.get("/")
def read_root():
    return {"status": "Server is running. Check console for microphone status."}
