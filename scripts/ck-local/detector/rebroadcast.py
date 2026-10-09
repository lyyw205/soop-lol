"""남의 방송 화면 판별기 — 방송 주인 화면에 다른 사람 방송 플레이어(브라우저 SOOP 등)가 떠 있는가.

    $PY scripts/ck-local/detector/rebroadcast.py embed   # 정답 시각 근처 칸만 SigLIP 특징 계산(GPU) → out/ck-rebroadcast/emb.npz
    $PY scripts/ck-local/detector/rebroadcast.py eval    # 채널 하나씩 빼고 재현율·정확도
    $PY scripts/ck-local/detector/rebroadcast.py fit     # 전부로 학습 → out/ck-rebroadcast/model.npz

정답: scripts/ck-local/rebroadcast-seed.ts 가 DB 시점 출처(rebroadcast / own)로 뽑은 out/ck-rebroadcast/labels.jsonl.
★ 화면 종류(결과창·게임 중…)와 별개인 속성이라 multi.py 에 칸을 더하지 않고 따로 판정한다(메모장 판별과 같은 방식).
★ 메모장은 창이 작아 전역 특징이 약했지만, 남의 방송 화면은 배치 전체가 바뀐다(브라우저 틀·오른쪽 채팅·작아진 게임 화면).
  그래서 먼저 기존 전역 SigLIP 특징 + 선형 분류기로 잰다. 부족하면 메모장의 부분별 특징으로 넘어간다.
★ 정답 사진 한 장 = 그 칸 ±1칸(결과창은 몇 초씩 떠 있다). 본인 화면 사진은 그 칸만. 학습/평가는 채널로 나눈다.
설계·정책: docs/CK-LOCAL-DETECTOR.md §21
"""
import argparse, json, sys, time
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "out/ck-rebroadcast"
PER = 100
NEAR = {"rebroadcast": (-1, 0, 1), "own": (0,)}


def labels():
    rows = [json.loads(l) for l in (OUT / "labels.jsonl").read_text().splitlines() if l.strip()]
    return rows


def cell_of(parts, t):
    """전역 초 t → (시트 경로, 시트 안 칸 번호, 칸 시작 초). 시트 목록 밖이면 None."""
    for p in parts:
        if not p.get("reliable") or not p.get("cells"): continue
        i = int((t - p["offset"]) // 3)
        if 0 <= i < p["cells"]:
            k, c = divmod(i, PER)
            if k < len(p["sheets"]): return p["sheets"][k], c, p["offset"] + i * 3
    return None


def embed(a):
    import torch
    from PIL import Image
    from embed import load_model, letterbox
    from sheets import cell_image
    device = "cuda" if torch.cuda.is_available() else "cpu"
    enc, size, mean, std = load_model("siglip", device)
    mean, std = mean.to(device).half(), std.to(device).half()
    want = defaultdict(dict)   # 시트 → {칸: (vod, 칸 시각, 라벨, 채널)}
    missing = 0
    for r in labels():
        meta = ROOT / f"out/ck/{r['vod']}/local/sheets.json"
        parts = json.loads(meta.read_text())["parts"]
        for d in NEAR[r["label"]]:
            hit = cell_of(parts, r["at"] + 3 * d)
            if not hit: missing += 1; continue
            sheet, c, at = hit
            prev = want[sheet].get(c)
            # 같은 칸에 두 라벨이 겹치면 남의 방송이 이긴다(근거 사진 자체가 그 화면이다).
            if prev and prev[2] == "rebroadcast": continue
            want[sheet][c] = (r["vod"], at, r["label"], r["channel"])
    X, meta_rows, t0, unreadable = [], [], time.time(), 0
    for n, (sheet, cells) in enumerate(sorted(want.items())):
        try: img = Image.open(ROOT / sheet).convert("RGB")
        except Exception: unreadable += 1; continue
        idx = sorted(cells)
        crops = np.stack([np.asarray(cell_image(img, c)) for c in idx])
        x = (letterbox(crops, size).to(device).half() - mean) / std
        with torch.no_grad(): e = torch.nn.functional.normalize(enc(x).float(), dim=-1).cpu().numpy().astype(np.float16)
        X.append(e); meta_rows += [cells[c] for c in idx]
        if n % 200 == 0: print(f"  시트 {n}/{len(want)} · {time.time() - t0:.0f}s", flush=True)
    np.savez(OUT / "emb.npz", emb=np.concatenate(X), vod=np.array([m[0] for m in meta_rows]),
             at=np.array([m[1] for m in meta_rows], dtype=np.float32), label=np.array([str(m[2]) for m in meta_rows]),
             channel=np.array([str(m[3]) for m in meta_rows]))
    y = [m[2] for m in meta_rows]
    print(f"완료 칸 {len(y)} (남의 방송 {y.count('rebroadcast')} · 본인 {y.count('own')}) · 시트 못 읽음 {unreadable} · 시트 밖 {missing} · {time.time() - t0:.0f}s")


def data():
    z = np.load(OUT / "emb.npz", allow_pickle=True)   # 이전 산출물의 채널 열이 object 로 저장됐다
    return z["emb"].astype(np.float32), (z["label"].astype(str) == "rebroadcast").astype(int), z["channel"].astype(str)   # 채널 없는 단서는 "None"


def make():
    from sklearn.linear_model import LogisticRegression
    return LogisticRegression(C=1.0, class_weight="balanced", max_iter=5000)


def evaluate(a):
    X, Y, C = data()
    P = np.zeros(len(Y))
    for ch in sorted(set(C)):
        te = C == ch
        if Y[~te].sum() == 0 or (Y[~te] == 0).sum() == 0: continue
        P[te] = make().fit(X[~te], Y[~te]).predict_proba(X[te])[:, 1]
    print(f"칸: 남의 방송 {Y.sum()} · 본인 {len(Y) - Y.sum()} · 채널 {len(set(C))}개(하나씩 빼고 시험)")
    for th in (0.5, 0.7, 0.9):
        tp = int(((P >= th) & (Y == 1)).sum()); fp = int(((P >= th) & (Y == 0)).sum()); fn = int(((P < th) & (Y == 1)).sum())
        print(f"  문턱 {th}: 남의 방송 맞게 찾음 {tp}/{tp + fn} ({tp / max(1, tp + fn):.0%}) · 찾은 것 중 맞음 {tp}/{tp + fp} ({tp / max(1, tp + fp):.0%}) · 본인 화면 오탐 {fp}")
    worst = defaultdict(lambda: [0, 0])
    for p, y, c in zip(P, Y, C):
        if y == 1: worst[c][0] += 1; worst[c][1] += int(p >= 0.7)
    print("  채널별 남의 방송 찾은 비율(문턱 0.7):", ", ".join(f"{c} {h}/{n}" for c, (n, h) in sorted(worst.items(), key=lambda x: -x[1][0])[:12]))


def fit(a):
    X, Y, _ = data()
    m = make().fit(X, Y)
    np.savez(OUT / "model.npz", coef=m.coef_.astype(np.float32), intercept=m.intercept_.astype(np.float32), version="rebroadcast-1")
    print(f"저장 {OUT / 'model.npz'} (칸 {len(Y)}, 남의 방송 {Y.sum()})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["embed", "eval", "fit"]); a = ap.parse_args()
    {"embed": embed, "eval": evaluate, "fit": fit}[a.cmd](a)
