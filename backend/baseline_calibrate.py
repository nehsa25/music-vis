import sounddevice as sd
import numpy as np
import time

DURATION = 60  # seconds
SAMPLERATE = 44100
BLOCKSIZE = 1024
CHANNELS = 1

print(f"[BASELINE] Listening for {DURATION} seconds to establish baseline RMS volume...")

rms_values = []
def callback(indata, frames, time_info, status):
    arr = indata.flatten().astype(np.float32)
    max_val = np.max(np.abs(arr))
    if max_val > 0:
        arr = arr / max_val
    rms = float(np.sqrt(np.mean(arr ** 2)))
    rms_values.append(rms)

with sd.InputStream(callback=callback, channels=CHANNELS, samplerate=SAMPLERATE, blocksize=BLOCKSIZE):
    time.sleep(DURATION)

if rms_values:
    baseline = float(np.mean(rms_values))
else:
    baseline = 0.0

with open("baseline_volume.txt", "w") as f:
    f.write(str(baseline))

print(f"[BASELINE] Baseline RMS volume saved: {baseline}")
