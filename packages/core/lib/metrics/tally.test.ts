import { test } from "node:test";
import assert from "node:assert/strict";

import { FORMATS, FORMATS_BY_GAME, allowedFormat, formatLabel, formatChipLabel } from "./format.ts";
import { mirror, pairSetOutcome, seriesOutcome, tally, total, type Outcome } from "./tally.ts";

test("시리즈 결과 — 미상이 전부 반대로 가도 뒤집히지 않을 때만 확정", () => {
  assert.equal(seriesOutcome(["win", "win", "loss"]), "win");            // CK 2:1
  assert.equal(seriesOutcome(["loss"]), "loss");                          // 진 판 하나만 뛴 사람
  assert.equal(seriesOutcome(["win", "unknown", "unknown"]), "unknown");  // 1승 0패 2미상은 아직 승이 아니다
  assert.equal(seriesOutcome(["win", "win", "win", "unknown"]), "win");   // 3 > 0 + 1
  assert.equal(seriesOutcome(["win", "loss"]), "draw");                   // 옛 2세트제
  assert.equal(seriesOutcome(["win", "loss", "unknown"]), "unknown");
  assert.equal(seriesOutcome(["draw", "draw"]), "draw");                  // FC 무 세트는 어느 쪽에도 안 센다
  assert.equal(seriesOutcome(["win", "draw"]), "win");
  assert.equal(seriesOutcome(["unknown"]), "unknown");
});

test("랜드도 같은 규칙 — 매 판이 세트, 그날 전체가 시리즈(사용자 결정 10)", () => {
  const land = (["win", "win", "loss", "win", "loss", "win", "loss"] as Outcome[]).map((outcome) => ({ series_id: "land:1", outcome }));
  const t = tally(land);
  assert.deepEqual(t.sets, { win: 4, draw: 0, loss: 3, unknown: 0 });
  assert.deepEqual(t.series, { win: 1, draw: 0, loss: 0, unknown: 0 });
});

test("세트·시리즈 각각 승+무+패+미상 = 판 수", () => {
  const rows = [
    { series_id: "a", outcome: "win" as const }, { series_id: "a", outcome: "unknown" as const },
    { series_id: "b", outcome: "loss" as const }, { series_id: "c", outcome: "draw" as const },
  ];
  const t = tally(rows);
  assert.equal(total(t.sets), rows.length);
  assert.equal(total(t.series), 3);
  assert.deepEqual(t.series, { win: 0, draw: 1, loss: 1, unknown: 1 });
});

test("상대전적 한 세트 — 결과 짝표, 언제나 거울", () => {
  const all: Outcome[] = ["win", "draw", "loss", "unknown"];
  const flip = { win: "loss", loss: "win", draw: "draw", unknown: "unknown" } as const;
  for (const a of all) for (const b of all) {
    assert.equal(pairSetOutcome(b, a), flip[pairSetOutcome(a, b)], `${a}/${b}`);
  }
  assert.equal(pairSetOutcome("loss", "loss"), "draw");   // 양쪽 몰수
  assert.equal(pairSetOutcome("win", "win"), "unknown");  // 모순
  assert.equal(pairSetOutcome("win", "unknown"), "unknown");
  assert.deepEqual(mirror({ win: 2, draw: 1, loss: 3, unknown: 1 }), { win: 3, draw: 1, loss: 2, unknown: 1 });
});

test("진행 방식 — 게임별 허용, 미분류는 칩은 있되 라벨은 없다", () => {
  for (const g of ["lol", "fconline"] as const) {
    assert.equal(FORMATS_BY_GAME[g].at(-1), "unclassified");
    for (const f of FORMATS_BY_GAME[g]) assert.ok(FORMATS.includes(f));
  }
  assert.equal(allowedFormat("fconline", "scrim"), false);
  assert.equal(allowedFormat("lol", "friendly"), false);
  assert.equal(formatLabel("unclassified"), null);
  assert.equal(formatChipLabel("unclassified"), "분류 전");
  assert.equal(new Set(FORMATS_BY_GAME.lol.concat(FORMATS_BY_GAME.fconline)).size, FORMATS.length);
});

test("확인 전(pending) 세트는 세지 않는다 — 목록 행을 넘겨도 점수는 확인된 세트로만(0093)", () => {
  const t = tally([
    { series_id: "s1", outcome: "win" }, { series_id: "s1", outcome: "loss", pending: true }, { series_id: "s1", outcome: "win" },
    { series_id: "s2", outcome: "loss", pending: true },
  ]);
  assert.deepEqual(t.sets, { win: 2, draw: 0, loss: 0, unknown: 0 });
  assert.deepEqual(t.series, { win: 1, draw: 0, loss: 0, unknown: 0 }, "전부 확인 전인 시리즈는 시리즈 수에도 없다");
});
