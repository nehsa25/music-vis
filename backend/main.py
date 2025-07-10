import time
import sounddevice as sd
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import threading
from contextlib import asynccontextmanager
import asyncio
import contextlib
import numpy as np
import logging
from fastapi.middleware.cors import CORSMiddleware
import math

# Define lifespan before creating the app
@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(run_check_microphone())
    logger_task = asyncio.create_task(client_count_logger())
    try:
        yield
    finally:
        task.cancel()
        logger_task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        try:
            await logger_task
        except asyncio.CancelledError:
            pass

app = FastAPI(lifespan=lifespan)

mic_found = False
clients = set()

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
    volumes = []
    start_time = time.time()
    def callback(indata, frames, time_info, status):
        nonlocal volumes, start_time
        volume_norm = float((indata**2).mean()**0.5)
        volumes.append(volume_norm)
        now = time.time()
        if now - start_time >= 1.0:
            avg = sum(volumes) / len(volumes) if volumes else 0
            # Map average to 0-10 scale
            if math.isnan(avg):
                level = 0
            else:
                level = min(10, int(avg * 100))
            if level == 0:
                print(".")
            else:
                print("." * level)
            volumes = []
            start_time = now
    try:
        with sd.InputStream(callback=callback):
            print("Listening to microphone...")
            time.sleep(5)  # Listen for 5 seconds, then re-check mic
    except Exception as e:
        print("Error accessing microphone:", e)

async def run_check_microphone():
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, check_microphone)

@app.websocket("/audio")
async def audio_ws(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)
    use_mic = False
    try:
        # Try to open a microphone stream
        try:
            import sounddevice as sd
            use_mic = True
        except ImportError:
            use_mic = False
        if use_mic:
            import numpy as np
            import asyncio
            import time
            import queue
            q = queue.Queue()
            def callback(indata, frames, time_info, status):
                q.put(indata.copy())
            stream = sd.InputStream(callback=callback, channels=1, samplerate=44100, blocksize=1024)
            stream.start()
            volumes = []
            start_time = time.time()
            while True:
                try:
                    arr = q.get(timeout=1)
                except queue.Empty:
                    arr = np.zeros((1024, 1), dtype=np.float32)
                arr = arr.flatten().astype(np.float32)
                rms = float(np.sqrt(np.mean(arr ** 2)))
                volumes.append(rms)
                now = time.time()
                if now - start_time >= 1.0:
                    avg = sum(volumes) / len(volumes) if volumes else 0
                    if math.isnan(avg):
                        level = 0
                    else:
                        level = min(10, int(avg * 100))
                    print('.' * level if level > 0 else '.')
                    volumes = []
                    start_time = now
                await websocket.send_bytes(arr.tobytes())
                await asyncio.sleep(0.03)
        else:
            # Fallback: animated sine wave
            phase = 0.0
            freq = 2
            rate = 1024
            sample_rate = 44100
            volumes = []
            start_time = time.time()
            while True:
                t = np.arange(rate)
                arr = np.sin(2 * np.pi * freq * (t + phase))
                arr = arr.astype(np.float32)
                phase += rate * (freq / sample_rate) * 100
                rms = float(np.sqrt(np.mean(arr ** 2)))
                volumes.append(rms)
                now = time.time()
                if now - start_time >= 1.0:
                    avg = sum(volumes) / len(volumes) if volumes else 0
                    if math.isnan(avg):
                        level = 0
                    else:
                        level = min(10, int(avg * 100))
                    print('.' * level if level > 0 else '.')
                    volumes = []
                    start_time = now
                await websocket.send_bytes(arr.tobytes())
                await asyncio.sleep(0.03)
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(websocket)

async def client_count_logger():
    while True:
        logging.info(f"Connected clients: {len(clients)}")
        print(f"[INFO] Connected clients: {len(clients)}")
        await asyncio.sleep(5)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # Changed from True to False
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"status": "Server is running. Check console for microphone status."}
