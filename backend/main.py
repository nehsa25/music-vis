import time
import sounddevice as sd
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
import threading
from contextlib import asynccontextmanager
import asyncio
import contextlib
import numpy as np
import logging
from fastapi.middleware.cors import CORSMiddleware
import math
import queue
from fastapi.responses import JSONResponse

# --- Shared audio stream for all clients ---
audio_clients = set()
audio_queue = queue.Queue(maxsize=10)
audio_task = None

# --- Shared waveform storage (in memory) ---
shared_waveforms = []  # List of dicts: {name, data}
shared_waveform_clients = set()  # WebSocket clients for updates

app = FastAPI()

def start_audio_stream():
    def callback(indata, frames, time_info, status):
        try:
            # Only keep the latest audio frame in the queue
            if not audio_queue.full():
                audio_queue.put_nowait(indata.copy())
        except Exception:
            pass
    stream = sd.InputStream(callback=callback, channels=1, samplerate=44100, blocksize=1024)
    stream.start()
    return stream

@app.on_event("startup")
async def start_audio_task():
    global audio_task
    audio_task = asyncio.create_task(audio_broadcast_loop())

@app.on_event("shutdown")
async def stop_audio_task():
    global audio_task
    if audio_task:
        audio_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await audio_task

@app.websocket("/audio")
async def audio_ws(websocket: WebSocket):
    await websocket.accept()
    print(f"[AUDIO_WS] Client connected: {websocket.client}")
    audio_clients.add(websocket)
    try:
        while True:
            await asyncio.sleep(1)  # Keep connection open, data is pushed from broadcast loop
    except WebSocketDisconnect:
        print(f"[AUDIO_WS] Client disconnected: {websocket.client}")
        pass
    finally:
        audio_clients.discard(websocket)

async def audio_broadcast_loop():
    stream = start_audio_stream()
    # Logging state for 5s average
    log_volumes = []
    log_start = time.time()
    try:
        while True:
            try:
                arr = audio_queue.get(timeout=1)
            except queue.Empty:
                arr = np.zeros((1024, 1), dtype=np.float32)
            arr = arr.flatten().astype(np.float32)
            # Normalize audio to [-1, 1] for visualization
            max_val = np.max(np.abs(arr))
            if max_val > 0:
                arr = arr / max_val
            # --- Logging: accumulate RMS for 5s ---
            rms = float(np.sqrt(np.mean(arr ** 2)))
            log_volumes.append(rms)
            now = time.time()
            if now - log_start >= 5.0:
                avg = sum(log_volumes) / len(log_volumes) if log_volumes else 0
                level = min(50, int(avg * 100))
                print('.' * max(1, level))
                log_volumes = []
                log_start = now
            # Broadcast to all connected clients
            for ws in list(audio_clients):
                try:
                    await ws.send_bytes(arr.tobytes())
                except Exception:
                    audio_clients.discard(ws)
            await asyncio.sleep(0.04)  # Lower data rate (was 0.01)
    finally:
        stream.stop()
        stream.close()

async def client_count_logger():
    while True:
        logging.info(f"Connected clients: {len(audio_clients)}")
        print(f"[INFO] Connected clients: {len(audio_clients)}")
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

@app.get("/waveforms")
def get_waveforms():
    return shared_waveforms

@app.post("/waveforms")
async def save_waveform(request: Request):
    body = await request.json()
    name = body.get("name")
    data = body.get("data")
    if not name or not data:
        return JSONResponse({"error": "Missing name or data"}, status_code=400)
    shared_waveforms.append({"name": name, "data": data})
    # Notify all connected waveform clients
    for ws in list(shared_waveform_clients):
        try:
            await ws.send_json({"type": "update", "waveforms": shared_waveforms})
        except Exception:
            shared_waveform_clients.discard(ws)
    return {"ok": True}

@app.websocket("/waveforms/ws")
async def waveforms_ws(websocket: WebSocket):
    await websocket.accept()
    shared_waveform_clients.add(websocket)
    # Send initial list
    await websocket.send_json({"type": "update", "waveforms": shared_waveforms})
    try:
        while True:
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        pass
    finally:
        shared_waveform_clients.discard(websocket)

import threading
import sys
import time

waveform_cross_times = []
waveform_cross_lock = threading.Lock()

@app.post("/waveform_cross_time")
async def waveform_cross_time(request: Request):
    data = await request.json()
    duration = data.get("duration")
    event_time = time.time()
    print(f"[LOG] Received POST at {event_time:.3f} with data: {data}", flush=True)
    if duration is not None:
        with waveform_cross_lock:
            waveform_cross_times.append(float(duration))
            count = len(waveform_cross_times)
            print(f"[LOG] Appended duration {duration}. Total events: {count}", flush=True)
            print(f"[LOG] Current durations: {waveform_cross_times}", flush=True)
            print(f"[COUNT] Events received: {count}", flush=True)
            if count >= 50:
                avg = sum(waveform_cross_times) / count
                print(f"[DEBUG] Received 50 crossing times. Average: {avg:.3f}s", flush=True)
                print(f"[DEBUG] All durations: {waveform_cross_times}", flush=True)
                print(f"[SHUTDOWN] Closing all websocket connections and exiting.", flush=True)
                # Gracefully close all websockets
                for ws in list(audio_clients):
                    try:
                        await ws.close()
                    except Exception:
                        pass
                for ws in list(shared_waveform_clients):
                    try:
                        await ws.close()
                    except Exception:
                        pass
                sys.exit(0)
    else:
        print(f"[WARN] No 'duration' in POST data: {data}", flush=True)
    return JSONResponse({"ok": True})
