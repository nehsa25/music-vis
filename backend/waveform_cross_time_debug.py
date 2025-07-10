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
    print(f"[AUDIO_WS] Client connected: {websocket.client}")
    audio_clients.add(websocket)
    try:
        while True:
            await asyncio.sleep(1)
    except WebSocketDisconnect:
        print(f"[AUDIO_WS] Client disconnected: {websocket.client}")
    finally:
        audio_clients.discard(websocket)

stop_audio_flag = threading.Event()

async def audio_broadcast_loop():
    global events_fired
    stream = start_audio_stream()
    log_volumes = []
    log_start = time.time()
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
            log_volumes.append(rms)
            now = time.time()
            if now - log_start >= 5.0:
                avg = sum(log_volumes) / len(log_volumes) if log_volumes else 0
                level = min(50, int(avg * 100))
                print('.' * max(1, level))
                log_volumes = []
                log_start = now
            for ws in list(audio_clients):
                try:
                    await ws.send_bytes(arr.tobytes())
                    events_fired += 1
                except Exception:
                    audio_clients.discard(ws)
            await asyncio.sleep(0.04)
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

@app.post("/shutdown")
async def shutdown_endpoint(request: Request):
    global frontend_final_counts
    frontend_final_counts = await request.json()
    print(f"[FRONTEND FINAL] {frontend_final_counts}", flush=True)
    shutdown_ready.set()
    return JSONResponse({"ok": True})

@app.post("/waveform_cross_time")
async def waveform_cross_time(request: Request):
    global events_echoed
    data = await request.json()
    duration = data.get("duration")
    event_time = time.time()
    print(f"[LOG] Received POST at {event_time:.3f} with data: {data}", flush=True)
    if duration is not None:
        with waveform_cross_lock:
            waveform_cross_times.append(float(duration))
            events_echoed += 1
            count = len(waveform_cross_times)
            print(f"[LOG] Appended duration {duration}. Total echoed events: {count}", flush=True)
            print(f"[LOG] Current durations: {waveform_cross_times}", flush=True)
            print(f"[COUNT] Echoed events received: {count}", flush=True)
            if events_echoed >= 50:
                avg = sum(waveform_cross_times) / count if count else 0
                print(f"[SUMMARY] Events fired (sent to frontend): {events_fired}", flush=True)
                print(f"[SUMMARY] Events echoed (received from frontend): {events_echoed}", flush=True)
                print(f"[SUMMARY] Durations received: {waveform_cross_times}", flush=True)
                print(f"[SUMMARY] Average duration: {avg:.3f}s", flush=True)
                print(f"[SHUTDOWN] Closing all websocket connections and waiting for frontend final counts...", flush=True)
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
                    print("[SHUTDOWN] Final frontend counts:", frontend_final_counts, flush=True)
                    print("[SHUTDOWN] Gracefully stopping server.", flush=True)
                    os.kill(os.getpid(), signal.SIGINT)
                threading.Thread(target=shutdown, daemon=True).start()
    else:
        print(f"[WARN] No 'duration' in POST data: {data}", flush=True)
    return JSONResponse({"ok": True})
