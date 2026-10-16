/** FC 대회 날짜·최신순 회귀 검증. 격리된 DB에만 쓰며 실제 조회와 화면 날짜 함수를 함께 검사한다. */
import assert from "node:assert/strict";
import { join } from "node:path";
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
const { listFcoEvents, getFcoEvent, listFcoEventGames, listFcoRecentEvents } = await import("../packages/core/lib/db/fconline.ts");
const { eventPeriod, eventYear } = await import("../packages/modules/fc_tournaments/ui/event-dates.ts");

try {
  await applyAll((sql) => database.exec(sql), join(import.meta.dirname, ".."));
  const sql = db();
  await sql`INSERT INTO streamer (slug, display_name) VALUES ('dates-player', '날짜 검증')`;
  await linkFcoAccount({ streamerSlug: "dates-player", ouid: "dates-ouid", nickname: "날짜 검증", level: 100 });

  async function event(slug: string, start: string | null = null, end: string | null = null) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO event (slug, name, game_code, kind, starts_at, ends_at)
      VALUES (${slug}, ${slug}, 'fconline', 'tournament', ${start}, ${end}) RETURNING id`;
    return row.id;
  }
  async function match(id: string, eventId: string, at: string, options: { series?: string; hidden?: boolean; unlinked?: boolean } = {}) {
    await saveFcoMatch({ matchId: id, matchDate: at, matchType: 60, matchInfo: [
      { ouid: options.unlinked ? 'unknown-ouid' : 'dates-ouid', nickname: '날짜 검증',
        matchDetail: { matchResult: '승' }, shoot: { goalTotal: 2 } },
      { ouid: 'opponent-ouid', nickname: '상대', matchDetail: { matchResult: '패' }, shoot: { goalTotal: 1 } },
    ] });
    if (options.series) {
      await sql`INSERT INTO match_series (id, game_code, event_id) VALUES (${options.series}, 'fconline', ${eventId})`;
      await sql`UPDATE match SET series_id = ${options.series}, series_game_no = 1 WHERE match_id = ${'fco:' + id}`;
    } else {
      await sql`UPDATE match SET event_id = ${eventId} WHERE match_id = ${'fco:' + id}`;
    }
    if (options.hidden) await sql`UPDATE match SET visibility = 'hidden' WHERE match_id = ${'fco:' + id}`;
  }

  // 등록 시각과 경기 날짜를 반대로 둔다. starts_at이 없는 최신 대회가 기존 버그처럼 아래로 밀리면 실패한다.
  const older = await event('older', '2026-08-25T03:00:00Z', '2026-08-26T03:00:00Z');
  const latest = await event('latest');
  const middle = await event('middle');
  await event('unknown');
  await sql`UPDATE event SET created_at = '2026-10-13' WHERE slug IN ('older', 'middle', 'unknown')`;
  await sql`UPDATE event SET created_at = '2026-01-01' WHERE slug = 'latest'`;
  await match('older-game', older, '2026-08-26 03:00:00');
  await match('latest-first', latest, '2026-10-11 03:00:00');
  await match('latest-last', latest, '2026-10-12 03:00:00');
  await match('middle-game', middle, '2026-10-06 03:00:00');
  let events = await listFcoEvents();
  assert.deepEqual(events.map(e => e.slug), ['latest', 'middle', 'older', 'unknown']);
  assert.deepEqual(eventPeriod(events[0]), { text: '2026.10.11 ~ 2026.10.12', fromMatches: true });
  assert.equal(eventYear(events[0]), '2026');
  assert.equal(eventYear(events.at(-1)!), null);
  assert.deepEqual(eventPeriod(events.at(-1)!), { text: '일정 미정', fromMatches: false });

  // 직접 연결 2경기와 시리즈 연결 2경기의 합계가 실제 공개 경기 목록과 같아야 한다.
  await match('latest-series-a', latest, '2026-10-12 04:00:00', { series: 'series-a' });
  await match('latest-series-b', latest, '2026-10-12 05:00:00', { series: 'series-b' });
  await match('hidden-early', latest, '2025-01-01 03:00:00', { hidden: true });
  await match('hidden-late', latest, '2028-01-01 03:00:00', { hidden: true });
  await match('unlinked-early', latest, '2024-01-01 03:00:00', { unlinked: true });
  await match('unlinked-late', latest, '2029-01-01 03:00:00', { unlinked: true });
  const detail = await getFcoEvent('latest');
  assert.ok(detail);
  assert.equal(detail.game_count, 4);
  const games = await listFcoEventGames(latest);
  assert.equal(detail.game_count, games.length);
  assert.equal(detail.effective_starts_at?.toISOString(), new Date(games[0].played_at).toISOString());
  assert.equal(detail.effective_ends_at?.toISOString(), new Date(games.at(-1)!.played_at).toISOString());
  assert.deepEqual(detail, (await listFcoEvents()).find(e => e.slug === 'latest'));

  // 등록 일정이 있으면 실제 경기보다 우선한다. 메인은 계속 실제 마지막 경기 순서다.
  await sql`UPDATE event SET starts_at = '2027-01-02T03:00:00Z', ends_at = '2027-01-03T03:00:00Z' WHERE id = ${older}`;
  events = await listFcoEvents();
  assert.equal(events[0].slug, 'older');
  assert.equal(eventYear(events[0]), '2027');
  assert.deepEqual(eventPeriod(events[0]), { text: '2027.01.02 ~ 2027.01.03', fromMatches: false });
  const recent = await listFcoRecentEvents();
  assert.deepEqual(recent.map(e => e.slug), ['latest', 'middle', 'older']);
  assert.equal(recent[0].latest_provider_id, 'latest-series-b');
  assert.equal(recent[0].game_count, 4);

  // 연말 UTC 경기의 한국 날짜·연도와 같은 날짜의 정렬을 고정한다.
  const boundary = await event('boundary-a');
  await match('new-year', boundary, '2026-12-31 15:30:00');
  await event('boundary-b', '2026-12-31T15:30:00Z');
  events = await listFcoEvents();
  assert.deepEqual(events.slice(1, 3).map(e => e.slug), ['boundary-a', 'boundary-b']);
  for (const row of events.slice(1, 3)) {
    assert.equal(eventYear(row), '2027');
    assert.equal(eventPeriod(row).text, '2027.01.01');
  }
  await sql`UPDATE event SET kind = 'ck' WHERE id = ${middle}`;
  assert.ok(!(await listFcoEvents()).some(e=>e.slug === 'middle'), '대회 목록에는 CK가 없다');
  assert.equal((await getFcoEvent('middle'))?.kind,'ck','CK 상세는 계속 열린다');
  assert.ok((await listFcoRecentEvents()).some(e=>e.slug === 'middle'),'메인 최근 행사는 CK 포함');
  assert.equal(await getFcoEvent('missing'), null);
  await sql`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'dates-player'`;
  const hidden = await getFcoEvent('latest');
  assert.ok(hidden);
  assert.equal(hidden.effective_starts_at, null);
  assert.equal(hidden.effective_ends_at, null);
  assert.equal(hidden.game_count, 0);
  assert.equal((await listFcoRecentEvents()).length, 0);
  console.log('FC 대회 최신순·공통 날짜·KST 연도·공개 경기 집계 검증 통과');
} finally {
  await closeDb();
  await server.stop();
  await database.close();
}
