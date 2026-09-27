"""Download official model weights into the project-local HF cache."""
import argparse
import json
import os
from pathlib import Path

from huggingface_hub import snapshot_download

parser = argparse.ArgumentParser()
parser.add_argument("engine", choices=["sensevoice", "qwen"])
args = parser.parse_args()
root = Path(os.environ["ASR_ROOT"])
repo = {
    "sensevoice": "FunAudioLLM/SenseVoiceSmall",
    "qwen": "Qwen/Qwen3-ASR-0.6B",
}[args.engine]
model_path = snapshot_download(repo_id=repo, max_workers=2)
record = {"repo": repo, "revision": Path(model_path).name, "path": model_path}
(root / f"{args.engine}.model.json").write_text(
    json.dumps(record, indent=2) + "\n", encoding="utf-8"
)
print(json.dumps(record, indent=2), flush=True)
