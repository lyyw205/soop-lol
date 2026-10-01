"""FC 전용 화면 판별기 — fc_result(결과 화면)·fc_match(경기 중)·fc_menu(메뉴)·other. ck-local 판별기와 별개 파일이다(A안).

    $PY scripts/fco-local/fc_train.py eval   # 채널 하나씩 빼고 시험 — fc_result 재현율·정확도
    $PY scripts/fco-local/fc_train.py fit    # 전부로 학습 → out/fco-detector/model/siglip/fc.npz

라벨: ① ck-local 검수 라벨(out/ck-detector/review-labels.jsonl + 임베딩, **읽기만**) — fc_* 는 그대로, 나머지(롤 화면 등)는 other
      ② FC 수집 라벨(out/fco-detector/labels.jsonl) — fc_review.py 몽타주를 보고 붙인 것. 임베딩은 여기서 뽑아 캐시한다.
판단은 하지 않는다 — 위치 안내다. 결과 화면인지·누가 이겼는지는 원본을 보고 정한다.
"""
import argparse, json, sys
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from fclib import CK, OUT, Embedder, cells_of, crop, load_json

CLASSES = ["fc_result", "fc_match", "fc_menu", "other"]
VERSION = "fc-1"

def ck_data():
    """ck-local 라벨(읽기만). (vod, 칸) 마지막 줄이 이긴다."""
    metas = {}
    for f in (CK / "vods").glob("*.json"):
        m = json.loads(f.read_text())
        if not m.get("missing"): metas[m["vod"]] = m
    lab = {}
    for line in (CK / "review-labels.jsonl").read_text().splitlines():
        if not line.strip(): continue
        r = json.loads(line); v = int(r["vod"])
        if v in metas and r.get("label"): lab[(v, r["at"])] = r["label"]
    X, Y, C = [], [], []
    embs = {}
    for (v, at), l in lab.items():
        if v not in embs:
            p = CK / "emb" / "siglip" / f"{v}.npz"
            if not p.exists(): continue
            z = np.load(p); embs[v] = (z["at"], z["emb"].astype(np.float32))
        if v not in embs: continue
        ats, E = embs[v]
        i = int(np.searchsorted(ats, at, side="right")) - 1
        if i < 0 or at - ats[i] >= 3.5: continue
        X.append(E[i]); Y.append(l if l in CLASSES else "other"); C.append(metas[v]["channel"])
    return X, Y, C

def fc_data(embed=None):
    """FC 수집 라벨 + 임베딩 캐시(out/fco-detector/emb/siglip/labeled.npz)."""
    lp = OUT / "labels.jsonl"
    if not lp.exists(): return [], [], []
    lab = {}
    for line in lp.read_text().splitlines():
        if line.strip():
            r = json.loads(line); lab[(int(r["vod"]), int(r["at"]))] = r["label"]
    cp = OUT / "emb" / "siglip" / "labeled.npz"; cp.parent.mkdir(parents=True, exist_ok=True)
    cache = {}
    if cp.exists():
        z = np.load(cp); cache = {k: e for k, e in zip(z["keys"], z["emb"])}
    need = [k for k in lab if f"{k[0]}:{k[1]}" not in cache]
    if need:
        embed = embed or Embedder()
        crops, keys = [], []
        for v in sorted({k[0] for k in need}):
            cells = {int(at): (sheet, c) for at, sheet, c in cells_of(load_json(OUT / "vods" / f"{v}.json"))}
            for k in [k for k in need if k[0] == v]:
                if k[1] in cells: crops.append(crop(*cells[k[1]])); keys.append(f"{k[0]}:{k[1]}")
        for k, e in zip(keys, embed(crops)): cache[k] = e
        np.savez(cp, keys=np.array(list(cache)), emb=np.array(list(cache.values()), dtype=np.float16))
    chan = {}
    X, Y, C = [], [], []
    for (v, at), l in lab.items():
        e = cache.get(f"{v}:{at}")
        if e is None: continue
        if v not in chan: chan[v] = load_json(OUT / "vods" / f"{v}.json")["channel"]
        X.append(np.asarray(e, np.float32)); Y.append(l if l in CLASSES else "other"); C.append(chan[v])
    return X, Y, C

def data():
    a, b = ck_data(), fc_data()
    X = np.array(a[0] + b[0]); Y = np.array([CLASSES.index(y) for y in a[1] + b[1]]); C = np.array(a[2] + b[2])
    return X, Y, C

def make(C=3):
    return LogisticRegression(C=C, class_weight="balanced", max_iter=5000)

def evaluate(a):
    X, Y, C = data()
    print("종류별 칸:", {CLASSES[k]: n for k, n in sorted(Counter(Y).items())})
    print("fc_result 채널별:", dict(Counter(C[Y == 0])))
    R = CLASSES.index("fc_result")
    tp = fn = fp = 0; per = defaultdict(lambda: [0, 0])
    for ch in sorted(set(C)):
        te = C == ch
        if not (Y[te] == R).any() and te.sum() < 10: continue
        clf = make(a.C).fit(X[~te], Y[~te])
        p = clf.predict_proba(X[te]); cls = clf.classes_          # ★ 열은 clf.classes_ 순서다
        if R not in cls: continue
        pr = p[:, list(cls).index(R)]
        hit = pr >= a.threshold; y = Y[te] == R
        tp += int((hit & y).sum()); fn += int((~hit & y).sum()); fp += int((hit & ~y).sum())
        if y.any(): per[ch][0] += int((hit & y).sum()); per[ch][1] += int(y.sum())
    print(f"(채널 하나씩 빼고 · P(fc_result) ≥ {a.threshold})")
    print(f"fc_result 재현율 {tp}/{tp + fn} = {tp / max(tp + fn, 1):.0%} · 정확도 {tp}/{tp + fp} = {tp / max(tp + fp, 1):.0%}")
    for ch, (h, n) in sorted(per.items(), key=lambda x: -x[1][1]): print(f"  {ch:14} {h}/{n}")

def fit(a):
    X, Y, C = data()
    clf = make(a.C).fit(X, Y)
    dst = OUT / "model" / "siglip"; dst.mkdir(parents=True, exist_ok=True)
    np.savez(dst / "fc.tmp.npz", coef=clf.coef_, intercept=clf.intercept_, classes=np.array([CLASSES[k] for k in clf.classes_]),
             threshold=a.threshold, version=np.array(VERSION))
    (dst / "fc.tmp.npz").replace(dst / "fc.npz")
    print("저장", dst / "fc.npz", {CLASSES[k]: n for k, n in sorted(Counter(Y).items())})

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["eval", "fit"])
    ap.add_argument("--C", type=float, default=3)
    ap.add_argument("--threshold", type=float, default=0.5)
    a = ap.parse_args()
    {"eval": evaluate, "fit": fit}[a.cmd](a)
