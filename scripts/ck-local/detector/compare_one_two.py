"""판별기 하나(종류 판별기)로 결과창 후보까지 낼 수 있나 — 결과창 판별기와 판 단위 비교. 재학습 뒤 다시 돌린다.
    $PY scripts/ck-local/detector/compare_one_two.py   (저장소 루트에서)"""
# 스트리머 하나씩 빼고 학습 → 뺀 스트리머 VOD 전체를 실제처럼 돌려 판 단위로 비교
#  A: 결과창 판별기(이진, DB '아님' 포함)   B: 화면 종류 판별기의 결과창+그래프 확률
import sys, json, numpy as np
from collections import defaultdict
sys.path.insert(0, "scripts/ck-local/detector"); sys.argv = ["x"]
import train as T, multi as M
from sklearn.linear_model import LogisticRegression
metas = T.load_meta(); E = T.load_emb("siglip", metas); L = T.load_labels(E, metas)
z = np.load(T.OUT / "aug" / "siglip.npz"); ZC = np.array([metas[int(v)]["channel"] for v in z["vod"]]); ZL = np.array([str(l) for l in z["label"]])
seed = [json.loads(l) for l in (T.OUT / "seed-labels.jsonl").read_text().splitlines() if l.strip()]
truth = defaultdict(list)
for r in seed:
    if r["label"] == "result": truth[int(r["vod"])].append(r["at"])
rows = []
for (v, i), (lab, src) in L.items(): rows.append((metas[v]["channel"], E[v][1][i], lab, src))
chans = sorted({metas[v]["channel"] for v in E})
res = defaultdict(lambda: [0, 0, 0, 0.0])
for ch in chans:
    vods = [v for v in E if metas[v]["channel"] == ch and truth[v]]
    if not vods: continue
    tr = [r for r in rows if r[0] != ch]; za = ZC != ch
    # A
    XA = np.array([r[1] for r in tr] + list(z["emb"][za].astype(np.float32))); YA = np.array([r[2] == "result" for r in tr] + list(ZL[za] == "result"))
    a = LogisticRegression(C=10, class_weight="balanced", max_iter=4000).fit(XA, YA)
    # B
    keep = [r for r in tr if r[2] in M.CLASSES and not (r[2] == "result" and not (r[3].startswith("review") or r[3].startswith("ck-local") or r[3] == "db:result"))]
    zk = za & np.isin(ZL, M.CLASSES)
    XB = np.array([r[1] for r in keep] + list(z["emb"][zk].astype(np.float32))); YB = np.array([M.CLASSES.index(r[2]) for r in keep] + [M.CLASSES.index(l) for l in ZL[zk]])
    b = LogisticRegression(C=3, class_weight="balanced", max_iter=5000).fit(XB, YB)
    for name, f in [("A 결과창 판별기", lambda e: a.predict_proba(e)[:, 1]), ("B 종류 판별기", lambda e: b.predict_proba(e)[:, [M.CLASSES.index("result"), M.CLASSES.index("graph")]].sum(1))]:
        for v in vods:
            at, emb = E[v]; s = f(emb); rs = T.runs_of(s, 0.7, 2, at)
            ts = sorted(truth[v]); gs = []
            for t in ts:
                if gs and t - gs[-1][-1] <= 90: gs[-1].append(t)
                else: gs.append([t])
            r = res[(name, ch)]
            r[0] += sum(any(at[r0] - 60 <= t <= at[r1] + 60 for t in g for r0, r1 in rs) for g in gs); r[1] += len(gs)
            r[2] += sum(1 for r0, r1 in rs if not any(at[r0] - 60 <= t <= at[r1] + 60 for t in ts)); r[3] += (at[-1] - at[0]) / 3600
tot = defaultdict(lambda: [0, 0, 0, 0.0])
for (name, ch), r in sorted(res.items(), key=lambda x: (x[0][1], x[0][0])):
    print(f"{ch:12} {name:14} 판 {r[0]:3}/{r[1]:<3} 기록 밖 후보 {r[2] / max(r[3], 1e-9):4.1f}/시간")
    for k in range(4): tot[name][k] += r[k]
for name, r in tot.items(): print(f"{'합계':12} {name:14} 판 {r[0]:3}/{r[1]:<3} 기록 밖 후보 {r[2] / r[3]:4.1f}/시간 ({r[3]:.0f}시간)")
