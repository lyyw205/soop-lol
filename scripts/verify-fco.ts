/** FC 온라인 수집 → 대회 연결 → 공개 질의의 최소 관통 검증. 외부 DB를 사용하지 않는다. */
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
const { linkFcoAccount, saveFcoMatch, linkFcoMatchToEvent } = await import("../packages/core/lib/games/fconline/ingest.ts");
const { listFcoEvents, listFcoEventGames, listFcoVersus, listFcoTopPairs,
  listFcoGamesForPerson, listFcoStreamerGamesForPerson, listFcoModesForPerson,
  getFcoGame, listFcoPeople, getFeaturedFcoPair, FCO_PUBLIC_MATCH_INFO_KEYS } = await import("../packages/core/lib/db/fconline.ts");

/** 공개 조회 함수의 반환값 전부를 한 문자열로. 신원 문자열이 어디에든 남으면 여기서 잡힌다. */
async function publicDump(personIds: string[]): Promise<string> {
  const out: unknown[] = [await listFcoPeople(), await listFcoTopPairs(),
    await getFeaturedFcoPair(), await listFcoEvents()];
  for (const event of await listFcoEvents()) out.push(await listFcoEventGames(event.id));
  for (const id of personIds) {
    out.push(await listFcoGamesForPerson(id), await listFcoStreamerGamesForPerson(id));
    for (const other of personIds) if (other !== id) out.push(await listFcoVersus(id, other));
  }
  for (const providerId of ["fco-test-1", "fco-test-public-user", "fco-test-hidden-person"]) {
    out.push(await getFcoGame(providerId));
  }
  return JSON.stringify(out);
}

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
  await linkFcoMatchToEvent({
    providerMatchId: detail.matchId, eventSlug: "fc-cup-test", eventName: "FC 검증컵",
    sourceUrl: "https://example.com/fc-cup-test",
  });
  const events = await listFcoEvents();
  assert.equal(events[0]?.game_count, 1);
  const games = await listFcoEventGames(events[0].id);
  assert.equal(games.length, 1);
  assert.equal(games[0].participants.length, 2);
  assert.equal(games[0].participants[0].goals, 2);
  assert.equal(games[0].participants[0].score_display, 3);
  const people = await sql<{ id: string; slug: string }[]>`SELECT id, slug FROM streamer WHERE slug IN ('alpha-fc','beta-fc')`;
  assert.equal((await listFcoVersus(people[0].id, people[1].id)).length, 1);
  const topPairs = await listFcoTopPairs();
  assert.equal(topPairs.length, 1);
  assert.equal(topPairs[0].games, 1);
  assert.equal(topPairs[0].a_wins + topPairs[0].b_wins, 1);
  assert.equal(topPairs[0].draws, 0);
  for (const person of people) {
    assert.deepEqual(await listFcoTopPairs(1, person.id), topPairs,
      "저장된 쌍의 좌우에 관계없이 검색한 스트리머의 맞대결을 찾는다");
  }
  const [noRecords] = await sql`INSERT INTO streamer (slug, display_name) VALUES ('no-records-fc', '기록 없음') RETURNING id`;
  assert.equal((await listFcoTopPairs(1, noRecords.id)).length, 0, "기록이 없으면 전체 인기 쌍을 대신 보여주지 않는다");
  await sql`DELETE FROM streamer WHERE id = ${noRecords.id}`;
  assert.equal((await listFcoGamesForPerson(people[0].id)).length, 2);
  assert.equal((await listFcoStreamerGamesForPerson(people[0].id)).length, 1);
  assert.deepEqual(await listFcoModesForPerson(people[0].id), ["50", "60"]);
  assert.equal((await listFcoGamesForPerson(people[0].id, 200, { mode: "50" })).length, 1);
  assert.equal((await listFcoStreamerGamesForPerson(people[0].id, 200, { mode: "50" })).length, 0);
  assert.equal((await listFcoGamesForPerson(people[0].id, 200, { from: "2026-09-22", to: "2026-09-22" })).length, 1);

  // ── 공개 반환값에서 신원이 새지 않는다 ─────────────────────────────
  // 숨긴 사람: 계정 연결은 공개인데 사람이 숨김이다.
  // 숨김 요청은 연결·수집 뒤에 온다 — 이미 저장된 경기에서 사라져야 한다.
  await sql`INSERT INTO streamer (slug, display_name) VALUES ('gamma-fc', '감마')`;
  await linkFcoAccount({ streamerSlug: "gamma-fc", ouid: "gamma-ouid", nickname: "감마감독", level: 100 });
  assert.equal(await saveFcoMatch({ ...detail, matchId: "fco-test-hidden-person", matchDate: "2026-09-24 13:00:00",
    matchInfo: [detail.matchInfo[0], { ...detail.matchInfo[1], ouid: "gamma-ouid", nickname: "감마감독" }],
  }), "saved");
  const [gamma] = await sql`SELECT id FROM streamer WHERE slug = 'gamma-fc'`;
  const beta = people.find((person) => person.slug === "beta-fc")!;
  assert.deepEqual(await listFcoTopPairs(8, beta.id), topPairs, "검색한 사람과 관계없는 쌍은 제외한다");
  // 알파-베타가 전체 1위여도 감마 검색에서는 알파-감마를 LIMIT 전에 찾아야 한다.
  await saveFcoMatch({ ...detail, matchId: "fco-test-ranking" });
  const [gammaPair] = await listFcoTopPairs(1, gamma.id);
  assert.ok(gammaPair && [gammaPair.a_id, gammaPair.b_id].includes(gamma.id));
  assert.equal(gammaPair.games, 1);
  await sql`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'gamma-fc'`;
  assert.equal((await listFcoTopPairs(8, gamma.id)).length, 0, "숨긴 스트리머는 범위를 지정해도 나오지 않는다");
  // 허용 목록 밖의 키는 넥슨이 새로 붙여도 나가지 않는다.
  await sql`UPDATE fco_match_participant SET match_info = match_info || '{"futureField":"새키"}'::jsonb`;

  const alphaId = people.find((p) => p.slug === "alpha-fc")!.id;
  const betaId = people.find((p) => p.slug === "beta-fc")!.id;
  const leaks = (dump: string, secrets: string[]) => secrets.filter((secret) => dump.includes(secret));

  let dump = await publicDump([alphaId, betaId]);
  assert.deepEqual(leaks(dump, ["ordinary-ouid", "일반감독"]), [], "미등록 상대의 신원이 공개 반환값에 남았다");
  assert.deepEqual(leaks(dump, ["gamma-ouid", "감마감독", "감마"]), [], "숨긴 사람의 신원이 공개 반환값에 남았다");
  assert.deepEqual(leaks(dump, ["futureField", "새키"]), [], "허용 목록 밖의 match_info 키가 나갔다");
  assert.ok(dump.includes("알파감독") && dump.includes("베타감독"), "공개 계정은 그대로 보여야 한다");

  const [shown] = await listFcoVersus(alphaId, betaId);
  const info = shown.participants[0].match_info;
  assert.deepEqual(Object.keys(info).sort(), ["defence", "matchDetail", "pass", "player", "shoot"],
    "통계 키는 남고 신원 키는 빠진다");
  assert.ok(Object.keys(info).every((key) => (FCO_PUBLIC_MATCH_INFO_KEYS as readonly string[]).includes(key)));
  assert.equal((info.shoot as { goalTotalDisplay: number }).goalTotalDisplay, 3, "슛 통계가 살아 있어야 한다");

  // 숨긴 계정: 사람은 공개인데 이 계정 연결만 숨김이다.
  await sql`UPDATE streamer_fco_account SET visibility = 'hidden' WHERE ouid = 'beta-ouid'`;
  assert.equal((await listFcoStreamerGamesForPerson(alphaId)).length, 0);
  assert.equal((await listFcoTopPairs()).length, 0);
  dump = await publicDump([alphaId, betaId]);
  assert.deepEqual(leaks(dump, ["beta-ouid", "베타감독"]), [], "숨긴 계정의 신원이 공개 반환값에 남았다");
  assert.ok((await listFcoGamesForPerson(alphaId)).length > 0, "숨긴 계정과의 경기 자체는 알파 쪽에서 보인다");
  console.log("FC 수집·대회 연결·상대전적·공개 반환값 신원 차단 검증 통과");
} finally {
  await closeDb();
  await server.stop();
  await database.close();
}
