"""늘려 보기 학습 효과 — 스트리머 하나씩 빼고 학습해 뺀 스트리머의 **원본 칸**으로 시험한다(변형은 시험에 안 쓴다).
    $PY scripts/ck-local/detector/compare_aug.py --model siglip"""
import argparse, sys
from collections import defaultdict
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score
sys.path.insert(0, str(Path(__file__).parent)); _a = sys.argv; sys.argv = [_a[0]]
import train as T  # noqa: E402
sys.argv = _a
ap = argparse.ArgumentParser(); ap.add_argument("--model", default="siglip"); ap.add_argument("--C", type=float, default=10); a = ap.parse_args()
metas = T.load_meta(); E = T.load_emb(a.model, metas); L = T.load_labels(E, metas)
z = np.load(T.OUT / "aug" / f"{a.model}.npz")
X0, Y0, C0 = [], [], []
for (v, i), (lab, _) in L.items(): X0.append(E[v][1][i]); Y0.append(lab == "result"); C0.append(metas[v]["channel"])
X0, Y0, C0 = np.array(X0), np.array(Y0), np.array(C0)
XA, YA = z["emb"].astype(np.float32), z["label"] == "result"
CA = np.array([metas[int(v)]["channel"] for v in z["vod"]])
print(f"{'뺀 채널':12} {'':6} {'AP':>6} {'결과창 잡음':>10} {'헛짚음':>7}")
tot = defaultdict(list)
for ch in sorted(set(C0)):
    te = C0 == ch; y = Y0[te]
    if y.sum() < 5 or (~y).sum() < 5: continue
    for name, Xtr, ytr in [("기존", X0[~te], Y0[~te]),
                           ("늘림", np.concatenate([X0[~te], XA[CA != ch]]), np.concatenate([Y0[~te], YA[CA != ch]]))]:
        clf = LogisticRegression(C=a.C, class_weight="balanced", max_iter=4000).fit(Xtr, ytr)
        p = clf.predict_proba(X0[te])[:, 1]
        r = [average_precision_score(y, p), (p[y] >= 0.7).mean(), (p[~y] >= 0.7).mean()]
        tot[name].append(r)
        print(f"{ch:12} {name:6} {r[0]:6.3f} {r[1]:10.0%} {r[2]:7.0%}")
for name, rs in tot.items():
    m = np.mean(rs, axis=0); print(f"{'평균':12} {name:6} {m[0]:6.3f} {m[1]:10.0%} {m[2]:7.0%}")
