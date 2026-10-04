"""화면 종류 라벨 판별기(여러 종류) — Claude 에게 넘길 "구간 지도"용. 결과창 후보는 기존 판별기(train.py)가 그대로 낸다.

    $PY scripts/ck-local/detector/multi.py eval   # 스트리머 하나씩 빼고 종류별 정확도
    $PY scripts/ck-local/detector/multi.py fit    # 전부로 학습 → out/ck-detector/model/siglip/multi.npz

라벨(검수만 쓴다 — DB 초벌 notresult 는 종류를 모른다):
  result(점수판) · graph(결과창 다른 탭) · banpick · lobby(사용자 설정 게임 방) · client(그 밖 클라이언트) · ingame · end · other
  fc_match(FC 경기 중) · fc_result(FC 결과 화면) · fc_menu(FC 메뉴) — 롤·FC 공유 준비(docs/CK-LOCAL-FC-PLAN.md)
  loading 은 예시가 2칸뿐이라 뺐다 — 썸네일에서 로딩 화면이 드물다(2026-10-01).
판단은 하지 않는다. 확률이 낮은 칸은 "모름"으로 둔다. docs/CK-LOCAL-DETECTOR.md §12
"""
import argparse, sys
from collections import Counter, defaultdict
from pathlib import Path
import numpy as np
from sklearn.linear_model import LogisticRegression
sys.path.insert(0, str(Path(__file__).parent)); _a = sys.argv; sys.argv = [_a[0]]
import train as T  # noqa: E402
sys.argv = _a

CLASSES = ["result", "graph", "banpick", "lobby", "client", "ingame", "end", "other", "fc_match", "fc_result", "fc_menu"]

# 지도 산출물을 소비하는 쪽(locate 등)이 "이 지도가 FC 라벨을 아는 모델로 만들어졌나"를 가린다. 라벨 목록이 바뀌면 올린다.
VERSION = "multi-2-fc"

def stale_aug_check(model):
    """늘려 보기 파일이 정답 파일보다 오래됐으면 멈춘다 — 옛 라벨의 변형이 새 정답과 다른 답으로 학습된다(Codex 검토)."""
    aug = T.OUT / "aug" / f"{model}.npz"; lab = T.OUT / "review-labels.jsonl"
    if aug.exists() and lab.exists() and aug.stat().st_mtime < lab.stat().st_mtime:
        sys.exit(f"늘려 보기({aug.name})가 정답 파일보다 오래됐다 — 먼저 augment.py 를 다시 돌린다")

def data(model):
    stale_aug_check(model)
    metas = T.load_meta(); E = T.load_emb(model, metas); L = T.load_labels(E, metas)
    X, Y, C = [], [], []
    for (v, i), (lab, src) in L.items():
        if lab not in CLASSES: continue
        if lab == "result" and not (src.startswith("review") or src.startswith("ck-local") or src == "db:result"): continue
        X.append(E[v][1][i]); Y.append(CLASSES.index(lab)); C.append(metas[v]["channel"])
    z = np.load(T.OUT / "aug" / f"{model}.npz")
    keep = np.array([str(l) in CLASSES for l in z["label"]])
    XA = z["emb"][keep].astype(np.float32); YA = np.array([CLASSES.index(str(l)) for l in z["label"][keep]])
    CA = np.array([metas[int(v)]["channel"] for v in z["vod"][keep]])
    return np.array(X), np.array(Y), np.array(C), XA, YA, CA

def make(C=3):
    return LogisticRegression(C=C, class_weight="balanced", max_iter=5000)

def evaluate(a):
    X, Y, C, XA, YA, CA = data(a.model)
    print("종류별 칸:", {CLASSES[k]: n for k, n in sorted(Counter(Y).items())})
    # 세 숫자를 함께 낸다(Codex 검토, 2026-10-01 — 예전엔 "모름"을 분모에서 빼 재현율이 부풀었다):
    #   전체 재현율 = 그 종류 칸 중 맞는 라벨을 받은 비율("모름"도 놓친 것으로 센다)
    #   부여율     = 그 종류 칸 중 라벨이 붙은(모름이 아닌) 비율
    #   정확도     = 그 라벨이 붙은 칸 중 실제로 그 종류인 비율
    n = defaultdict(int); labeled = defaultdict(int); hit = defaultdict(int); pred_n = defaultdict(int); pred_ok = defaultdict(int)
    for ch in sorted(set(C)):
        te = C == ch
        if te.sum() < 10: continue
        clf = make(a.C).fit(np.concatenate([X[~te], XA[CA != ch]]), np.concatenate([Y[~te], YA[CA != ch]]))
        # ★ predict_proba 의 열은 clf.classes_ 순서다 — 이 학습 묶음에 없는 종류(한 채널에만 있는 FC 결과 등)가 빠지면
        #   열 번호와 CLASSES 번호가 어긋난다. 열을 실제 라벨 번호로 바꾼다(Codex 검토, 2026-10-01).
        p = clf.predict_proba(X[te]); pr = clf.classes_[p.argmax(1)]; conf = p.max(1)
        for y, q, c in zip(Y[te], pr, conf):
            n[y] += 1
            if c < a.min_conf: continue   # 확신 낮으면 "모름" — 라벨을 안 붙인다
            labeled[y] += 1; pred_n[q] += 1
            if y == q: hit[y] += 1; pred_ok[q] += 1
    print(f"(스트리머 하나씩 빼고 시험 · 확신 {a.min_conf} 미만은 모름)")
    print(f"{'종류':8} {'전체 재현율':>14} {'부여율':>8} {'정확도':>14}")
    for k, name in enumerate(CLASSES):
        if not n[k] and not pred_n[k]: continue
        print(f"{name:8} {hit[k]:4}/{n[k]:<4} {hit[k] / max(n[k], 1):5.0%}  {labeled[k] / max(n[k], 1):6.0%}  {pred_ok[k]:4}/{pred_n[k]:<4} {pred_ok[k] / max(pred_n[k], 1):5.0%}")

def fit(a):
    X, Y, C, XA, YA, CA = data(a.model)
    clf = make(a.C).fit(np.concatenate([X, XA]), np.concatenate([Y, YA]))
    root = Path(a.output_dir) if a.output_dir else T.OUT / "candidates" / "latest"
    if root.resolve() == T.OUT.resolve(): raise ValueError("fit은 운영 OUT을 덮지 않는다. 후보 디렉터리를 지정할 것")
    dst = root / "model" / a.model; dst.mkdir(parents=True, exist_ok=True)
    # 저장하는 라벨 목록은 실제로 학습된 순서(clf.classes_)여야 detect.py 의 argmax 가 맞는 이름을 가리킨다
    np.savez(dst / "multi.tmp.npz", coef=clf.coef_, intercept=clf.intercept_, classes=np.array([CLASSES[k] for k in clf.classes_]),
             min_conf=a.min_conf, version=np.array(VERSION))
    (dst / "multi.tmp.npz").replace(dst / "multi.npz")
    print("저장", dst / "multi.npz", {CLASSES[k]: n for k, n in sorted(Counter(Y).items())})

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["eval", "fit"])
    ap.add_argument("--model", default="siglip")
    ap.add_argument("--output-dir", help="후보 모델 디렉터리; 운영 모델은 자동 교체하지 않음")
    ap.add_argument("--C", type=float, default=3)
    ap.add_argument("--min-conf", type=float, default=0.6)
    a = ap.parse_args()
    {"eval": evaluate, "fit": fit}[a.cmd](a)
