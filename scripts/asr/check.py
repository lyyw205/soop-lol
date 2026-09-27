"""GPU installation smoke check; short audio only, not a VOD benchmark."""
import argparse
import json
import os
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from runtime import load_engine

parser = argparse.ArgumentParser()
parser.add_argument("engine", choices=["sensevoice", "qwen"])
parser.add_argument("--audio", type=Path)
args = parser.parse_args()
root = Path(os.environ["ASR_ROOT"])
record = json.loads((root / f"{args.engine}.model.json").read_text())
if not torch.cuda.is_available():
    raise SystemExit("CUDA is unavailable. Check WSL GPU access and the NVIDIA driver.")
torch.set_num_threads(4)
torch.cuda.reset_peak_memory_stats()
if args.audio:
    audio_path = args.audio
else:
    sensevoice_record = json.loads((root / "sensevoice.model.json").read_text())
    audio_path = Path(sensevoice_record["path"]) / "example" / "ko.mp3"
info = sf.info(audio_path)
if info.duration > 60:
    raise SystemExit("Installation check accepts at most 60 seconds; use a short sample.")
waveform, sample_rate = sf.read(audio_path, dtype="float32")
if waveform.ndim == 2:
    waveform = waveform.mean(axis=1)
if sample_rate != 16000:
    import librosa
    waveform = librosa.resample(waveform, orig_sr=sample_rate, target_sr=16000)
waveform = np.ascontiguousarray(waveform)
start = time.perf_counter()
transcribe = load_engine(args.engine, record["path"], max_tokens=256)

torch.cuda.synchronize()
load_seconds = time.perf_counter() - start
runs = []
with torch.inference_mode():
    for _ in range(2):
        start = time.perf_counter()
        text = transcribe(waveform)
        torch.cuda.synchronize()
        runs.append({"seconds": round(time.perf_counter() - start, 3), "text": text})
if not text.strip():
    raise SystemExit("Smoke check failed: empty transcript.")
report = {
    "engine": args.engine, "model_revision": record["revision"],
    "gpu": torch.cuda.get_device_name(0), "torch": torch.__version__,
    "cuda": torch.version.cuda, "audio": str(audio_path),
    "audio_seconds": round(len(waveform) / 16000, 3),
    "model_load_seconds": round(load_seconds, 3), "runs": runs,
    "peak_allocated_mib": round(torch.cuda.max_memory_allocated() / 1024**2),
    "peak_reserved_mib": round(torch.cuda.max_memory_reserved() / 1024**2),
    "note": "Short official sample: installation check, not CK accuracy/throughput validation.",
}
output = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
(root / f"{args.engine}.check.json").write_text(output, encoding="utf-8")
print(output)
