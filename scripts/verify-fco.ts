import { recordCursor } from "../packages/core/lib/metrics/record-cursor.ts";
import { addFcoStats, EMPTY_FCO_STATS } from "../packages/core/lib/games/fconline/view.ts";
import { applyFcoMatchContext } from "../packages/core/lib/games/fconline/context.ts";
import { mirror, total } from "../packages/core/lib/metrics/tally.ts";
/**
 * FC 온라인 수집 → 분류 → 공개 질의의 관통 검증(docs/CLASSIFICATION-REDESIGN-PLAN.md §5). 외부 DB를 사용하지 않는다.
 * 감사 결과로 고친 것을 단언한다: B1 요약과 목록이 같은 집합 · B2 양쪽 몰수패가 어느 쪽에서 봐도 무(대칭) ·
 * B3 분류 전 판에 지어낸 라벨(행사 이름)이 없다 · 미상은 숨기지 않는다 · 한쪽만 스트리머인 판은 내전 집계 밖(개인 기록).
 */
import { join } from "node:path";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { applyAll } from "./lib/migrations.ts";
import { freePort } from "./lib/disposable-postgres.ts";

const database = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
const port = await freePort();
const server = new PGLiteSocketServer({ db: database, port, host: "127.0.0.1" });
await server.start();
process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
const { db, closeDb } = await import("../packages/core/lib/db/client.ts");
const { linkFcoAccount, saveFcoMatch } = await import("../packages/core/lib/games/fconline/ingest.ts");
const { listFcoEvents, listFcoRecentEvents, listFcoEventGames, listFcoVersus, listFcoTopPairs,
  listFcoGamesForPerson, listFcoStreamerGamesForPerson, listFcoModesForPerson, listFcoPersonalRecords,
  getFcoPersonalSummary, listFcoPersonalEvents, getFcoGame, listFcoPeople, getFeaturedFcoPair, FCO_PUBLIC_MATCH_INFO_KEYS } = await import("../packages/core/lib/db/fconline.ts");

/** 공개 조회 함수의 반환값 전부를 한 문자열로. 신원 문자열이 어디에든 남으면 여기서 잡힌다. */
async function publicDump(personIds: string[]): Promise<string> {
  const out: unknown[] = [await listFcoPeople(), await listFcoTopPairs(),
    await getFeaturedFcoPair(), await listFcoEvents(), await listFcoRecentEvents()];
  for (const event of await listFcoEvents()) out.push(await listFcoEventGames(event.id));
  for (const id of personIds) {
    out.push(await listFcoGamesForPerson(id), await listFcoStreamerGamesForPerson(id), await listFcoPersonalRecords(id));
    for (const other of personIds) if (other !== id) out.push(await listFcoVersus(id, other));
  }
  for (const providerId of ["fco-test-1", "fco-test-public-user", "fco-test-hidden-person"]) {
    out.push(await getFcoGame(providerId));
  }
  return JSON.stringify(out);
}

const player = (ouid: string, nickname: string, result: "승" | "무" | "패", goals: number, extra: Record<string, unknown> = {}) => ({
  ouid, nickname, matchDetail: { matchResult: result, possession: 50 },
  shoot: { goalTotal: goals, shootTotal: 5, effectiveShootTotal: 2 }, pass: { passTry: 10, passSuccess: 8 },
  defence: { tackleSuccess: 1 }, player: [], ...extra,
});

