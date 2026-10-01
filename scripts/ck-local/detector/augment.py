"""늘려 보기 학습 재료 — 정답 칸마다 실제로 일어나는 변화(창 크기·위치·가림)를 준 사본의 특징을 뽑는다.

    $PY scripts/ck-local/detector/augment.py --model siglip --k 4

출력: out/ck-detector/aug/<model>.npz — emb, label, vod, cell(원본 칸 번호), kind(0=원본 1=변형)
목적: 배경·오버레이 같은 "같이 찍힌 것"(김민교 분홍 바탕 등)으로 외우는 지름길을 막는다. docs/CK-LOCAL-DETECTOR.md §12
변화는 현실 범위 안에서만 — 정답이 바뀌면(결과창이 잘려 나가면) 오히려 해롭다:
  · 확대: 칸의 70~95% 영역을 잘라 다시 키운다(창이 화면을 더 크게 차지한 방송)
  · 축소: 칸을 60~90% 로 줄여 다른 칸 위에 얹는다(창이 작고 주변이 다른 방송)
  · 가림: 같은 채널 다른 칸의 조각(캠·캐릭터·채팅처럼)을 가장자리·모서리에 10~25% 얹는다
"""
import argparse, json, random, sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
sys.argv, _argv = [sys.argv[0]], sys.argv
import train as T  # noqa: E402
from embed import FH, FW, letterbox, load_model  # noqa: E402
sys.argv = _argv

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="siglip")
    ap.add_argument("--k", type=int, default=4)
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    rnd = random.Random(a.seed)
    metas = T.load_meta(); E = T.load_emb(a.model, metas); L = T.load_labels(E, metas)
    keys = sorted(L)
    sheet_cache = {}
    order = {}   # vod → [(시트 경로, 칸)] — embed.py 가 특징을 뽑은 순서 그대로(특징 i 번 = 이 목록 i 번)
    for v, m in metas.items():
        lst = []
        for p in m["parts"]:
            if not p.get("reliable") or not p["cells"]: continue
            for k, path in enumerate(p["sheets"]):
                n = min(100, p["cells"] - k * 100)
                if n <= 0: break
                lst.extend((path, c) for c in range(n))
        order[v] = lst
    def cell(v, i):
        if i >= len(order[v]): return None
        path, c = order[v][i]
        if path not in sheet_cache:
            if len(sheet_cache) > 64: sheet_cache.pop(next(iter(sheet_cache)))
            sheet_cache[path] = Image.open(T.ROOT / path).convert("RGB")
        return sheet_cache[path].crop(((c % 10) * FW, (c // 10) * FH, (c % 10 + 1) * FW, (c // 10 + 1) * FH))
    def zoom_in(im):
        s = rnd.uniform(0.70, 0.95); w, h = int(FW * s), int(FH * s)
        x, y = rnd.randint(0, FW - w), rnd.randint(0, FH - h)
        return im.crop((x, y, x + w, y + h)).resize((FW, FH), Image.BILINEAR)
    def zoom_out(im, bg):
        s = rnd.uniform(0.60, 0.90); w, h = int(FW * s), int(FH * s)
        out = bg.copy(); out.paste(im.resize((w, h), Image.BILINEAR), (rnd.randint(0, FW - w), rnd.randint(0, FH - h)))
        return out
    def occlude(im, src):
        out = im.copy()
        s = rnd.uniform(0.10, 0.25) ** 0.5; w, h = int(FW * s * rnd.uniform(0.7, 1.3)), int(FH * s * rnd.uniform(0.7, 1.3))
        w, h = min(w, FW // 2), min(h, FH // 2)
        sx, sy = rnd.randint(0, FW - w), rnd.randint(0, FH - h)
        x = rnd.choice([0, FW - w, rnd.randint(0, FW - w)]); y = rnd.choice([0, FH - h, rnd.randint(0, FH - h)])
        out.paste(src.crop((sx, sy, sx + w, sy + h)), (x, y))
        return out
    by_channel = {}
    for v, i in keys: by_channel.setdefault(metas[v]["channel"], []).append((v, i))
    imgs, meta = [], []
    for v, i in keys:
        im = cell(v, i)
        if im is None: continue
        for k in range(a.k):
            # ★ 가림·배경 조각은 **같은 채널** 사진에서만 고른다. 전체에서 고르면 시험(스트리머 하나 빼기)에 쓸 채널의
            #   이미지 조각이 학습 변형에 섞여 "처음 보는 스트리머" 조건이 약해진다(Codex 검토, 2026-10-01).
            same = by_channel[metas[v]["channel"]]
            ov, oi = same[rnd.randrange(len(same))]
            other = cell(ov, oi) or im
            op = rnd.choice(["in", "out", "occ", "in+occ"])
            x = zoom_in(im) if op in ("in", "in+occ") else zoom_out(im, other) if op == "out" else im
            if "occ" in op: x = occlude(x, other)
            imgs.append(np.asarray(x)); meta.append((v, i, L[(v, i)][0]))
    print(f"정답 칸 {len(keys)} · 변형 {len(imgs)}", flush=True)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    enc, size, mean, std = load_model(a.model, device)
    mean, std = mean.to(device).half(), std.to(device).half()
    embs = []
    for s in range(0, len(imgs), 200):
        x = (letterbox(np.stack(imgs[s:s + 200]), size).to(device).half() - mean) / std
        with torch.no_grad():
            embs.append(torch.nn.functional.normalize(enc(x).float(), dim=-1).cpu().numpy().astype(np.float16))
    dst = T.OUT / "aug"; dst.mkdir(parents=True, exist_ok=True)
    np.savez(dst / f"{a.model}.npz", emb=np.concatenate(embs), vod=np.array([m[0] for m in meta]),
             cell=np.array([m[1] for m in meta]), label=np.array([m[2] for m in meta]))
    print("저장", dst / f"{a.model}.npz")

if __name__ == "__main__":
    main()
