"""Bounded-memory, resumable transcription with original VOD chunk timestamps."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import time

process_start = time.perf_counter()
import numpy as np
import soundfile as sf
import torch
from runtime import load_engine

parser = argparse.ArgumentParser()
parser.add_argument("engine", choices=["sensevoice", "qwen"])
parser.add_argument("manifest", type=Path)
parser.add_argument("--chunk-seconds", type=int, default=30)
args = parser.parse_args()
if not 5 <= args.chunk_seconds <= 30:
    raise SystemExit("chunk-seconds must be between 5 and 30")
manifest = json.loads(args.manifest.read_text())
if not manifest.get("complete"):
    raise SystemExit("Audio extraction is incomplete")
root = Path(os.environ["ASR_ROOT"])
model_info = json.loads((root / f"{args.engine}.model.json").read_text())
directory = args.manifest.resolve().parent
output = directory / f"{args.engine}.transcript.json"
signature = {
    "engine": args.engine, "model": model_info["repo"], "revision": model_info["revision"],
    "chunk_seconds": args.chunk_seconds, "overlap_seconds": 0, "vad": False,
    "max_new_tokens": 512 if args.engine == "qwen" else None,
    "clips": [{"id": c["id"], "at": c["at"], "seconds": c["seconds"],
               "sha256": hashlib.sha256(Path(c["audio"]).read_bytes()).hexdigest()}
              for c in manifest["clips"]],
}
data = {"signature": signature, "chunks": [], "sessions": []}
if output.exists():
    data = json.loads(output.read_text())
    if data["signature"] != signature:
        raise SystemExit("Existing checkpoint uses different audio/settings; preserve it and use a new directory")
done = {c["key"] for c in data["chunks"]}
expected = sum(int(np.ceil(c["seconds"] / args.chunk_seconds)) for c in manifest["clips"])
if len(done) == expected and data.get("complete") and data.get("summary") and (directory / f"{args.engine}.txt").exists():
    print(f"Already complete: {output}")
    raise SystemExit(0)
if not torch.cuda.is_available():
    raise SystemExit("CUDA unavailable; GPU access is required for this comparison")
torch.set_num_threads(4)
torch.cuda.reset_peak_memory_stats()
load_start = time.perf_counter()
transcribe = load_engine(args.engine, model_info["path"])
torch.cuda.synchronize()
session = {"started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "model_load_seconds": time.perf_counter() - load_start,
           "new_chunks": 0, "gpu": torch.cuda.get_device_name(0),
           "torch": torch.__version__, "cuda": torch.version.cuda}
data["sessions"].append(session)


def save():
    session.update({"wall_seconds": time.perf_counter() - process_start,
                    "peak_allocated_mib": torch.cuda.max_memory_allocated() / 1024**2,
                    "peak_reserved_mib": torch.cuda.max_memory_reserved() / 1024**2,
                    "peak_process_rss_mib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024})
    data["complete"] = len(data["chunks"]) == expected
    temp = output.with_suffix(".json.part")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    temp.replace(output)


with torch.inference_mode():
    for clip in manifest["clips"]:
        waveform, rate = sf.read(clip["audio"], dtype="float32")
        if rate != 16000 or waveform.ndim != 1:
            raise SystemExit("Expected mono 16kHz audio from sample-vod.mjs")
        for index, start_sample in enumerate(range(0, len(waveform), rate * args.chunk_seconds)):
            key = f"{clip['id']}:{index}"
            if key in done:
                continue
            chunk = np.ascontiguousarray(waveform[start_sample:start_sample + rate * args.chunk_seconds])
            started = time.perf_counter()
            text = transcribe(chunk)
            torch.cuda.synchronize()
            elapsed = time.perf_counter() - started
            at = clip["at"] + start_sample / rate
            data["chunks"].append({"key": key, "clip_id": clip["id"], "at": at,
                                   "end": at + len(chunk) / rate, "audio_seconds": len(chunk) / rate,
                                   "inference_seconds": elapsed, "text": text})
            done.add(key)
            session["new_chunks"] += 1
            save()
            print(f"{args.engine} {len(done)}/{expected}: VOD {at:.1f}s, inference {elapsed:.2f}s", flush=True)

data["chunks"].sort(key=lambda c: c["at"])
audio_seconds = sum(c["audio_seconds"] for c in data["chunks"])
inference_seconds = sum(c["inference_seconds"] for c in data["chunks"])
data["summary"] = {"audio_seconds": audio_seconds, "inference_seconds": inference_seconds,
                   "audio_per_inference_second": audio_seconds / inference_seconds,
                   "session_wall_seconds": sum(s["wall_seconds"] for s in data["sessions"]),
                   "timestamp_note": "Input chunk boundaries, not word-aligned timestamps",
                   "quality_note": "No reference transcript; these results do not establish accuracy"}
save()
(directory / f"{args.engine}.txt").write_text("\n\n".join(
    f"({c['at']:.3f}–{c['end']:.3f}) {c['text']}" for c in data["chunks"]) + "\n")
print(json.dumps(data["summary"], ensure_ascii=False, indent=2))
