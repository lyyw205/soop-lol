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
from runs import group_runs  # noqa: E402

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
    # 화면 종류 라벨(multi.py) — 있으면 구간 지도를 같이 낸다. 판단이 아니라 위치 안내다.
    mp = OUT / "model" / a.model / "multi.npz"
    multi = np.load(mp) if mp.exists() else None
    device = "cuda" if torch.cuda.is_available() else "cpu"
    enc, size, mean, std = load_model(a.model, device)
    mean, std = mean.to(device).half(), std.to(device).half()
    meta = json.loads(Path(a.meta).read_text())
    ats, scores, kinds, confs = [], [], [], []
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
            if multi is not None:
                z = e @ multi["coef"].T + multi["intercept"]; z = np.exp(z - z.max(1, keepdims=True)); pr = z / z.sum(1, keepdims=True)
                kinds.append(pr.argmax(1)); confs.append(pr.max(1))
            ats.extend(p["offset"] + (k * PER + np.arange(n)) * 3)
    at = np.array(ats, dtype=np.float64); s = np.concatenate(scores) if scores else np.zeros(0)
    # 덩어리: 문턱을 넘는 칸, 2칸(6초) 이하 끊김은 잇는다. 파일 경계를 넘는 덩어리는 시각 차로 끊긴다.
    cands = []
    for g0, g1 in group_runs(at, s, a.threshold, a.min_len):
            g = np.arange(g0, g1 + 1); g = g[s[g] >= a.threshold] if (s[g] >= a.threshold).any() else g
            m = int(g[np.argmax(s[g])])
            cands.append({"from": round(float(at[g0])), "to": round(float(at[g1])), "peak": round(float(at[m])),
                          "peak_score": round(float(s[m]), 3), "len": int(len(g))})
    timeline = []
    if multi is not None and kinds:
        names = [str(x) for x in multi["classes"]]; k = np.concatenate(kinds); c = np.concatenate(confs)
        lab = [names[x] if cf >= float(multi["min_conf"]) else "unknown" for x, cf in zip(k, c)]
        # 구간으로 묶는다. 짧은 끊김(2칸 이하의 모름·다른 라벨)은 앞 구간에 붙인다 — 지도가 수천 줄이 되지 않게.
        # 결과창·그래프·종료처럼 짧게 뜨는 화면은 1칸이어도 따로 둔다.
        SHORT_OK = {"result", "graph", "end", "fc_result"}
        for i, l in enumerate(lab):
            t = float(at[i])
            if timeline and timeline[-1]["label"] == l and t - timeline[-1]["to"] <= 9:
                timeline[-1]["to"] = t; timeline[-1]["n"] += 1
            else:
                timeline.append({"label": l, "from": t, "to": t, "n": 1})
        merged = []
        for seg in timeline:
            if merged and seg["n"] <= 2 and seg["label"] not in SHORT_OK and seg["from"] - merged[-1]["to"] <= 9:
                merged[-1]["to"] = seg["to"]; merged[-1]["n"] += seg["n"]; continue
            if merged and merged[-1]["label"] == seg["label"] and seg["from"] - merged[-1]["to"] <= 15:
                merged[-1]["to"] = seg["to"]; merged[-1]["n"] += seg["n"]; continue
            merged.append(dict(seg))
        timeline = [{"label": x["label"], "from": round(x["from"]), "to": round(x["to"]), "n": x["n"]} for x in merged]
    print(json.dumps({"model": a.model, "threshold": a.threshold, "min_len": a.min_len, "cells": int(len(s)), "candidates": cands, "timeline": timeline}))

if __name__ == "__main__":
    main()
