"""검수 결과를 정답 파일에 적는다 — 몽타주 번호:라벨 목록을 items.json 과 맞춰 review-labels.jsonl 에 붙인다.

    $PY scripts/ck-local/detector/label.py --round 1 "0R 1R 2C 3O 4I 5X ..."
라벨: R=result(클라이언트 결과창·점수판) · G=graph(결과창의 그래프·다른 탭) · B=banpick(챔피언 선택) · D=loading(로딩) · L=lobby · F=fc_match(FC 경기 중) · S=fc_result(FC 결과 화면) · M=fc_menu(FC 메뉴·스쿼드·상점)(사용자 설정 게임 방) · E=end(넥서스 폭발·승리/패배 문구 — 게임 종료 화면) · I=ingame · C=client(로비·챔피언 선택·로딩) · O=other(롤 아님) · X=애매(적지 않는다)
"""
import argparse, json
from pathlib import Path
ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "out/ck-detector"
NAME = {"R": "result", "E": "end", "B": "banpick", "D": "loading", "L": "lobby", "G": "graph", "F": "fc_match", "S": "fc_result", "M": "fc_menu", "I": "ingame", "C": "client", "O": "other"}
ap = argparse.ArgumentParser(); ap.add_argument("--round", type=int, required=True); ap.add_argument("marks"); ap.add_argument("--range", default=None, help="a-b: 이 번호 범위에서 적지 않은 칸은 --default 로"); ap.add_argument("--default", default=None); a = ap.parse_args()
items = json.loads((OUT / "review" / f"r{a.round}" / "items.json").read_text())
n = skip = 0
if a.range or a.default:
    ap.error("일괄 기본 라벨은 지원하지 않는다. 직접 확인한 번호:라벨만 명시할 것")
rows = []
seen = set()
for tok in a.marks.split():
    try:
        i, lab = int(tok[:-1]), tok[-1].upper()
        if i < 0 or i >= len(items) or i in seen: raise ValueError("번호 범위/중복")
        seen.add(i)
        if lab == "X": skip += 1; continue
        it = items[i]
        rows.append({"vod": it["vod"], "at": it["at"], "label": NAME[lab], "source": f"review:r{a.round}"})
    except (ValueError, KeyError, IndexError):
        ap.error(f"잘못된 판정 {tok}; 아무 라벨도 저장하지 않았다")
if rows:
    with open(OUT / "review-labels.jsonl", "a") as f:
        f.write("\n".join(json.dumps(row) for row in rows) + "\n")
print(f"적음 {len(rows)} · 애매 {skip}")
