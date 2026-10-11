import assert from "node:assert/strict";
import { test } from "node:test";

import { checkSeries, rosterKey, sharedPlayers, type SeriesSetInput } from "./series-check.ts";

const roster = (blue: string[], red: string[]) => [
  ...blue.map((name, i) => ({ participant_id: i + 1, team_id: 100, key: `o:${name}`, name })),
  ...red.map((name, i) => ({ participant_id: i + 6, team_id: 200, key: `o:${name}`, name })),
];
const set = (id: string, no: number | null, minute: number, winner: number | null, blue: string[], red: string[], extra: Partial<SeriesSetInput> = {}): SeriesSetInput => ({
  match_id: id, series_game_no: no, game_creation_epoch_ms: minute * 60_000, game_creation_precision: "datetime",
  winning_team: winner, blue_team: null, red_team: null, participants: roster(blue, red), ...extra,
});
const A = ["a1", "a2", "a3", "a4", "a5"], B = ["b1", "b2", "b3", "b4", "b5"];

test("진영이 바뀌어도 로스터로 팀을 이어 누적 스코어를 낸다", () => {
  const check = checkSeries([
    set("g1", 1, 0, 100, A, B),     // A 승 1:0
    set("g2", 2, 40, 100, B, A),    // 진영 바뀜, B 승 1:1
    set("g3", 3, 80, 200, B, A),    // A 승 2:1
  ], 3);
  assert.deepEqual(check.sets.map((s) => s.score), [[1, 0], [1, 1], [2, 1]]);
  assert.deepEqual(check.warnings, []);
});

test("교체: 들어온 선수와 빠진 선수를 팀별로 낸다", () => {
  const check = checkSeries([set("g1", 1, 0, 100, A, B), set("g2", 2, 40, 200, ["a1", "a2", "a3", "a4", "x9"], B)], null);
  assert.deepEqual(check.sets[1].changes, [{ side: 100, joined: [{ participant_id: 5, name: "x9" }], left: ["a5"] }]);
});

test("로스터를 통째로 바꾸면 팀을 잇지 않는다 — 없는 교체·스코어를 지어내지 않는다", () => {
  const C = ["c1", "c2", "c3", "c4", "c5"], D = ["d1", "d2", "d3", "d4", "d5"];
  const check = checkSeries([set("g1", 1, 0, 100, A, B), set("g2", 2, 40, 100, C, D)], 3);
  assert.deepEqual(check.sets[1].changes, []);
  assert.equal(check.sets[1].score, null);
});

test("이상 신호: 승부가 난 뒤의 세트·겹치는 번호·빠진 번호·번호와 시각 순서 불일치", () => {
  const over = checkSeries([set("g1", 1, 0, 100, A, B), set("g2", 2, 40, 100, A, B), set("g3", 3, 80, 100, A, B)], 3);
  assert.match(over.warnings.join(), /승부가 난 뒤에도 세트가 있다 — g2 이후 g3/);
  const numbers = checkSeries([set("g1", 1, 0, 100, A, B), set("g2", 1, 40, 200, A, B), set("g4", 4, 80, 100, A, B)], null);
  assert.match(numbers.warnings.join("|"), /세트 번호가 겹친다 — 1세트/);
  assert.match(numbers.warnings.join("|"), /빠진 세트 번호 — 2, 3세트/);
  const order = checkSeries([set("g1", 2, 0, 100, A, B), set("g2", 1, 40, 200, A, B)], null);
  assert.match(order.warnings.join(), /세트 번호 순서와 경기 시각 순서가 다르다/);
  const dateOnly = checkSeries([set("g1", 2, 0, 100, A, B, { game_creation_precision: "date" }), set("g2", 1, 0, 200, A, B, { game_creation_precision: "date" })], null);
  assert.deepEqual(dateOnly.warnings, [], "날짜만 아는 경기는 시각 순서를 따지지 않는다");
});

test("보너스 판은 스코어·번호 점검에서 뺀다", () => {
  const check = checkSeries([set("g1", 1, 0, 100, A, B), set("g2", 2, 40, 100, A, B), set("bonus", null, 80, 200, A, B, { set_role: "bonus" })], 3);
  assert.deepEqual(check.sets.map((s) => s.score), [[1, 0], [2, 0], [2, 0]]);
  assert.deepEqual(check.warnings, []);
  assert.equal(check.sets[2].bonus, true);
});

test("승자를 모르면 그 뒤 스코어는 모른다", () => {
  const check = checkSeries([set("g1", 1, 0, null, A, B), set("g2", 2, 40, 100, A, B)], 3);
  assert.deepEqual(check.sets.map((s) => s.score), [null, null]);
});

test("묶을 후보: 팀과 무관하게 함께 나온 사람 수, 열쇠는 스트리머 연결이 먼저", () => {
  assert.equal(sharedPlayers(roster(A, B), roster(B, ["a1", "x", "y", "z", "w"])), 6);
  assert.equal(rosterKey({ streamer_slug: "slug", observed_name: "화면" }), "s:slug");
  assert.equal(rosterKey({ observed_name: " 화면 " }), "o:화면");
  assert.equal(rosterKey({}), null);
});
