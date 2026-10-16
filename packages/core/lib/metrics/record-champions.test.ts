import { test } from "node:test";
import assert from "node:assert/strict";
import { championRecords, type ChampionSetRow } from "./record-champions.ts";

const set = (match_id: string, champion_id: number | null, outcome: ChampionSetRow["outcome"], kda: [number, number, number] | null = [1, 1, 1]): ChampionSetRow =>
  ({ match_id, series_id: match_id, champion_id, outcome, kills: kda?.[0] ?? null, deaths: kda?.[1] ?? null, assists: kda?.[2] ?? null });

test("챔피언별 판 수 = 승+무+패+미상, 미상을 패로 넣지 않는다", () => {
  const [ahri] = championRecords([set("1", 103, "win"), set("2", 103, "loss"), set("3", 103, "unknown"), set("4", 103, "draw")], []);
  assert.equal(ahri.games, 4);
  assert.deepEqual(ahri.record, { win: 1, draw: 1, loss: 1, unknown: 1 });
});

test("★ KDA 는 셋을 다 읽은 판만 평균에 넣는다(0020 ⑧)", () => {
  const [c] = championRecords([set("1", 1, "win", [10, 2, 4]), set("2", 1, "loss", null)], []);
  assert.equal(c.kda_games, 1);
  assert.equal(c.kills, 10);
});

test("챔피언 미상(0·NULL)도 한 줄 — 빼면 판 수 합이 맞지 않는다", () => {
  const rows = championRecords([set("1", null, "win"), set("2", 0, "loss"), set("3", 7, "win")], []);
  assert.equal(rows.reduce((n, r) => n + r.games, 0), 3);
  assert.equal(rows.find((r) => r.champion_id === 0)?.games, 2);
});

test("맞라인 상대 챔피언은 내 세트의 챔피언 아래로, 결과는 상대전적 짝 결과", () => {
  const [c] = championRecords([set("1", 103, "win"), set("2", 103, "win")], [
    { match_id: "1", series_id: "1", foe_champion_id: 61, outcome: "win" },
    { match_id: "2", series_id: "2", foe_champion_id: 61, outcome: "unknown" },
    { match_id: "x", series_id: "x", foe_champion_id: 61, outcome: "win" }, // 내 세트에 없는 판은 버린다
  ]);
  assert.equal(c.matchups.length, 1);
  assert.equal(c.matchups[0].games, 2);
  assert.deepEqual(c.matchups[0].record, { win: 1, draw: 0, loss: 0, unknown: 1 });
});

test("판 많은 순 · limit", () => {
  const rows = championRecords([set("1", 1, "win"), set("2", 2, "win"), set("3", 2, "loss"), set("4", 3, "win")], [], 2);
  assert.deepEqual(rows.map((r) => r.champion_id), [2, 1]);
});
