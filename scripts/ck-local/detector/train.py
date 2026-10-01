"""결과창 판별기 — 학습·채점·검수 뽑기·판 단위 평가를 한 파일에서.

    PY=out/ck-detector/venv/bin/python
    $PY scripts/ck-local/detector/train.py fit      --model siglip           # 학습 + 칸 단위 점수 + 모든 칸 점수 저장
    $PY scripts/ck-local/detector/train.py review   --model siglip --round 1 # 검수할 칸 몽타주 만들기
    $PY scripts/ck-local/detector/train.py games    --model siglip           # 판 단위 평가(시험 채널)

설계: docs/CK-LOCAL-DETECTOR.md
정답:
  out/ck-detector/seed-labels.jsonl    DB 초벌 — result(Claude 가 결과 근거로 쓴 화면) · notresult(읽고 안 쓴 화면)
  out/ck-detector/review-labels.jsonl  Claude 검수 — result · ingame · client · other (seed 보다 우선)
  라벨은 VOD 전역 초 → 칸(3초)으로 옮긴다. 같은 칸에 검수가 있으면 검수가 이긴다.
나눔(스트리머 단위 — 같은 스트리머는 화면 배치가 비슷해 VOD 로 나누면 점수가 부푼다):
  test = xoals137(클리드1) · dev = lshooooo(이상호) · train = 나머지
"""
import argparse, json, sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "out/ck-detector"
TEST, DEV = {"xoals137"}, {"lshooooo"}
FW, FH = 192, 108

# 시험 채널(클리드1)의 VOD 중 DB 기록이 없는 둘은 학습으로 옮겼다(2026-10-01). 클리드1이 자주 띄우는
# 전적 사이트 경기 상세 페이지(파랑/빨강 팀 표)가 학습 채널에는 약 20장뿐이라 판별기가 못 배웠다.
# ⚠ 같은 스트리머라 남은 시험(DB 2 VOD)은 그만큼 쉬워졌다 — 결과를 볼 때 감안한다.
TRAIN_VODS = {206702623, 207843813}
def split_of(ch, vod=None):
    if vod in TRAIN_VODS: return "train"
    return "test" if ch in TEST else "dev" if ch in DEV else "train"

def load_meta():
    metas = {}
    for f in (OUT / "vods").glob("*.json"):
        m = json.loads(f.read_text())
        if not m.get("missing"): metas[m["vod"]] = m
    return metas

def load_emb(model, metas):
    E = {}
    for vod in metas:
        p = OUT / "emb" / model / f"{vod}.npz"
        if p.exists():
            z = np.load(p); E[vod] = (z["at"], z["emb"].astype(np.float32))
    return E

def cell_index(at_arr, t):
    """전역 초 t 를 담은 칸 번호(없으면 None). 칸 시각은 칸 시작이다."""
    i = int(np.searchsorted(at_arr, t, side="right")) - 1
    if i < 0 or t - at_arr[i] >= 3.5: return None
    return i

SEED_FAR = 300   # 초벌 "결과창 아님"은 결과창 표시에서 이만큼(초) 떨어진 것만 믿는다
def load_labels(E, metas):
    """(vod, 칸) → (라벨, 출처). 검수가 seed 를 이긴다.
    ★ 초벌 notresult(db:other)는 결과창 표시에서 5분 안이면 버린다. 예전 조사는 결과창 원본을 여러 장 열고
      대표 한두 장만 result 로 표시해서, 나머지 결과창이 other 로 남았다(1차 검수: 점수 높은 notresult 대부분이 실제 결과창).
      결과창이 몇 분씩 떠 있으니 그 근처 other 는 결과창일 수 있다."""
    L = {}
    seed_result = defaultdict(list)
    sp = OUT / "seed-labels.jsonl"
    for line in (sp.read_text().splitlines() if sp.exists() else []):
        if line.strip():
            r = json.loads(line)
            if r["label"] == "result": seed_result[int(r["vod"])].append(r["at"])
    for name in ["seed-labels.jsonl", "review-labels.jsonl"]:
        p = OUT / name
        if not p.exists(): continue
        for line in p.read_text().splitlines():
            if not line.strip(): continue
            r = json.loads(line); vod = int(r["vod"])
            if vod not in E: continue
            if r.get("source") == "db:other" and any(abs(r["at"] - t) < SEED_FAR for t in seed_result[vod]): continue
            i = cell_index(E[vod][0], r["at"])
            if i is None: continue
            L[(vod, i)] = (r["label"], r.get("source", name))
    return L

