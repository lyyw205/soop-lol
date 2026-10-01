"""VOD 하나의 FC 결과 화면 칸 찾기 — FC 전용 판별기(fc.npz). ck-local 준비가 받아 둔 썸네일을 그대로 쓴다.

    $PY scripts/fco-local/fc_detect.py --vod 207643193
입력: out/ck/<vod>/local/sheets.json (npm run ck:local -- --vod <번호> 가 만든 시트 목록 — 롤·FC 공용 준비)
출력: out/ck/<vod>/local/fc.json — {version, threshold, results:[초…], blocks:[{from,to}]} . locate 가 이걸 먼저 읽는다.
★ ck-local 의 판별기·산출물(scan.json·map.txt)은 건드리지 않는다. 위치 안내일 뿐 — 결과 화면인지는 원본을 보고 정한다.
"""
import argparse, json
import numpy as np
from fclib import OUT, ROOT, Embedder, cells_of, crop

ap = argparse.ArgumentParser()
ap.add_argument("--vod", type=int, required=True)
a = ap.parse_args()
mp = OUT / "model" / "siglip" / "fc.npz"
if not mp.exists(): raise SystemExit("FC 판별기가 없다 — scripts/fco-local/fc_train.py fit 먼저")
m = np.load(mp); names = [str(x) for x in m["classes"]]; thr = float(m["threshold"])
meta_p = ROOT / "out/ck" / str(a.vod) / "local" / "sheets.json"
if not meta_p.exists(): raise SystemExit(f"준비물이 없다 — npm run ck:local -- --vod {a.vod} 먼저")
cells = cells_of(json.loads(meta_p.read_text()))
emb = Embedder()
E = emb([crop(sheet, c) for _, sheet, c in cells])
z = E @ m["coef"].T + m["intercept"]; z = np.exp(z - z.max(1, keepdims=True)); P = z / z.sum(1, keepdims=True)
at = np.array([t for t, _, _ in cells])
r = P[:, names.index("fc_result")]
hits = [int(t) for t in at[r >= thr]]
results = [t for i, t in enumerate(hits) if i == 0 or t - hits[i - 1] > 6]   # 붙은 칸은 첫 칸만
fc_any = P[:, [names.index(n) for n in names if n.startswith("fc_")]].sum(1) >= 0.5
blocks, cur = [], None
for t, f in zip(at, fc_any):
    if f and cur and t - cur[1] <= 30: cur[1] = t
    elif f: cur = [t, t]; blocks.append(cur)
blocks = [{"from": int(b[0]), "to": int(b[1])} for b in blocks if b[1] - b[0] >= 180]
out = {"version": str(m["version"]), "threshold": thr, "cells": len(cells), "results": results, "blocks": blocks}
dst = ROOT / "out/ck" / str(a.vod) / "local" / "fc.json"
dst.write_text(json.dumps(out))
print(f"FC 결과 화면 후보 {len(results)}곳 · FC 구간 {len(blocks)}개 → {dst.relative_to(ROOT)}")
