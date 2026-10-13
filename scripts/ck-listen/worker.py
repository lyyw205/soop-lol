"""One SenseVoice load per preparation; JSON lines over stdin/stdout. No LLM."""
import contextlib
import json
import sys
import time
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "asr"))
with contextlib.redirect_stdout(sys.stderr):
    import numpy as np
    from runtime import load_engine
    transcribe = load_engine("sensevoice", sys.argv[1])
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    try:
        request = json.loads(line)
        with wave.open(request["wav"], "rb") as wav:
            if wav.getframerate() != 16000 or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                raise ValueError("Expected mono 16k PCM16 WAV")
            samples = np.frombuffer(wav.readframes(wav.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
        seconds = len(samples) / 16000
        if abs(seconds - request["seconds"]) > 0.25:
            raise ValueError(f"Truncated audio: requested {request['seconds']}, got {seconds}")
        # AAC/ffmpeg can add a fraction of a frame past -t. Don't create a
        # zero-duration final ASR chunk or attribute that padding to the VOD.
        samples = samples[:round(request["seconds"] * 16000)]
        chunks = []
        for offset in range(0, len(samples), 30 * 16000):
            waveform = samples[offset:offset + 30 * 16000]
            started = time.monotonic()
            with contextlib.redirect_stdout(sys.stderr):
                text = transcribe(waveform)
            at = request["at"] + offset / 16000
            chunks.append({"at": at, "end": min(request["at"] + request["seconds"], at + len(waveform) / 16000),
                           "text": text, "inference_seconds": time.monotonic() - started})
        print(json.dumps({"chunks": chunks}, ensure_ascii=False), flush=True)
    except Exception as error:
        print(f"ASR error: {error}", file=sys.stderr, flush=True)
        print(json.dumps({"error": str(error)}, ensure_ascii=False), flush=True)
