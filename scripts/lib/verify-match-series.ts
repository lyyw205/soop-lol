import assert from "node:assert/strict";
import { db } from "../../packages/core/lib/db/client.ts";
import { assignMatchSeries, getMatchSeriesContext } from "../../packages/core/lib/db/match-series-review.ts";
import { ensureAutoBucketInTx, lolCodeBucketSlug, placeSingleSetInTx } from "../../packages/core/lib/db/classification.ts";
import { lolEvent } from "./verify-ck-fixtures.ts";

/**
 * 경기 화면의 시리즈 묶기(assignMatchSeries) — 새로 묶기·이어 넣기·대회가 다르면 통째 취소·세트 사이 번호 거부·
 * 이미 시리즈가 있는 경기 거부, 그리고 시리즈 칸 조회(세트 순서·후보는 같은 대회만). 폐기용 DB 에서만 부른다.
 * ★ 0089: 판은 언제나 시리즈 안에 있다 — 묶이지 않은 판은 한 판짜리 시리즈(`set:<경기>`)에 있고, 묶으면 그 시리즈가 지워진다.
 */
export async function verifyMatchSeriesDb() {
  const sql = db();
  const e1 = { id: await lolEvent("series-ui-1", "ck", "시리즈 칸 검증 1") };
  const e2 = { id: await lolEvent("series-ui-2", "ck", "시리즈 칸 검증 2") };
  const at = (minute: number) => new Date(Date.UTC(2031, 0, 1, 12, minute));
  // 판을 행사에 두는 길은 classification.ts 하나다 — 시험도 그 길로 한 판짜리 시리즈에 둔다.
  const add = async (id: string, minute: number, event: string) => {
    await sql.begin(async (tx) => {
      await tx`INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, map_id, collected_via, scope, game_creation, game_creation_precision, winning_team)
        VALUES (${id}, 'lol', 0, '0', 'CLASSIC', 11, 'vod', 'personal', ${at(minute)}, 'datetime', 100)`;
      await placeSingleSetInTx(tx, { match_id: id, game_code: "lol", event_id: event, actor: "auto" });
    });
    for (let p = 1; p <= 2; p++) await sql`INSERT INTO match_participant (match_id, participant_id, team_id, observed_name, champion_id, outcome)
      VALUES (${id}, ${p}, ${p === 1 ? 100 : 200}, ${`시리즈선수${p}`}, ${p}, ${p === 1 ? 'win' : 'loss'})`;
  };
  await add("su:E", 0, e1.id); await add("su:A", 60, e1.id); await add("su:F", 80, e1.id);
  await add("su:B", 100, e1.id); await add("su:C", 140, e1.id); await add("su:D", 70, e2.id);
  const series = async (id: string) => (await sql`SELECT m.series_id, m.series_game_no, ms.event_id FROM match m JOIN match_series ms ON ms.id = m.series_id WHERE m.match_id = ${id}`)[0];

  // 시리즈 미지정 경기의 후보는 같은 대회만, 시각 순.
  const before = await getMatchSeriesContext("su:A");
  assert.equal(before!.series, null);
  assert.deepEqual(before!.candidates.map((c) => c.match_id), ["su:E", "su:F", "su:B", "su:C"], "다른 대회(su:D)는 후보가 아니다");
  assert.ok(before!.candidates.every((c) => c.shared === 2));

  // 새로 묶기 — 먼저 시작한 쪽이 1. 행사는 시리즈에만 있다(판에는 행사 칸이 없다). 비게 된 한 판짜리 시리즈는 지워진다.
  assert.deepEqual(await assignMatchSeries({ match_id: "su:B", pair_with: "su:A" }), { series_id: "series:su:A", series_game_no: 2 });
  assert.deepEqual({ ...(await series("su:A")) }, { series_id: "series:su:A", series_game_no: 1, event_id: e1.id });
  assert.equal((await series("su:B")).series_game_no, 2);
  assert.equal((await sql`SELECT 1 FROM match_series WHERE id IN ('set:su:A', 'set:su:B')`).length, 0, "빈 한 판짜리 시리즈는 남지 않는다");
  assert.ok((await sql`SELECT 1 FROM review_change WHERE match_id = 'su:A' AND field = 'series_id'`).length, "수정 이력에 남는다");

  // 이어 넣기 — 시각상 3번째.
  assert.deepEqual(await assignMatchSeries({ match_id: "su:C", join_series: "series:su:A" }), { series_id: "series:su:A", series_game_no: 3 });
  const ctx = await getMatchSeriesContext("su:B");
  assert.deepEqual(ctx!.sets.map((s) => [s.match_id, s.series_game_no]), [["su:A", 1], ["su:B", 2], ["su:C", 3]]);
  assert.equal(ctx!.candidates.length, 0);

  // 기존 세트 사이(A 와 B 사이)에 끼면 번호를 지어내지 않는다.
  await assert.rejects(assignMatchSeries({ match_id: "su:F", join_series: "series:su:A" }), /2세트 자리인데 그 번호에 이미 세트가 있다/);
  assert.equal((await series("su:F")).series_id, "set:su:F");
  // 행사가 다른 두 경기는 묶지 않는다 — 앞 경기 저장까지 통째로 취소된다.
  await assert.rejects(assignMatchSeries({ match_id: "su:D", pair_with: "su:E" }), /행사가 기존 값과 다르다/);
  assert.equal((await series("su:E")).series_id, "set:su:E");
  assert.equal((await sql`SELECT 1 FROM match_series WHERE id = 'series:su:E'`).length, 0);
  // 이미 시리즈가 있는 경기는 다른 시리즈로 옮기지 않는다. 한 판짜리 시리즈 키에는 넣지 않는다.
  await assert.rejects(assignMatchSeries({ match_id: "su:A", pair_with: "su:E" }), /이미 시리즈/);
  await assert.rejects(assignMatchSeries({ match_id: "su:F", join_series: "set:su:E" }), /한 판짜리 시리즈/);
  // 자동 미분류 묶음(토너먼트 코드 날짜 묶음) 안에서는 묶지 않는다 — 후보도 없다.
  const day = at(0);
  await sql.begin(async (tx) => {
    const bucket = await ensureAutoBucketInTx(tx, { game_code: "lol", slug: lolCodeBucketSlug(day), name: "코드 묶음", day });
    for (const id of ["su:T1", "su:T2"]) {
      await tx`INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, map_id, collected_via, scope, game_creation, game_creation_precision, winning_team, tournament_code, platform_id, riot_game_id)
        VALUES (${id}, 'lol', 0, '0', 'CLASSIC', 11, 'api', 'personal', ${day}, 'datetime', 100, ${id}, 'KR', ${id === "su:T1" ? 9001 : 9002})`;
      await placeSingleSetInTx(tx, { match_id: id, game_code: "lol", event_id: bucket, actor: "auto" });
    }
  });
  assert.deepEqual((await getMatchSeriesContext("su:T1"))!.candidates, [], "묶음 안의 판은 묶을 후보를 내지 않는다");
  await assert.rejects(assignMatchSeries({ match_id: "su:T1", pair_with: "su:T2" }), /자동 미분류 묶음/);
  console.log("  ok   시리즈 칸: 같은 행사 후보·새로 묶기(빈 한 판 시리즈 정리·이력)·이어 넣기·세트 사이 번호 거부·행사 다르면 통째 취소·이미 시리즈면 거부·자동 묶음 안 거부");
}
