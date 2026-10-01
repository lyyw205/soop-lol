"""썸네일 칸마다 이미지 특징(임베딩)을 뽑는다 — 고정된 공개 모델, 학습하지 않는다.

    out/ck-detector/venv/bin/python scripts/ck-local/detector/embed.py --model siglip [--vods 1,2]

입력: out/ck-detector/vods/<vod>.json (collect.mjs 가 만든 시트 목록)
출력: out/ck-detector/emb/<model>/<vod>.npz — at(전역 초, float32), emb(float16, L2 정규화)

설계: docs/CK-LOCAL-DETECTOR.md §5
- 칸 i = 파일 로컬 i×3초. 시트 k 는 칸 100k~100k+99 (column 0 중복은 collect 가 이미 뺐다).
- 192×108 칸을 비율 그대로 폭에 맞추고 위아래를 검게 채워 정사각 입력으로 만든다(화면 배치를 찌그러뜨리지 않는다).
"""
import argparse, json, os, sys, time
from pathlib import Path

import numpy as np
import torch
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "out/ck-detector"
FW, FH, PER = 192, 108, 100

def load_model(name, device):
    if name == "clip":
        import open_clip
        m, _, pre = open_clip.create_model_and_transforms("ViT-B-16", pretrained="laion2b_s34b_b88k")
        size, mean, std = 224, pre.transforms[-1].mean, pre.transforms[-1].std
        enc = lambda x: m.encode_image(x)
    elif name == "siglip":
        import open_clip
        m, _, pre = open_clip.create_model_and_transforms("ViT-B-16-SigLIP", pretrained="webli")
        size, mean, std = 224, pre.transforms[-1].mean, pre.transforms[-1].std
        enc = lambda x: m.encode_image(x)
    elif name == "dinov2":
        import timm
        m = timm.create_model("vit_small_patch14_dinov2.lvd142m", pretrained=True, num_classes=0, img_size=224)
        size, mean, std = 224, (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)
        enc = lambda x: m(x)
    else:
        sys.exit(f"모르는 모델: {name}")
    m = m.to(device).eval().half()
    return enc, size, torch.tensor(mean).view(1, 3, 1, 1), torch.tensor(std).view(1, 3, 1, 1)

def letterbox(cells, size):
    """(N,108,192,3) uint8 → (N,3,size,size) float. 폭을 size 에 맞추고 위아래 검정."""
    n = cells.shape[0]
    h = round(size * FH / FW)
    t = torch.from_numpy(cells).permute(0, 3, 1, 2).float() / 255.0
    t = torch.nn.functional.interpolate(t, size=(h, size), mode="bilinear", align_corners=False)
    out = torch.zeros(n, 3, size, size)
    top = (size - h) // 2
    out[:, :, top:top + h, :] = t
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="siglip")
    ap.add_argument("--vods", default="")
    ap.add_argument("--batch", type=int, default=256)
    a = ap.parse_args()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    enc, size, mean, std = load_model(a.model, device)
    mean, std = mean.to(device).half(), std.to(device).half()
    dst = OUT / "emb" / a.model
    dst.mkdir(parents=True, exist_ok=True)
    files = sorted((OUT / "vods").glob("*.json"))
    want = set(filter(None, a.vods.split(",")))
    t0 = time.time(); total = 0
    for f in files:
        meta = json.loads(f.read_text())
        vod = str(meta["vod"])
        if want and vod not in want: continue
        if meta.get("missing"): continue
        path = dst / f"{vod}.npz"
        if path.exists(): continue
        ats, embs = [], []
        for p in meta["parts"]:
            if not p.get("reliable") or not p["cells"]: continue
            for k, sheet in enumerate(p["sheets"]):
                n = min(PER, p["cells"] - k * PER)
                if n <= 0: break
                img = np.asarray(Image.open(ROOT / sheet).convert("RGB"))
                cells = np.stack([img[(c // 10) * FH:(c // 10 + 1) * FH, (c % 10) * FW:(c % 10 + 1) * FW] for c in range(n)])
                x = letterbox(cells, size).to(device).half()
                x = (x - mean) / std
                with torch.no_grad():
                    e = enc(x).float()
                e = torch.nn.functional.normalize(e, dim=-1).cpu().numpy().astype(np.float16)
                embs.append(e)
                ats.extend(p["offset"] + (k * PER + np.arange(n)) * 3)
        if not embs: continue
        np.savez(path, at=np.array(ats, dtype=np.float32), emb=np.concatenate(embs))
        total += len(ats)
        print(f"  {vod} 칸 {len(ats)} · 누계 {total} · {time.time() - t0:.0f}s", flush=True)
    print(f"완료 {a.model} 칸 {total} · {time.time() - t0:.0f}s")

if __name__ == "__main__":
    main()
