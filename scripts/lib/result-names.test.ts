import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import sharp from "sharp";

import { findNameColumn, namesPathOf, writeNameCrop } from "./result-names.mjs";

type RGB = [number, number, number];
/** 결과창을 흉내 낸다 — 어두운 바탕에 줄마다 왼쪽 세로 띠(아군 위 5줄, 상대 아래 5줄). */
function board({ w = 800, h = 600, x = 100, top = 100, rowH = 40, team1 = [21, 159, 159] as RGB, team2 = [166, 15, 48] as RGB, gold = true, withTeam1 = true } = {}) {
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) px.set([8, 19, 21], i * 3);
  const strip = (y0: number, color: RGB) => {
    for (let y = y0; y < y0 + rowH - 5; y++) for (let dx = 0; dx < 4; dx++) px.set(color, ((y * w) + x + dx) * 3);
  };
  for (let k = 0; k < 5; k++) if (withTeam1) strip(top + k * rowH, gold && k === 0 ? [219, 193, 96] : team1);
  const top2 = top + 6 * rowH; // 팀 사이 머리글 한 줄
  for (let k = 0; k < 5; k++) strip(top2 + k * rowH, team2);
  return { px, w, h };
}

test("세로 띠 두 묶음에서 줄 높이를 얻고 이름 칸을 그 비율로 자른다", () => {
  const { px, w, h } = board();
  const got = findNameColumn(px, w, h);
  assert.ok("box" in got && got.box, JSON.stringify(got));
  assert.equal(got.level, "strict");
  assert.equal(got.rowH, 38.8); // (마지막 띠 끝 − 첫 띠 시작) ÷ 5 — 줄 사이 틈을 포함한 근사
  // 이름 칸은 띠에서 3.2H~6.8H 오른쪽, 위아래로 두 팀을 다 덮는다.
  assert.ok(got.box.left > got.strip + 3 * got.rowH && got.box.left + got.box.width < got.strip + 7 * got.rowH);
  assert.ok(got.box.top <= 100 && got.box.top + got.box.height >= 100 + 6 * 40 + 4 * 40 + 35);
});

test("창이 커져도 같은 비율로 따라간다(고정 좌표가 아니다)", () => {
  const small = findNameColumn(...Object.values(board({ x: 100, rowH: 40 })) as [Buffer, number, number]);
  const big = findNameColumn(...Object.values(board({ w: 1200, h: 900, x: 300, top: 120, rowH: 60 })) as [Buffer, number, number]);
  assert.ok("box" in small && "box" in big);
  const rel = (g: typeof small) => "box" in g && g.box ? (g.box.left - g.strip) / g.rowH : NaN;
  assert.ok(Math.abs(rel(small) - rel(big)) < 0.1, `${rel(small)} vs ${rel(big)}`);
});

test("흐린 띠(창 비활성·압축)는 느슨한 기준으로 잡는다", () => {
  const { px, w, h } = board({ team1: [40, 100, 100], team2: [114, 68, 78], gold: false });
  const got = findNameColumn(px, w, h);
  assert.ok("box" in got && got.box);
  assert.equal(got.level, "loose");
});

test("띠가 없거나 한 팀만 있으면 자르지 않는다 — 엉뚱한 곳을 확대하지 않는다", () => {
  const blank = Buffer.alloc(800 * 600 * 3, 20);
  assert.deepEqual(findNameColumn(blank, 800, 600), { why: "상대팀 띠 없음" });
  const { px, w, h } = board({ withTeam1: false });
  assert.deepEqual(findNameColumn(px, w, h), { why: "아군 띠 없음" });
});

test("확대본은 names/ 폴더에 2배로 저장되고, 다시 부르면 만든 것을 쓴다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "result-names-"));
  try {
    const { px, w, h } = board();
    const frame = join(dir, "g0012156.jpg");
    await sharp(px, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toFile(frame);
    const first = await writeNameCrop(frame);
    assert.ok("path" in first && first.path === namesPathOf(frame) && !first.cached);
    assert.ok(existsSync(join(dir, "names", "g0012156.jpg")));
    const meta = await sharp(first.path).metadata();
    const found = findNameColumn(...Object.values(board()) as [Buffer, number, number]);
    assert.ok("box" in found && found.box);
    assert.equal(meta.width, found.box.width * 2);
    const again = await writeNameCrop(frame);
    assert.ok("path" in again && again.cached);
    // 결과창이 아니면 파일을 만들지 않는다.
    const plain = join(dir, "g0000001.jpg");
    await sharp(Buffer.alloc(800 * 600 * 3, 20), { raw: { width: 800, height: 600, channels: 3 } }).jpeg().toFile(plain);
    assert.ok("why" in (await writeNameCrop(plain)));
    assert.ok(!existsSync(namesPathOf(plain)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
