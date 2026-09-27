/** Public tournament query integration test. Always uses a disposable PGlite DB. */
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { applyAll } from './lib/migrations.ts';
import { freePort } from './lib/disposable-postgres.ts';
const memory = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
const port = await freePort();
const server = new PGLiteSocketServer({ db: memory, port, host: '127.0.0.1' });
await server.start();
process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
process.env.DATABASE_POOL_MAX = '1';
const { db, closeDb } = await import('../packages/core/lib/db/client.ts');
const { ensureEvent, saveEventTeams, saveTournamentGame, saveEventLinks, saveEventFacts } = await import('../packages/core/lib/db/tournaments.ts');
// 대회 목록·상세 조립은 대회 모듈의 것이다(core 는 사실만 내보낸다).
const { listTournaments: listPublicTournaments, getTournament: getPublicTournament } = await import('../packages/modules/tournaments/server/index.ts');
try {
  await applyAll(sql => memory.exec(sql), new URL('..', import.meta.url).pathname);
  const sql = db();
  const [visible] = await sql`INSERT INTO streamer(slug,display_name) VALUES ('visible','공개선수') RETURNING id`;
  const [hidden] = await sql`INSERT INTO streamer(slug,display_name,visibility) VALUES ('hidden','비공개선수','hidden') RETURNING id`;
  const eventId = await ensureEvent({ slug: 'meljang-test', name: '검증 대회', kind: 'tournament' });
  const teams = await saveEventTeams(eventId, [
    { name: '우승팀', placement: '우승', placement_rank: 1, prize: '100만 원', vote_rank: 2,
      members: [{ streamer_id: visible.id, position: 'TOP', is_captain: true, rating_label: 'S', rating_points: 43.5, award: 'FINAL MVP' }] },
    { name: '상대팀', placement: '5–6위', placement_rank: 5, vote_rank: 1,
      members: [{ streamer_id: hidden.id, position: 'TOP', is_captain: true, rating_label: 'F-', rating_points: 11, award: '숨은상' }] },
  ]);
  await saveEventLinks(eventId, [{ label: '공식 다시보기', url: 'https://example.com/vod' }, { label: '공식 안내', url: 'https://example.com/notice' }]);
  await saveEventFacts(eventId, [
    { section: '운영', label: '방식', value: '더블 엘리미네이션' },
    { section: '중계진', label: '해설', value: '가\n나' },
  ]);
  const game = {
    match_id: 'public-set', event_id: eventId, played_at: new Date('2026-07-31T16:00:00Z'),
    duration: 1200, source_url: 'https://example.com/official', series_id: 'final', series_game_no: 1,
    round_label: '결승', set_order_known: true, played_at_precision: 'datetime', best_of: 3, best_of_evidence: 'Isolated fixture rules: BO3',
    blue_team_id: teams.get('우승팀'), red_team_id: teams.get('상대팀'), winning_team: 100,
    participants: [visible, hidden].map((s,i) => ({ puuid: null, streamer_id: s.id, team_id: i ? 200 : 100, champion_id: 1, kills: 1, deaths: 1, assists: 1 })),
  };
  await saveTournamentGame(game);
  await saveTournamentGame({ ...game, match_id: 'hidden-set', series_game_no: 2 });
  await sql`UPDATE match SET visibility='hidden' WHERE match_id='hidden-set'`;
  const ckId = await ensureEvent({ slug: 'ck-test', name: 'CK 경기', kind: 'ck' });
  await saveTournamentGame({ ...game, match_id: 'ck-set', event_id: ckId, series_id: 'ck-series', blue_team_id: null, red_team_id: null });
  const showId = await ensureEvent({ slug: 'showmatch-test', name: '쇼매치', kind: 'showmatch' });
  await saveTournamentGame({ ...game, match_id: 'show-set', event_id: showId, series_id: 'show-series', blue_team_id: null, red_team_id: null });
  const scrimId = await ensureEvent({ slug: 'scrim-test', name: '스크림', kind: 'scrim' });
  await saveTournamentGame({ ...game, match_id: 'scrim-set', event_id: scrimId, series_id: 'scrim-series', blue_team_id: null, red_team_id: null });
  const allstarId = await ensureEvent({ slug: 'meljang-test-allstar', name: '올스타 대회', kind: 'tournament' });
  await saveTournamentGame({ ...game, match_id: 'allstar-set', event_id: allstarId, series_id: 'allstar-series', blue_team_id: null, red_team_id: null });
  const fcId = await ensureEvent({ slug: 'fc-test', name: 'FC 대회', kind: 'tournament' });
  await sql`INSERT INTO match(match_id,game_code,mode_key,source,origin,event_id,game_creation) VALUES ('fc-set','fconline','50','manual','wiki_seed',${fcId}::uuid,now())`;
  const list = await listPublicTournaments();
  assert.equal(list.length, 2, 'only LoL tournaments included; CK, scrim, showmatch and FC excluded');
  assert.ok(list.every(e => e.kind === 'tournament'));
  assert.equal(list.find(e => e.id === allstarId).category, 'event');
  const summary = list.find(e => e.id === eventId);
  assert.equal(summary.setCount, 1, 'hidden set does not affect counts');
  assert.equal(summary.start, '2026-08-01', 'match fallback uses KST date');
  assert.equal(summary.winner, '우승팀');
  assert.ok(summary.searchNames.includes('공개선수'));
  assert.ok(!summary.searchNames.includes('비공개선수'));
  assert.ok(list.find(e => e.id === allstarId).searchNames.includes('공개선수'), 'participant search works without event roster');
  const detail = await getPublicTournament('meljang-test');
  assert.equal(detail.series.length, 1);
  assert.equal(detail.series[0].round, '결승');
  assert.equal(detail.series[0].sets.length, 1);
  assert.equal(detail.series[0].sets[0].sourceUrl, game.source_url);
  assert.equal(detail.series[0].sets[0].players.length, 1, 'hidden streamer is absent from set roster');
  assert.equal(detail.teams.flatMap(t => t.members).length, 1, 'hidden streamer is absent from event roster');
  // 0039 — 주최측 발표 사실. 숨긴 사람의 등급·팀장·수상은 공개 조회 어디에도 없어야 한다.
  const champ = detail.teams.find(t => t.name === '우승팀');
  assert.deepEqual([champ.prize, champ.voteRank], ['100만 원', 2]);
  assert.deepEqual(champ.members[0].rating, { label: 'S', points: 43.5 }, 'numeric points come back as a number');
  assert.equal(champ.members[0].isCaptain, true);
  assert.equal(champ.members[0].award, 'FINAL MVP');
  const loser = detail.teams.find(t => t.name === '상대팀');
  assert.equal(loser.rank, 5, 'en-dash range placement is ranked');
  const dump = JSON.stringify(detail);
  assert.ok(!dump.includes('F-') && !dump.includes('숨은상'), 'hidden member facts never leave core_public');
  assert.deepEqual(detail.links.map(l => l.label), ['공식 다시보기', '공식 안내'], 'links keep file order');
  assert.deepEqual(detail.facts.map(f => f.label), ['방식', '해설']);
  await saveEventLinks(eventId, [{ label: '공식 안내', url: 'https://example.com/notice' }]);
  assert.equal((await getPublicTournament('meljang-test')).links.length, 1, 'links absent from the file are removed');
  assert.equal(await getPublicTournament('fc-test'), null);
  for (const slug of ['ck-test', 'scrim-test', 'showmatch-test']) {
    assert.equal(await getPublicTournament(slug), null, `${slug} cannot open as a tournament`);
  }
  assert.equal(await getPublicTournament('nonexistent'), null);
  console.log('PASS public tournament queries: tournament-only list/detail, privacy, game isolation, search, KST, metadata and rosters.');
} finally {
  await closeDb();
  await server.stop();
  await memory.close();
}
