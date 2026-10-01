"""FC 전용 판별기 공용 — 썸네일 칸 목록·임베딩. (docs/FCO-SCREEN-MATCH-DESIGN.md §4.1 4단계, A안)

★ ck-local 판별기(out/ck-detector/model/…)는 쓰지 않는다. 같은 고정 공개 모델(SigLIP)과 칸 자르기 함수만 빌려 온다
  (scripts/ck-local/detector/embed.py — 읽기만). FC 판별기 파일은 out/fco-detector/model/<model>/fc.npz 하나다.
"""
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/ck-local/detector"))
from embed import FH, FW, PER, letterbox, load_model  # noqa: E402

OUT = ROOT / "out/fco-detector"
CK = ROOT / "out/ck-detector"     # ck-local 의 라벨·임베딩 — **읽기만** 한다(FC 라벨을 같이 쓰려고)

def cells_of(meta):
    """[(전역 초, 시트 경로, 시트 안 칸 번호)] — embed.py 와 같은 순서(파일 → 시트 → 칸)."""
    out = []
    for p in meta["parts"]:
        if not p.get("reliable") or not p["cells"]: continue
        for k, sheet in enumerate(p["sheets"]):
            n = min(PER, p["cells"] - k * PER)
            if n <= 0: break
            out.extend((p["offset"] + (k * PER + c) * 3, sheet, c) for c in range(n))
    return out

_cache = {}
def crop(sheet, c):
    if sheet not in _cache:
        if len(_cache) > 64: _cache.pop(next(iter(_cache)))
        _cache[sheet] = np.asarray(Image.open(ROOT / sheet).convert("RGB"))
    img = _cache[sheet]
    return img[(c // 10) * FH:(c // 10 + 1) * FH, (c % 10) * FW:(c % 10 + 1) * FW]

class Embedder:
    def __init__(self, model="siglip"):
        import torch
        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.enc, self.size, mean, std = load_model(model, self.device)
        self.mean, self.std = mean.to(self.device).half(), std.to(self.device).half()
    def __call__(self, crops, batch=200):
        out = []
        for s in range(0, len(crops), batch):
            x = (letterbox(np.stack(crops[s:s + batch]), self.size).to(self.device).half() - self.mean) / self.std
            with self.torch.no_grad():
                out.append(self.torch.nn.functional.normalize(self.enc(x).float(), dim=-1).cpu().numpy())
        return np.concatenate(out) if out else np.zeros((0, 768), np.float32)

def load_json(p):
    return json.loads(Path(p).read_text())
