import { test } from "node:test";
import assert from "node:assert/strict";
import { foldSeries, pageSeries } from "./record-series.ts";
import { recordCursor } from "./record-cursor.ts";
import type { Outcome } from "./tally.ts";

const set = (series_id: string, match_id: string, outcome: Outcome, played_at: string, series_game_no: number | null = null) =>
  ({ series_id, match_id, outcome, played_at, series_game_no });

test("시리즈 한 줄 — 세트 결과와 시리즈 결과를 tally 규칙으로 낸다", () => {
  const [g] = foldSeries([
    set("bo3", "g2", "loss", "2026-10-01T11:00:00Z", 2), set("bo3", "g1", "win", "2026-10-01T10:00:00Z", 1),
    set("bo3", "g3", "win", "2026-10-01T12:00:00Z", 3),
  ]);
  assert.deepEqual(g.sets.map((s) => s.match_id), ["g1", "g2", "g3"]);
  assert.deepEqual(g.record, { win: 2, draw: 0, loss: 1, unknown: 0 });
  assert.equal(g.result, "win");
  assert.equal(g.first.match_id, "g1");
});

test("★ 랜드도 같은 규칙 — 4승 3패는 시리즈 1승, 미상이 섞여 뒤집힐 수 있으면 미상", () => {
  const land = (["win", "win", "loss", "win", "loss", "win", "loss"] as Outcome[]).map((o, i) => set("land", `l${i}`, o, `2026-10-01T1${i}:00:00Z`));
  assert.equal(foldSeries(land)[0].result, "win");
  assert.equal(foldSeries([set("x", "a", "win", "2026-10-01T00:00:00Z"), set("x", "b", "unknown", "2026-10-01T01:00:00Z")])[0].result, "unknown");
});

test("최신 시리즈가 먼저, 이어 보기는 시리즈를 자르지 않는다", () => {
  const groups = foldSeries([
    set("old", "o1", "win", "2026-09-01T00:00:00Z"), set("new", "n1", "loss", "2026-10-01T00:00:00Z"),
    set("new", "n2", "loss", "2026-10-01T01:00:00Z"), set("mid", "m1", "win", "2026-09-15T00:00:00Z"),
  ]);
  assert.deepEqual(groups.map((g) => g.series_id), ["new", "mid", "old"]);
  const first = pageSeries(groups, null, 2);
  assert.deepEqual(first.rows.map((g) => g.series_id), ["new", "mid"]);
  assert.equal(first.more, true);
  assert.equal(first.rows[0].sets.length, 2);
  const next = pageSeries(groups, recordCursor(first.rows[1].played_at, first.rows[1].series_id), 2);
  assert.deepEqual(next.rows.map((g) => g.series_id), ["old"]);
  assert.equal(next.more, false);
});
