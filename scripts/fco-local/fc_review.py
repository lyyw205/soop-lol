"""FC 결과 화면 라벨 검수 몽타주 — API 경기 종료 직후 구간의 썸네일 칸을 경기 한 줄씩 늘어놓는다.

    $PY scripts/fco-local/fc_review.py --round 1 [--per-vod 4] [--before 9] [--after 36]

입력: out/fco-detector/harvest.json · vods/<vod>.json (harvest.ts)
출력: out/fco-detector/review/r<round>/page-N.jpg + items.json ({"줄:칸": {vod, at}})
한 줄 = 경기 하나(종료 −before ~ +after 초, 3초 칸). 칸 크기 128×72. 검수자는 결과 화면 칸 번호를 적는다.
"""
import argparse, json
from PIL import Image, ImageDraw
from fclib import OUT, cells_of, crop, load_json

ap = argparse.ArgumentParser()
ap.add_argument("--round", type=int, default=1)
ap.add_argument("--per-vod", type=int, default=4)
ap.add_argument("--before", type=int, default=9)
ap.add_argument("--after", type=int, default=36)
ap.add_argument("--rows", type=int, default=5)
ap.add_argument("--cols", type=int, default=8)
a = ap.parse_args()
W, H, LBL = 192, 108, 110
harvest = load_json(OUT / "harvest.json")
rows = []
for h in harvest:
    meta = load_json(OUT / "vods" / f"{h['vod']}.json")
    cells = cells_of(meta)
    ends = h["ends"]
    pick = [ends[round(i * (len(ends) - 1) / max(1, a.per_vod - 1))] for i in range(min(a.per_vod, len(ends)))]
    for e in pick:
        win = [c for c in cells if e["sec"] - a.before <= c[0] <= e["sec"] + a.after]
        if win: rows.append({"vod": h["vod"], "slug": h["slug"], "end": e["sec"], "cells": win})
dst = OUT / "review" / f"r{a.round}"; dst.mkdir(parents=True, exist_ok=True)
items = {}
# 경기 하나 = cols 칸씩 여러 줄(원래 크기 192×108 — 작게 줄이면 결과 화면을 못 가린다)
lines = lambda r: (len(r["cells"]) + a.cols - 1) // a.cols
for pg in range(0, len(rows), a.rows):
    chunk = rows[pg:pg + a.rows]
    hgt = sum(lines(r) for r in chunk) * H
    img = Image.new("RGB", (LBL + a.cols * W, hgt), (20, 20, 20)); d = ImageDraw.Draw(img)
    y = 0
    for ri, r in enumerate(chunk):
        rid = pg + ri + 1
        d.rectangle([0, y, LBL - 4, y + lines(r) * H - 2], outline=(90, 90, 90))
        d.text((4, y + 4), f"#{rid}", fill=(255, 255, 0)); d.text((4, y + 24), r["slug"][:13], fill=(200, 200, 200))
        d.text((4, y + 44), f"end {r['end']}", fill=(150, 150, 150))
        for ci, (at, sheet, c) in enumerate(r["cells"]):
            x0, y0 = LBL + (ci % a.cols) * W, y + (ci // a.cols) * H
            img.paste(Image.fromarray(crop(sheet, c)), (x0, y0))
            d.rectangle([x0, y0, x0 + 26, y0 + 14], fill=(0, 0, 0)); d.text((x0 + 2, y0 + 1), f"{ci + 1}", fill=(255, 80, 80))
            items[f"{rid}:{ci + 1}"] = {"vod": r["vod"], "at": int(at)}
        y += lines(r) * H
    img.save(dst / f"page-{pg // a.rows + 1}.jpg", quality=88)
(dst / "items.json").write_text(json.dumps(items))
print(f"경기 {len(rows)}개 · 페이지 {(len(rows) + a.rows - 1) // a.rows} → {dst}")
