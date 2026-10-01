"""검수 결과를 정답 파일에 적는다 — 몽타주 번호:라벨 목록을 items.json 과 맞춰 review-labels.jsonl 에 붙인다.

    $PY scripts/ck-local/detector/label.py --round 1 "0R 1R 2C 3O 4I 5X ..."
라벨: R=result(클라이언트 결과창) · E=end(넥서스 폭발·승리/패배 문구 — 게임 종료 화면) · I=ingame · C=client(로비·챔피언 선택·로딩) · O=other(롤 아님) · X=애매(적지 않는다)
"""
import argparse, json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "out/ck-detector"
NAME = {"R": "result", "E": "end", "I": "ingame", "C": "client", "O": "other"}
ap = argparse.ArgumentParser(); ap.add_argument("--round", type=int, required=True); ap.add_argument("marks"); ap.add_argument("--range", default=None, help="a-b: 이 번호 범위에서 적지 않은 칸은 --default 로"); ap.add_argument("--default", default=None); a = ap.parse_args()
items = json.loads((OUT / "review" / f"r{a.round}" / "items.json").read_text())
n = skip = 0
toks = a.marks.split()
if a.range and a.default:
    lo, hi = map(int, a.range.split("-")); given = {int(t[:-1]) for t in toks}
    toks += [f"{i}{a.default}" for i in range(lo, hi + 1) if i not in given]
with open(OUT / "review-labels.jsonl", "a") as f:
    for tok in toks:
        i, lab = int(tok[:-1]), tok[-1].upper()
        if lab == "X": skip += 1; continue
        it = items[i]
        f.write(json.dumps({"vod": it["vod"], "at": it["at"], "label": NAME[lab], "source": f"review:r{a.round}"}) + "\n"); n += 1
print(f"적음 {n} · 애매 {skip}")