TARGET = "result"   # fit --target end 로 종료 화면(넥서스 폭발·승리/패배 문구) 판별기를 따로 학습한다
def binary(label):
    return 1 if label == TARGET else 0

def fit(a):
    metas = load_meta(); E = load_emb(a.model, metas); L = load_labels(E, metas)
    X = {"train": [], "dev": [], "test": []}; Y = {k: [] for k in X}
    for (vod, i), (lab, _) in L.items():
        s = split_of(metas[vod]["channel"], vod)
        X[s].append(E[vod][1][i]); Y[s].append(binary(lab))
    # 늘려 보기 학습 재료(augment.py) — 학습 칸의 변형만 학습에 더한다. dev·시험은 원본 칸으로만 잰다.
    aug = OUT / "aug" / f"{a.model}.npz"
    XA_dev, YA_dev = [], []   # dev 채널 변형 — 선택(dev 채점)엔 안 쓰고 최종 판별기에만 더한다
    if aug.exists() and not a.no_aug:
        z = np.load(aug); n = 0
        for e, v, lab in zip(z["emb"], z["vod"], z["label"]):
            v = int(v)
            if v not in metas: continue
            sp = split_of(metas[v]["channel"], v)
            if sp == "train": X["train"].append(e.astype(np.float32)); Y["train"].append(binary(str(lab))); n += 1
            elif sp == "dev": XA_dev.append(e.astype(np.float32)); YA_dev.append(binary(str(lab)))
        print(f"  늘려 보기 변형 {n}칸 추가")
    for k in X:
        X[k] = np.array(X[k]); Y[k] = np.array(Y[k])
        print(f"  {k}: 칸 {len(Y[k])} · 결과창 {int(Y[k].sum()) if len(Y[k]) else 0}")
    best = None
    for C in [0.1, 0.3, 1, 3, 10]:
        clf = LogisticRegression(C=C, class_weight="balanced", max_iter=3000).fit(X["train"], Y["train"])
        ap = average_precision_score(Y["dev"], clf.predict_proba(X["dev"])[:, 1]) if len(Y["dev"]) and Y["dev"].sum() else float("nan")
        print(f"  C={C}: dev AP {ap:.3f}")
        if best is None or ap > best[0]: best = (ap, C, clf)
    ap, C, clf = best
    # 학습에 dev 까지 넣은 최종 판별기(시험 채널은 끝까지 안 본다)
    Xa = np.concatenate([X["train"], X["dev"]] + ([np.array(XA_dev)] if XA_dev else [])); Ya = np.concatenate([Y["train"], Y["dev"]] + ([np.array(YA_dev)] if YA_dev else []))
    final = LogisticRegression(C=C, class_weight="balanced", max_iter=3000).fit(Xa, Ya)
    dst = OUT / "model" / (a.model if TARGET == "result" else f"{a.model}-{TARGET}"); dst.mkdir(parents=True, exist_ok=True)
    # ★ 백필이 도는 중에 읽을 수 있다 — 임시 파일에 쓰고 이름을 바꾼다(반쯤 쓴 파일을 읽지 않게)
    np.savez(dst / "clf.tmp.npz", coef=final.coef_[0], intercept=final.intercept_, C=C); (dst / "clf.tmp.npz").replace(dst / "clf.npz")
    np.savez(dst / "clf-train-only.npz", coef=clf.coef_[0], intercept=clf.intercept_, C=C)
    # 모든 칸 점수 — 검수 뽑기(학습에만 쓴 판별기)와 판 단위 평가에 쓴다
    sd = OUT / "scores" / (a.model if TARGET == "result" else f"{a.model}-{TARGET}"); sd.mkdir(parents=True, exist_ok=True)
    for vod, (at, emb) in E.items():
        which = clf if split_of(metas[vod]["channel"], vod) in ("dev", "test") else final
        np.save(sd / f"{vod}.npy", which.predict_proba(emb)[:, 1].astype(np.float32))
    print(f"선택 C={C} · dev AP {ap:.3f} · 점수 저장 {len(E)}개 VOD")
    # 칸 단위: dev 에서 결과창 칸을 다 잡는 문턱마다 결과창 아닌 칸이 몇이나 넘나
    if len(Y["dev"]) and Y["dev"].sum():
        p = clf.predict_proba(X["dev"])[:, 1]
        for q in [1.0, 0.98, 0.95, 0.9]:
            thr = np.quantile(p[Y["dev"] == 1], 1 - q) if q < 1 else p[Y["dev"] == 1].min()
            fp = int(((p >= thr) & (Y["dev"] == 0)).sum())
            print(f"  dev 결과창 칸 {q:.0%} 잡는 문턱 {thr:.3f} → 결과창 아닌 칸 {fp}/{int((Y['dev'] == 0).sum())} 넘음")