try {
  await applyAll((sql) => database.exec(sql), join(import.meta.dirname, ".."));
  const sql = db();
  await sql`INSERT INTO streamer (slug, display_name) VALUES ('alpha-fc', '알파'), ('beta-fc', '베타')`;
  await linkFcoAccount({ streamerSlug: "alpha-fc", ouid: "alpha-ouid", nickname: "알파감독", level: 100 });
  await linkFcoAccount({ streamerSlug: "beta-fc", ouid: "beta-ouid", nickname: "베타감독", level: 100 });
  const detail = {
    matchId: "fco-test-1", matchDate: "2026-09-22 12:00:00", matchType: 60,
    matchInfo: [
      { ouid: "alpha-ouid", nickname: "알파감독", matchDetail: { matchResult: "승" as const, possession: 54 },
        shoot: { goalTotal: 2, goalTotalDisplay: 3, shootTotal: 8, effectiveShootTotal: 4 },
        pass: { passTry: 100, passSuccess: 80 }, defence: { tackleSuccess: 9 }, player: [] },
      { ouid: "beta-ouid", nickname: "베타감독", matchDetail: { matchResult: "패" as const, possession: 46 },
        shoot: { goalTotal: 1, shootTotal: 4, effectiveShootTotal: 2 },
        pass: { passTry: 80, passSuccess: 60 }, defence: { tackleSuccess: 6 }, player: [] },
    ],
  };
  assert.equal(await saveFcoMatch(detail), "saved");
  assert.equal(await saveFcoMatch(detail), "saved");
  assert.equal(await saveFcoMatch({ ...detail, matchId: "fco-test-public-user",
    matchDate: "2026-09-23 13:00:00", matchType: 50,
    matchInfo: [detail.matchInfo[0], { ...detail.matchInfo[1], ouid: "ordinary-ouid", nickname: "일반감독" }],
  }), "saved");
  const people = await sql<{ id: string; slug: string }[]>`SELECT id, slug FROM streamer WHERE slug IN ('alpha-fc','beta-fc') ORDER BY slug`;
  const alphaId = people.find((p) => p.slug === "alpha-fc")!.id;
  const betaId = people.find((p) => p.slug === "beta-fc")!.id;

  // ── 내전 집계와 개인 기록의 경계 ─────────────────────────────────
  assert.equal((await listFcoGamesForPerson(alphaId)).length, 1, "한쪽만 스트리머인 판은 내전 집계에 없다");
  const personal = await listFcoPersonalRecords(alphaId);
  assert.equal(personal.total, 1, "그 판은 개인 기록으로만 보인다");
  assert.deepEqual(personal.sets, { win: 1, draw: 0, loss: 0, unknown: 0 });
  assert.equal(personal.games[0].format, null, "개인 기록 판에는 진행 방식이 없다");

  // B3 — 분류 전(자동 묶음) 판은 행사 이름을 내보내지 않는다. 진행 방식은 unclassified 로 정직하게.
  const [bucketGame] = await listFcoGamesForPerson(alphaId);
  assert.equal(bucketGame.event_name, null, "자동 묶음 이름(날짜 A vs B)을 행사처럼 보이지 않는다");
  assert.equal(bucketGame.format, "unclassified");

  await applyFcoMatchContext({ provider_match_id: detail.matchId, conclusion: "event", event: { slug: "fc-cup-test", name: "FC 검증컵", format: "tournament", source_url: "https://example.com/fc-cup-test" } });
  const events = await listFcoEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.game_count, 1);
  assert.equal(events[0]?.format, "tournament");
  const games = await listFcoEventGames(events[0].id);
  assert.equal(games.length, 1);
  assert.equal(games[0].participants.length, 2);
  assert.equal(games[0].participants[0].goals, 2);
  assert.equal(games[0].participants[0].score_display, 3);
  assert.equal(games[0].format, "tournament");
  assert.equal((await listFcoVersus(alphaId, betaId)).length, 1);
  const topPairs = await listFcoTopPairs();
  assert.equal(topPairs.length, 1);
  assert.equal(topPairs[0].games, 1);
  assert.equal(total(topPairs[0].record.sets), 1);
  for (const person of people) {
    const [mine] = await listFcoTopPairs(1, person.id);
    assert.equal(mine.a_id, person.id, "검색한 스트리머가 언제나 a 다");
    assert.equal(mine.games, 1);
  }
  const alphaView = (await listFcoTopPairs(1, alphaId))[0].record, betaView = (await listFcoTopPairs(1, betaId))[0].record;
  assert.deepEqual(betaView.sets, mirror(alphaView.sets), "상대전적은 대칭이다");
  const [noRecords] = await sql`INSERT INTO streamer (slug, display_name) VALUES ('no-records-fc', '기록 없음') RETURNING id`;
  assert.equal((await listFcoTopPairs(1, noRecords.id)).length, 0, "기록이 없으면 전체 인기 쌍을 대신 보여주지 않는다");
  await sql`DELETE FROM streamer WHERE id = ${noRecords.id}`;
  assert.deepEqual(await listFcoModesForPerson(alphaId), ["60"], "모드 선택지도 내전 세트에서");
  assert.equal((await listFcoGamesForPerson(alphaId, 200, { mode: "50" })).length, 0);
  assert.equal((await listFcoGamesForPerson(alphaId, 200, { from: "2026-09-22", to: "2026-09-22" })).length, 1);
  assert.equal((await listFcoGamesForPerson(alphaId, 200, { format: "tournament" })).length, 1, "진행 방식 칩");
  assert.equal((await listFcoGamesForPerson(alphaId, 200, { format: "ck" })).length, 0);

  // 홈은 입력된 대회 일정 대신 실제 공개 경기 날짜로 CK·대회를 함께 정렬한다.
  await saveFcoMatch({ ...detail, matchId: "fco-test-ck", matchDate: "2026-09-23 14:00:00" });
  await applyFcoMatchContext({ provider_match_id: "fco-test-ck", conclusion: "event", event: { slug: "recent-ck", name: "최근 CK", format: "ck", source_url: "https://example.com/recent-ck" } });
  await sql`UPDATE event SET starts_at = '2027-01-01' WHERE slug = 'fc-cup-test'`;
  let recent = await listFcoRecentEvents();
  assert.deepEqual(recent.map((e) => e.slug), ["recent-ck", "fc-cup-test"]);
  assert.equal(recent[0].latest_provider_id, "fco-test-ck");
  assert.equal(recent[0].game_count, 1);
  assert.equal((await listFcoRecentEvents(1)).length, 1);
  assert.ok(!(await listFcoEvents()).some((e) => e.slug === "recent-ck"), "대회 목록에는 CK 가 없다");
  await sql`UPDATE match SET visibility = 'hidden' WHERE match_id = 'fco:fco-test-ck'`;
  recent = await listFcoRecentEvents();
  assert.deepEqual(recent.map((e) => e.slug), ["fc-cup-test"], "공개 경기 없는 대회는 메인에 노출하지 않는다");
  await sql`UPDATE match SET visibility = 'public' WHERE match_id = 'fco:fco-test-ck'`;
  assert.ok(!(await listFcoRecentEvents()).some((e) => e.slug.startsWith("fc-auto-")), "자동 묶음은 행사가 아니다");

  // ── B2 — 양쪽 몰수패는 어느 쪽에서 봐도 무, 순서를 바꿔도 같다 ─────────────
  await saveFcoMatch({ matchId: "fco-test-forfeit", matchDate: "2026-09-24 10:00:00", matchType: 40,
    matchInfo: [player("beta-ouid", "베타감독", "패", 0), player("alpha-ouid", "알파감독", "패", 0)] });
  const vsA = await listFcoTopPairs(1, alphaId), vsB = await listFcoTopPairs(1, betaId);
  assert.equal(vsA[0].record.sets.draw, 1, "양쪽 몰수패는 상대전적에서 무");
  assert.deepEqual(vsB[0].record.sets, mirror(vsA[0].record.sets), "B2 대칭 — 순서와 무관");
  const forfeitSummary = await getFcoPersonalSummary(alphaId, { from: "2026-09-24", to: "2026-09-24" });
  assert.equal(forfeitSummary.record.sets.loss, 1, "개인 요약은 본인 결과 그대로(각자 패)");

  // ── B1 — 요약 카드와 목록이 같은 집합이다(어느 범위든) ─────────────
  await saveFcoMatch({ matchId: "fco-test-unknown", matchDate: "2026-09-24 11:00:00", matchType: 40,
    matchInfo: [player("alpha-ouid", "알파감독", "승", 1), player("beta-ouid", "베타감독", "승", 1)] });
  for (const filter of [{}, { mode: "40" }, { format: "unclassified" as const }, { format: "tournament" as const }, { from: "2026-09-24" }]) {
    const list = await listFcoGamesForPerson(alphaId, null, filter);
    const summary = await getFcoPersonalSummary(alphaId, filter);
    assert.equal(total(summary.record.sets), list.length, `B1 요약 세트 수 = 목록 판 수 ${JSON.stringify(filter)}`);
    assert.equal(summary.games, list.length);
    const eventsSum = (await listFcoPersonalEvents(alphaId, filter)).reduce((n, e) => n + e.games, 0);
    assert.equal(eventsSum, list.filter((g) => g.event_id).length, "행사 성적은 실제 행사 판만");
  }
  const all = await getFcoPersonalSummary(alphaId);
  assert.ok(all.record.sets.unknown >= 0 && total(all.record.sets) === all.games, "승+무+패+미상 = 판 수");
  const pairAll = (await listFcoTopPairs(1, alphaId))[0].record;
  assert.equal(pairAll.sets.unknown, 1, "승/승 짝은 미상으로 보인다(숨기지 않는다)");

  // ── 공개 반환값에서 신원이 새지 않는다 ─────────────────────────────
  await sql`INSERT INTO streamer (slug, display_name) VALUES ('gamma-fc', '감마')`;
  await linkFcoAccount({ streamerSlug: "gamma-fc", ouid: "gamma-ouid", nickname: "감마감독", level: 100 });
  assert.equal(await saveFcoMatch({ ...detail, matchId: "fco-test-hidden-person", matchDate: "2026-09-24 13:00:00",
    matchInfo: [detail.matchInfo[0], { ...detail.matchInfo[1], ouid: "gamma-ouid", nickname: "감마감독" }],
  }), "saved");
  const [gamma] = await sql`SELECT id FROM streamer WHERE slug = 'gamma-fc'`;
  const [gammaPair] = await listFcoTopPairs(1, gamma.id);
  assert.ok(gammaPair && gammaPair.a_id === gamma.id && gammaPair.games === 1);
  await sql`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'gamma-fc'`;
  assert.equal((await listFcoTopPairs(8, gamma.id)).length, 0, "숨긴 스트리머는 범위를 지정해도 나오지 않는다");
  await sql`UPDATE fco_match_participant SET match_info = match_info || '{"futureField":"새키"}'::jsonb`;
  const leaks = (dump: string, secrets: string[]) => secrets.filter((secret) => dump.includes(secret));
  let dump = await publicDump([alphaId, betaId]);
  assert.deepEqual(leaks(dump, ["ordinary-ouid", "일반감독"]), [], "미등록 상대의 신원이 공개 반환값에 남았다");
  assert.deepEqual(leaks(dump, ["gamma-ouid", "감마감독", "감마"]), [], "숨긴 사람의 신원이 공개 반환값에 남았다");
  assert.deepEqual(leaks(dump, ["futureField", "새키"]), [], "허용 목록 밖의 match_info 키가 나갔다");
  assert.ok(dump.includes("알파감독") && dump.includes("베타감독"), "공개 계정은 그대로 보여야 한다");
  const [shown] = await listFcoVersus(alphaId, betaId);
  const info = shown.participants[0].match_info;
  assert.ok(Object.keys(info).every((key) => (FCO_PUBLIC_MATCH_INFO_KEYS as readonly string[]).includes(key)), "통계 키만 남는다");

  // 참가자 신원 규칙이 공개 뷰와 하나다 — 내전 판에서 칸별 스트리머가 fc_versus_set 과 같다.
  const viewRows = await sql<{ match_id: string; side: number; streamer_id: string }[]>`SELECT match_id, side, streamer_id FROM core_public.fc_versus_set`;
  for (const g of await listFcoGamesForPerson(alphaId, null)) for (const p of g.participants) {
    const v = viewRows.find((r) => r.match_id === g.id && r.side === p.side_no);
    assert.equal(p.streamer_id ?? null, v?.streamer_id ?? null, `${g.id} ${p.side_no}칸 신원이 뷰와 다르다`);
  }

  // 숨긴 계정: 사람은 공개인데 이 계정 연결만 숨김이다.
  await sql`UPDATE streamer_fco_account SET visibility = 'hidden' WHERE ouid = 'beta-ouid'`;
  assert.equal((await listFcoTopPairs()).length, 0);
  dump = await publicDump([alphaId, betaId]);
  assert.deepEqual(leaks(dump, ["beta-ouid", "베타감독"]), [], "숨긴 계정의 신원이 공개 반환값에 남았다");
  assert.ok((await listFcoGamesForPerson(alphaId)).length > 0, "숨긴 계정과의 경기 자체는 알파 쪽에서 보인다");
  await sql`UPDATE streamer SET visibility = 'hidden' WHERE id = ${alphaId}`;
  assert.equal((await listFcoRecentEvents()).length, 0, "공개 스트리머가 없는 경기는 메인에서도 제외한다");
  await sql`UPDATE streamer SET visibility = 'public' WHERE id = ${alphaId}`;
  await sql`UPDATE streamer_fco_account SET visibility = 'public' WHERE ouid = 'beta-ouid'`;

  const full = await listFcoGamesForPerson(alphaId, null);
  const expectedStats = full.reduce((acc, g) => addFcoStats(acc, g.participants.find((p) => p.streamer_id === alphaId)!), EMPTY_FCO_STATS);
  const { lastPlayed, record, ...summary } = await getFcoPersonalSummary(alphaId);
  assert.deepEqual(summary, expectedStats, "요약 지표와 목록 지표가 같다");
  assert.ok(lastPlayed && record);

  // 다전제는 한 묶음이다 — 커서 페이지가 시리즈를 중간에서 끊지 않는다.
  await saveFcoMatch({ ...detail, matchId: "fco-s1", matchDate: "2026-10-01 10:00:00" });
  await saveFcoMatch({ ...detail, matchId: "fco-s2", matchDate: "2026-10-01 10:15:00" });
  await saveFcoMatch({ ...detail, matchId: "fco-late", matchDate: "2026-10-02 10:00:00" });
  await applyFcoMatchContext({ provider_match_id: "fco-s1", series: { id: "cap-series", game_no: 1 } });
  await applyFcoMatchContext({ provider_match_id: "fco-s2", series: { id: "cap-series", game_no: 2 } });
  const seriesSummary = await getFcoPersonalSummary(alphaId, { from: "2026-10-01", to: "2026-10-01" });
  assert.deepEqual([total(seriesSummary.record.sets), total(seriesSummary.record.series)], [2, 1], "세트와 시리즈를 같이 센다");
  const page1 = await listFcoStreamerGamesForPerson(alphaId, 2);
  assert.ok(page1.some((g) => g.series_id === "cap-series"));
  assert.equal(page1.filter((g) => g.series_id === "cap-series").length, 2, "한 묶음 두 세트가 한 페이지에 온다");
  const at = page1.filter((g) => g.series_id === "cap-series").map((g) => new Date(g.played_at)).sort((a, b) => +a - +b)[0];
  const page2 = await listFcoStreamerGamesForPerson(alphaId, 1, {}, recordCursor(at, "cap-series"));
  assert.ok(page2.length && page2.every((g) => !page1.some((p) => p.id === g.id)), "커서 페이지는 중복되지 않는다");
  console.log("FC 수집·분류·상대전적·공개 반환값 신원 차단·집계 일관성 검증 통과");
} finally {
  await closeDb();
  await server.stop();
  await database.close();
}
