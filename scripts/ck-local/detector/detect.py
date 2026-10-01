"""VOD 한 개의 썸네일 칸 전부에 결과창 점수를 매기고 후보 덩어리를 낸다 (ck-local 준비 단계가 부른다).

    out/ck-detector/venv/bin/python scripts/ck-local/detector/detect.py --meta out/ck/<vod>/local/sheets.json

입력: sheets.json — scan.mjs 가 쓴 파일별 오프셋·칸 수·시트 경로(collect.mjs 의 vods/<vod>.json 과 같은 형식)
출력(stdout JSON): {model, threshold, min_len, cells, candidates:[{from, to, peak, peak_score, len}]}
판별기: out/ck-detector/model/<model>/clf.npz (train.py fit 이 만든다). 설계: docs/CK-LOCAL-DETECTOR.md §10
"""
import argparse, json, sys
from pathlib import Path

import numpy as np
import torch
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
from embed import FH, FW, PER, letterbox, load_model  # noqa: E402

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "out/ck-detector"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--meta", required=True)
    ap.add_argument("--model", default="siglip")
    ap.add_argument("--threshold", type=float, default=0.7)
    ap.add_argument("--min-len", type=int, default=2)
    ap.add_argument("--batch", type=int, default=200)
    a = ap.parse_args()
    clf = np.load(OUT / "model" / a.model / "clf.npz")
    w, b = clf["coef"].astype(np.float32), float(clf["intercept"][0])
    device = "cuda" if torch.cuda.is_available() else "cpu"
    enc, size, mean, std = load_model(a.model, device)
    mean, std = mean.to(device).half(), std.to(device).half()
    meta = json.loads(Path(a.meta).read_text())
    ats, scores = [], []
    for p in meta["parts"]:
        if not p.get("reliable") or not p["cells"]: continue
        for k, sheet in enumerate(p["sheets"]):
            n = min(PER, p["cells"] - k * PER)
            if n <= 0: break
            img = np.asarray(Image.open(ROOT / sheet).convert("RGB"))
            cells = np.stack([img[(c // 10) * FH:(c // 10 + 1) * FH, (c % 10) * FW:(c % 10 + 1) * FW] for c in range(n)])
            x = (letterbox(cells, size).to(device).half() - mean) / std
            with torch.no_grad():
                e = torch.nn.functional.normalize(enc(x).float(), dim=-1).cpu().numpy()
            scores.append(1 / (1 + np.exp(-(e @ w + b))))
            ats.extend(p["offset"] + (k * PER + np.arange(n)) * 3)
    at = np.array(ats, dtype=np.float64); s = np.concatenate(scores) if scores else np.zeros(0)
    # 덩어리: 문턱을 넘는 칸, 2칸(6초) 이하 끊김은 잇는다. 파일 경계를 넘는 덩어리는 시각 차로 끊긴다.
    hi = np.where(s >= a.threshold)[0]
    cands = []
    if len(hi):
        groups = np.split(hi, np.where((np.diff(hi) > 2) | (np.diff(at[hi]) > 9))[0] + 1)
        for g in groups:
            if len(g) < a.min_len: continue
            m = int(g[np.argmax(s[g])])
            cands.append({"from": round(float(at[g[0]])), "to": round(float(at[g[-1]])), "peak": round(float(at[m])),
                          "peak_score": round(float(s[m]), 3), "len": int(len(g))})
    print(json.dumps({"model": a.model, "threshold": a.threshold, "min_len": a.min_len, "cells": int(len(s)), "candidates": cands}))

if __name__ == "__main__":
    main()
