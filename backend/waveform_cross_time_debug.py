from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
import threading
import sys
import time
import sounddevice as sd
import asyncio
import contextlib
import numpy as np
import logging
from fastapi.middleware.cors import CORSMiddleware
import queue
import os
import signal
import re
import argparse
import psutil
import datetime

# --- Timestamped log helper ---
def log(msg, *args, **kwargs):
    ts = datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    print(f"[{ts}] {msg}", *args, **kwargs, flush=True)

# --- Shared audio stream for all clients ---
audio_clients = set()
audio_queue = queue.Queue(maxsize=10)
audio_task = None

# --- Shared waveform storage (in memory) ---
shared_waveforms = []  # List of dicts: {name, data}
shared_waveform_clients = set()  # WebSocket clients for updates

app = FastAPI()

# --- Event counters ---
events_fired = 0  # Events sent to frontend
events_echoed = 0  # Echoed events received
frontend_final_counts = None  # To store frontend's final POST
shutdown_ready = threading.Event()

# --- Configurable event stop ---
parser = argparse.ArgumentParser()
parser.add_argument('--run', type=int, default=None, help='Stop after N echoed events (default: run forever)')
# Only parse known args to avoid uvicorn errors
args, _ = parser.parse_known_args()
RUN_EVENT_LIMIT = args.run
if RUN_EVENT_LIMIT is not None:
    print(f"[CONFIG] Will stop after {RUN_EVENT_LIMIT} echoed events.", flush=True)
else:
    print("[CONFIG] No event limit set. Will run forever.", flush=True)

# --- Baseline volume loading ---
BASELINE_FILE = os.path.join(os.path.dirname(__file__), "baseline_volume.txt")
try:
    with open(BASELINE_FILE, "r") as f:
        BASELINE_VOLUME = float(f.read().strip())
    print(f"[BASELINE] Loaded baseline RMS volume: {BASELINE_VOLUME}")
except Exception:
    BASELINE_VOLUME = 0.0
    print("[BASELINE] No baseline file found, using 0.0")

def start_audio_stream():
    def callback(indata, frames, time_info, status):
        try:
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
    log(f"[AUDIO_WS] Client connected: {websocket.client}")
    audio_clients.add(websocket)
    try:
        while True:
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        log(f"[AUDIO_WS] Client disconnected: {websocket.client}")
    finally:
        audio_clients.discard(websocket)

stop_audio_flag = threading.Event()

async def audio_broadcast_loop():
    stream = start_audio_stream()
    process = psutil.Process(os.getpid())
    MAX_CPU = 20.0  # percent
    MAX_MEM_MB = 200.0  # MB
    # --- Moving average and threshold config ---
    SMOOTHING_WINDOW = 4  # Number of samples for moving average (1s window at 0.25s/sample)
    THRESHOLD_ABOVE_BASELINE = 0.02  # Minimum RMS above baseline to consider as real sound
    rms_history = []
    try:
        while not stop_audio_flag.is_set():
            try:
                arr = audio_queue.get(timeout=1)
            except queue.Empty:
                arr = np.zeros((1024, 1), dtype=np.float32)
            arr = arr.flatten().astype(np.float32)
            max_val = np.max(np.abs(arr))
            if max_val > 0:
                arr = arr / max_val
            rms = float(np.sqrt(np.mean(arr ** 2)))
            # --- Smoothing: moving average ---
            rms_history.append(rms)
            if len(rms_history) > SMOOTHING_WINDOW:
                rms_history.pop(0)
            smoothed_rms = sum(rms_history) / len(rms_history)
            # --- Threshold: must be above baseline + threshold ---
            if smoothed_rms > BASELINE_VOLUME + THRESHOLD_ABOVE_BASELINE:
                # Map RMS (0-1) to 1-500
                vol = int(np.clip(smoothed_rms * 500, 1, 500))
                send_vol = vol
            else:
                send_vol = 0
            for ws in list(audio_clients):
                try:
                    await ws.send_json({"volume": send_vol, "rms": rms})
                except Exception:
                    audio_clients.discard(ws)
            await asyncio.sleep(0.25)  # Send every 1/4 second
    finally:
        stream.stop()
        stream.close()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"status": "OK"}

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
    await websocket.send_json({"type": "update", "waveforms": shared_waveforms})
    try:
        while True:
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        pass
    finally:
        shared_waveform_clients.discard(websocket)

waveform_cross_times = []
waveform_cross_lock = threading.Lock()

# Timer for echoed events
first_echo_time = None
last_echo_time = None

@app.post("/shutdown")
async def shutdown_endpoint(request: Request):
    global frontend_final_counts
    frontend_final_counts = await request.json()
    log(f"[FRONTEND FINAL] {frontend_final_counts}")
    shutdown_ready.set()
    return JSONResponse({"ok": True})

@app.post("/waveform_cross_time")
async def waveform_cross_time(request: Request):
    global events_echoed, first_echo_time, last_echo_time
    data = await request.json()
    duration = data.get("duration")
    event_time = time.time()
    # Only log every 100th event and summary events
    log_this = False
    if events_echoed % 100 == 0:
        log_this = True
    if RUN_EVENT_LIMIT is not None and events_echoed + 1 >= RUN_EVENT_LIMIT:
        log_this = True
    if log_this:
        log(f"[LOG] Received POST at {event_time:.3f} with data: {data}")
    if duration is not None:
        with waveform_cross_lock:
            waveform_cross_times.append(float(duration))
            events_echoed += 1
            count = len(waveform_cross_times)
            # Record first and last echo times
            if first_echo_time is None:
                first_echo_time = event_time
            last_echo_time = event_time
            if log_this:
                log(f"[COUNT] Echoed events received: {count}")
            # Use RUN_EVENT_LIMIT if set, else never stop
            if RUN_EVENT_LIMIT is not None and events_echoed >= RUN_EVENT_LIMIT:
                avg = sum(waveform_cross_times) / count if count else 0
                total_echo_time = last_echo_time - first_echo_time if first_echo_time and last_echo_time else None
                log(f"[SUMMARY] Events fired (sent to frontend): {events_fired}")
                log(f"[SUMMARY] Events echoed (received from frontend): {events_echoed}")
                log(f"[SUMMARY] Durations received: {waveform_cross_times}")
                log(f"[SUMMARY] Average duration: {avg:.3f}s")
                if total_echo_time is not None:
                    log(f"[SUMMARY] Time from first to {RUN_EVENT_LIMIT}th echoed event: {total_echo_time:.3f}s")
                log(f"[SHUTDOWN] Closing all websocket connections and waiting for frontend final counts...")
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
                stop_audio_flag.set()
                def shutdown():
                    # Wait for frontend to POST final counts
                    shutdown_ready.wait(timeout=5)
                    log("[SHUTDOWN] Final frontend counts:", frontend_final_counts)
                    log("[SHUTDOWN] Gracefully stopping server.")
                    os.kill(os.getpid(), signal.SIGINT)
                threading.Thread(target=shutdown, daemon=True).start()
    else:
        if log_this:
            log(f"[WARN] No 'duration' in POST data: {data}")
    return JSONResponse({"ok": True})

# --- Client diagnostics endpoint ---
@app.get("/clients")
def get_clients():
    return {
        "audio_clients": len(audio_clients),
        "audio_clients_list": [str(getattr(ws, 'client', 'unknown')) for ws in audio_clients],
        "waveform_clients": len(shared_waveform_clients),
        "waveform_clients_list": [str(getattr(ws, 'client', 'unknown')) for ws in shared_waveform_clients],
    }