def tile_label(img, text):
    d = ImageDraw.Draw(img); d.rectangle([0, 0, 8 * len(text) + 6, 14], fill=(0, 0, 0)); d.text((3, 1), text, fill=(255, 255, 0))

def cell_image(meta, at):
    for p in meta["parts"]:
        if not p.get("reliable") or not (p["offset"] <= at < p["offset"] + p["length"]): continue
        i = int((at - p["offset"]) // 3)
        if i >= p["cells"]: return None
        sheet = Image.open(ROOT / p["sheets"][i // 100]).convert("RGB")
        c = i % 100
        return sheet.crop(((c % 10) * FW, (c // 10) * FH, (c % 10 + 1) * FW, (c // 10 + 1) * FH))
    return None

def review(a):
    """검수할 칸 고르기 — 판별기가 자신 없는 칸, 초벌과 어긋나는 칸, 결과창 앞뒤 칸.
    출력: out/ck-detector/review/r<round>/page-N.jpg + items.json (번호 → vod·시각)."""
    metas = load_meta(); E = load_emb(a.model, metas); L = load_labels(E, metas)
    picks = []
    for vod, (at, emb) in E.items():
        if split_of(metas[vod]["channel"], vod) == "test": continue   # 시험 채널은 검수에도 안 쓴다(답을 보면 시험이 아니다)
        s = np.load(OUT / "scores" / a.model / f"{vod}.npy")
        labeled = {i for (v, i) in L if v == vod}
        # (1) 초벌과 어긋남: 결과창 표시인데 점수 낮음 · 아닌데 점수 높음
        for (v, i), (lab, src) in L.items():
            if v != vod or src.startswith("review"): continue
            if lab == "result" and s[i] < 0.5: picks.append((0.5 - s[i] + 1, vod, i, "어긋남:결과창인데낮음"))
            if lab != "result" and s[i] > 0.5: picks.append((s[i] + 1, vod, i, "어긋남:아닌데높음"))
        # (2) 라벨 없는 칸 중 점수 높은 곳(모르는 결과창 또는 헷갈리는 화면) — 이어진 덩어리마다 가운데 하나
        hi = np.where(s > 0.3)[0]
        runs = np.split(hi, np.where(np.diff(hi) > 2)[0] + 1) if len(hi) else []
        for r in runs:
            m = int(r[len(r) // 2])
            if m not in labeled: picks.append((float(s[m]), vod, m, "높음"))
        # (3) 결과창 표시 앞뒤 ±45초(15칸) — 결과창이 몇 칸 이어지는지·전환 화면 라벨
        for (v, i), (lab, src) in L.items():
            if v != vod or lab != "result" or not src.startswith("db"): continue
            for d in range(-15, 16, 3):
                j = i + d
                if 0 <= j < len(at) and j not in labeled: picks.append((0.4, vod, j, "앞뒤"))
    # 중복 제거 후 우선순위 순
    seen, items = set(), []
    for pr, vod, i, why in sorted(picks, key=lambda x: -x[0]):
        if (vod, i) in seen: continue
        seen.add((vod, i)); items.append({"vod": vod, "at": float(E[vod][0][i]), "why": why, "score": round(float(np.load(OUT / "scores" / a.model / f"{vod}.npy")[i]), 3)})
        if len(items) >= a.limit: break
    dst = OUT / "review" / f"r{a.round}"; dst.mkdir(parents=True, exist_ok=True)
    PAGE, COLS = 40, 8
    for pg in range(0, len(items), PAGE):
        chunk = items[pg:pg + PAGE]
        canvas = Image.new("RGB", (COLS * (FW + 4), ((len(chunk) + COLS - 1) // COLS) * (FH + 4)), (30, 30, 30))
        for k, it in enumerate(chunk):
            im = cell_image(metas[it["vod"]], it["at"]) or Image.new("RGB", (FW, FH))
            tile_label(im, str(pg + k))
            canvas.paste(im, ((k % COLS) * (FW + 4), (k // COLS) * (FH + 4)))
        canvas.save(dst / f"page-{pg // PAGE + 1}.jpg", quality=90)
    (dst / "items.json").write_text(json.dumps(items, ensure_ascii=False, indent=0))
    print(f"검수 {len(items)}칸 · {dst} · 페이지 {(len(items) + PAGE - 1) // PAGE}")

def runs_of(s, thr, min_len):
    hi = np.where(s >= thr)[0]
    if not len(hi): return []
    groups = np.split(hi, np.where(np.diff(hi) > 2)[0] + 1)   # 2칸(6초) 이하 끊김은 잇는다
    return [(int(g[0]), int(g[-1])) for g in groups if g[-1] - g[0] + 1 >= min_len]

def games(a):
    """판 단위 평가 — 시험·dev 채널 VOD 의 알려진 판(DB 결과창 시각)마다 후보 덩어리가 걸렸나, 남는 덩어리는 몇 개인가."""
    metas = load_meta(); E = load_emb(a.model, metas)
    seed = [json.loads(l) for l in (OUT / "seed-labels.jsonl").read_text().splitlines() if l.strip()]
    truth = defaultdict(list)
    for r in seed:
        if r["label"] == "result": truth[int(r["vod"])].append(r["at"])
    rows = []
    for split in ("dev", "test"):
        vods = [v for v in E if split_of(metas[v]["channel"], v) == split]
        for thr in [0.3, 0.5, 0.7, 0.9]:
            for min_len in [1, 2, 3]:
                hit = tot = extra = 0; hours = 0.0
                for vod in vods:
                    at = E[vod][0]; s = np.load(OUT / "scores" / a.model / f"{vod}.npy")
                    rs = runs_of(s, thr, min_len)
                    hours += (at[-1] - at[0]) / 3600
                    # 같은 판의 결과창 사진 여러 장은 90초 안에 모인다 — 그걸 한 판으로 센다
                    ts = sorted(truth[vod]); gs = []
                    for t in ts:
                        if gs and t - gs[-1][-1] <= 90: gs[-1].append(t)
                        else: gs.append([t])
                    for g in gs:
                        tot += 1
                        if any(at[r0] - 60 <= t <= at[r1] + 60 for t in g for r0, r1 in rs): hit += 1
                    extra += sum(1 for r0, r1 in rs if not any(at[r0] - 60 <= t <= at[r1] + 60 for t in ts))
                rows.append((split, thr, min_len, hit, tot, extra, hours))
    for split, thr, ml, hit, tot, extra, h in rows:
        print(f"  {split:4} 문턱 {thr} 최소 {ml}칸 · 판 {hit}/{tot} 잡음 · 기록에 없는 덩어리 {extra} ({extra / max(h, 1e-9):.1f}/시간, {h:.1f}시간)")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["fit", "review", "games"])
    ap.add_argument("--model", default="siglip")
    ap.add_argument("--round", type=int, default=1)
    ap.add_argument("--limit", type=int, default=400)
    ap.add_argument("--target", default="result", choices=["result", "end"])
    ap.add_argument("--no-aug", action="store_true")
    a = ap.parse_args()
    TARGET = a.target
    {"fit": fit, "review": review, "games": games}[a.cmd](a)
