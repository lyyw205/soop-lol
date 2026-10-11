import assert from "node:assert/strict";
import { db } from "../../packages/core/lib/db/client.ts";
import { assignMatchSeries, getMatchSeriesContext } from "../../packages/core/lib/db/match-series-review.ts";

/**
 * 경기 화면의 시리즈 묶기(assignMatchSeries) — 새로 묶기·이어 넣기·대회가 다르면 통째 취소·세트 사이 번호 거부·
 * 이미 시리즈가 있는 경기 거부, 그리고 시리즈 칸 조회(세트 순서·후보는 같은 대회만). 폐기용 DB 에서만 부른다.
 */
export async function verifyMatchSeriesDb() {
  const sql = db();
  const [e1] = await sql`INSERT INTO event (slug, name, kind) VALUES ('series-ui-1', '시리즈 칸 검증 1', 'ck') RETURNING id`;
  const [e2] = await sql`INSERT INTO event (slug, name, kind) VALUES ('series-ui-2', '시리즈 칸 검증 2', 'ck') RETURNING id`;
  const at = (minute: number) => new Date(Date.UTC(2031, 0, 1, 12, minute));
  const add = async (id: string, minute: number, event: string) => {
    await sql`INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, map_id, source, origin, game_creation, game_creation_precision, winning_team, event_id)
      VALUES (${id}, 'lol', 0, '0', 'CLASSIC', 11, 'manual', 'vod_scan', ${at(minute)}, 'datetime', 100, ${event})`;
    for (let p = 1; p <= 2; p++) await sql`INSERT INTO match_participant (match_id, participant_id, team_id, observed_name, champion_id, outcome)
      VALUES (${id}, ${p}, ${p === 1 ? 100 : 200}, ${`시리즈선수${p}`}, ${p}, ${p === 1 ? 'win' : 'loss'})`;
  };
  await add("su:E", 0, e1.id); await add("su:A", 60, e1.id); await add("su:F", 80, e1.id);
  await add("su:B", 100, e1.id); await add("su:C", 140, e1.id); await add("su:D", 70, e2.id);
  const series = async (id: string) => (await sql`SELECT series_id, series_game_no, event_id FROM match WHERE match_id = ${id}`)[0];

  // 시리즈 미지정 경기의 후보는 같은 대회만, 시각 순.
  const before = await getMatchSeriesContext("su:A");
  assert.equal(before!.series, null);
  assert.deepEqual(before!.candidates.map((c) => c.match_id), ["su:E", "su:F", "su:B", "su:C"], "다른 대회(su:D)는 후보가 아니다");
  assert.ok(before!.candidates.every((c) => c.shared === 2));

  // 새로 묶기 — 먼저 시작한 쪽이 1. 시리즈가 대회를 넘겨받고 경기의 대회 칸은 비운다.
  assert.deepEqual(await assignMatchSeries({ match_id: "su:B", pair_with: "su:A" }), { series_id: "series:su:A", series_game_no: 2 });
  assert.deepEqual({ ...(await series("su:A")) }, { series_id: "series:su:A", series_game_no: 1, event_id: null });
  assert.equal((await series("su:B")).series_game_no, 2);
  assert.equal((await sql`SELECT event_id FROM match_series WHERE id = 'series:su:A'`)[0].event_id, e1.id);
  assert.ok((await sql`SELECT 1 FROM review_change WHERE match_id = 'su:A' AND field = 'series_id'`).length, "수정 이력에 남는다");

  // 이어 넣기 — 시각상 3번째.
  assert.deepEqual(await assignMatchSeries({ match_id: "su:C", join_series: "series:su:A" }), { series_id: "series:su:A", series_game_no: 3 });
  const ctx = await getMatchSeriesContext("su:B");
  assert.deepEqual(ctx!.sets.map((s) => [s.match_id, s.series_game_no]), [["su:A", 1], ["su:B", 2], ["su:C", 3]]);
  assert.equal(ctx!.candidates.length, 0);

  // 기존 세트 사이(A 와 B 사이)에 끼면 번호를 지어내지 않는다.
  await assert.rejects(assignMatchSeries({ match_id: "su:F", join_series: "series:su:A" }), /2세트 자리인데 그 번호에 이미 세트가 있다/);
  assert.equal((await series("su:F")).series_id, null);
  // 대회가 다른 두 경기는 묶지 않는다 — 앞 경기 저장까지 통째로 취소된다.
  await assert.rejects(assignMatchSeries({ match_id: "su:D", pair_with: "su:E" }), /event가 기존 값과 다릅니다/);
  assert.equal((await series("su:E")).series_id, null);
  assert.equal((await sql`SELECT 1 FROM match_series WHERE id = 'series:su:E'`).length, 0);
  // 이미 시리즈가 있는 경기는 다른 시리즈로 옮기지 않는다.
  await assert.rejects(assignMatchSeries({ match_id: "su:A", pair_with: "su:E" }), /이미 시리즈/);
  console.log("  ok   시리즈 칸: 같은 대회 후보·새로 묶기(대회 이전·이력)·이어 넣기·세트 사이 번호 거부·대회 다르면 통째 취소·이미 시리즈면 거부");
}
