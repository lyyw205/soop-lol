import { test } from "node:test";
import assert from "node:assert/strict";
import { isLanePair, pairResult, selectPairs, summarizeOpponents, type PairSetRow } from "./opponent-history.ts";
import { mirror } from "./tally.ts";

const row = (match_id: string, o: Partial<PairSetRow> = {}): PairSetRow => ({
  other_id: "b", match_id, series_id: match_id, series_game_no: null, played_at: "2026-09-19T01:00:00Z",
  relation: "opponent", a_outcome: "win", b_outcome: "loss", a_position: "MIDDLE", b_position: "MIDDLE", ...o,
});

test("상대편 세트는 두 사람의 결과 짝으로 센다 — 양쪽 몰수는 무, 어긋난 짝은 미상", () => {
  assert.equal(pairResult(row("1")), "win");
  assert.equal(pairResult(row("1", { a_outcome: "loss", b_outcome: "loss" })), "draw");
  assert.equal(pairResult(row("1", { a_outcome: "win", b_outcome: "win" })), "unknown");
  // 같은 팀이면 짝이 아니라 본인 결과다(둘이 함께 이겼다).
  assert.equal(pairResult(row("1", { relation: "teammate", b_outcome: "win" })), "win");
});

test("★ 맞라인은 세트 단위 — 포지션을 못 정한 판은 맞라인이 아니다(원칙 10)", () => {
  assert.equal(isLanePair(row("1")), true);
  assert.equal(isLanePair(row("1", { b_position: "TOP" })), false);
  assert.equal(isLanePair(row("1", { a_position: null, b_position: null })), false);
  assert.equal(isLanePair(row("1", { relation: "teammate" })), false);
  // 일부 세트만 맞라인인 시리즈 — 맞라인 세트만 남고, 시리즈는 그 세트로 센다.
  const rows = [row("s1", { series_id: "bo3" }), row("s2", { series_id: "bo3", b_position: "TOP", a_outcome: "loss", b_outcome: "win" })];
  const [only] = summarizeOpponents(selectPairs(rows, "lane"));
  assert.deepEqual(only.record.sets, { win: 1, draw: 0, loss: 0, unknown: 0 });
  assert.deepEqual(only.record.series, { win: 1, draw: 0, loss: 0, unknown: 0 });
});

test("상대별 세트·시리즈 — CK 2:1 은 세트 2승 1패·시리즈 1승, 같은 팀 세트는 상대 전적에 없다", () => {
  const rows = selectPairs([
    row("s1", { series_id: "ck" }), row("s2", { series_id: "ck", a_outcome: "loss", b_outcome: "win" }), row("s3", { series_id: "ck" }),
    row("ally", { relation: "teammate", other_id: "friend" }),
  ], "opponent");
  const result = summarizeOpponents(rows);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].record.sets, { win: 2, draw: 0, loss: 1, unknown: 0 });
  assert.deepEqual(result[0].record.series, { win: 1, draw: 0, loss: 0, unknown: 0 });
});

test("같은 세트가 두 번 와도 한 번만 세고, 마지막으로 만난 날은 가장 늦은 세트", () => {
  const first = row("s1", { series_id: "x" });
  const [r] = summarizeOpponents([first, first, row("s2", { series_id: "y", played_at: "2026-10-01T00:00:00Z" })]);
  assert.equal(r.record.sets.win, 2);
  assert.equal(r.last_met.toISOString(), "2026-10-01T00:00:00.000Z");
});

test("★ A 의 기록과 B 의 기록은 언제나 거울이다", () => {
  const sets = [["win", "loss"], ["loss", "win"], ["loss", "loss"], ["win", "win"], ["unknown", "loss"]] as const;
  const a = summarizeOpponents(sets.map(([x, y], i) => row(`m${i}`, { other_id: "B", a_outcome: x, b_outcome: y })))[0];
  const b = summarizeOpponents(sets.map(([x, y], i) => row(`m${i}`, { other_id: "A", a_outcome: y, b_outcome: x })))[0];
  assert.deepEqual(mirror(a.record.sets), b.record.sets);
  assert.deepEqual(mirror(a.record.series), b.record.series);
});
