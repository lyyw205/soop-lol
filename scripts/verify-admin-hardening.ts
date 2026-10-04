import assert from 'node:assert/strict';
import { join } from 'node:path';
import { disposablePglite } from './lib/disposable-pglite.ts';
import { applyAll } from './lib/migrations.ts';
const pg = await disposablePglite();
process.env.DATABASE_URL = pg.url; process.env.DATABASE_POOL_MAX = '1';
const { db, closeDb } = await import('../packages/core/lib/db/client.ts');
const { saveFcoMatch, linkFcoAccount } = await import('../packages/core/lib/games/fconline/ingest.ts');
const C = await import('../packages/core/lib/games/fconline/context.ts');
const B = await import('../packages/core/lib/games/fconline/match-units.ts');
const S = await import('../packages/core/lib/games/fconline/screen.ts');
const people = await import('../packages/core/lib/db/streamers.ts');
const player = (ouid: string, nickname: string, matchResult: "승" | "무" | "패", goalTotal: number) => ({ ouid, nickname, matchDetail: { matchResult }, shoot: { goalTotal } });
try {
  await applyAll(s => pg.database.exec(s), join(import.meta.dirname, '..'));
  const sql = db();
  await people.createStreamer({ slug: 'hard-a', display_name: 'A' });
  await people.createStreamer({ slug: 'hard-b', display_name: 'B' });
  await linkFcoAccount({ streamerSlug: 'hard-a', ouid: 'a', nickname: 'A', level: 1 });
  await linkFcoAccount({ streamerSlug: 'hard-b', ouid: 'b', nickname: 'B', level: 1 });
  const detail = { matchId: 'hard', matchDate: '2026-10-01 01:00:00', matchType: 40, matchInfo: [player('a','A','승',2), player('b','B','패',1)] };
  await saveFcoMatch(detail);
  const id = 'fco:hard';
  const row = async () => (await sql`SELECT review_version, review_completed_at, reviewed_at, context_review_version, context_review_completed_at FROM match WHERE match_id = ${id}`)[0];
  await C.applyFcoMatchContext({ provider_match_id: id, conclusion: 'casual', note: 'fixture' });
  await C.approveFcoContext(id, (await row()).context_review_version);
  await B.setFcoMatchCompleted(id, true, (await row()).review_version);
  const before = await row();
  await saveFcoMatch(detail);
  assert.deepEqual(await row(), before, 'identical refetch preserves both stamps and versions');
  await saveFcoMatch({ ...detail, matchInfo: [...detail.matchInfo].reverse() });
  assert.deepEqual(await row(), before, 'provider participant order is not a value change');
  await saveFcoMatch({ ...detail, matchInfo: [{ ...detail.matchInfo[0], division: 2000 }, detail.matchInfo[1]] });
  assert.deepEqual(await row(), before, 'raw squad/rank enrichment preserves review');
  await saveFcoMatch({ ...detail, matchInfo: [{ ...detail.matchInfo[0], shoot: { goalTotal: 3 } }, detail.matchInfo[1]] });
  assert.equal((await row()).review_completed_at, null);
  assert.deepEqual((await row()).context_review_completed_at, before.context_review_completed_at);
  assert.equal((await row()).context_review_version, before.context_review_version);
  await assert.rejects(B.setFcoMatchCompleted(id, true, before.review_version), /바뀌/);
  await B.setFcoMatchCompleted(id, true, (await row()).review_version);
  const completed = await row();
  await sql`UPDATE match SET visibility = 'hidden' WHERE match_id = ${id}`;
  assert.deepEqual(await row(), completed, 'publication is independent of both reviews');
  await C.holdFcoContext(id, completed.context_review_version);
  assert.deepEqual((await row()).review_completed_at, completed.review_completed_at);
  assert.equal((await row()).review_version, completed.review_version);
  await assert.rejects(C.approveFcoContext(id, completed.context_review_version), /변경/);
  // Automatic observation counters must not grow the human audit log.
  await people.upsertRiotAccount({ puuid: 'candidate-hard', game_name: '최신 이름', tag_line: 'NEW' });
  const [candidate] = await sql`INSERT INTO account_candidate(puuid, game_name, tag_line) VALUES ('candidate-hard', '옛 이름','OLD') RETURNING id`;
  for (let n = 0; n < 3; n++) await sql`UPDATE account_candidate SET seen_count = seen_count + 1, last_seen_at = now() WHERE id = ${candidate.id}`;
  assert.equal((await sql`SELECT count(*)::int n FROM admin_audit WHERE scope='candidate' AND scope_key=${candidate.id}`)[0].n, 0, 'automatic sightings are not admin changes');
  await people.setCandidateState(candidate.id, 'ignored', 'pending');
  assert.equal((await sql`SELECT count(*)::int n FROM admin_audit WHERE scope='candidate' AND scope_key=${candidate.id}`)[0].n, 1, 'human state changes are audited');
  const [owner] = await sql`SELECT id FROM streamer WHERE slug='hard-a'`;
  await people.linkAccount({ candidate_id: candidate.id, streamer_id: owner.id, puuid: 'candidate-hard', confidence: 'verified', evidence: { source: 'manual', note: 'checked' } });
  assert.equal((await sql`SELECT game_name FROM riot_account WHERE puuid='candidate-hard'`)[0].game_name, '최신 이름', 'candidate sighting never overwrites the latest account name');
  assert.equal((await people.linkAccount({ edit: true, streamer_id: owner.id, puuid: 'candidate-hard', confidence: 'verified', evidence: { source: 'manual', note: 'edited' } })).backfillQueued, false);
  // A merged screen with a retained event decision must not block the canonical event.
  const event = { slug: 'hard-cup', name: 'hard cup', kind: 'tournament' as const, source_url: 'https://example.test/cup' };
  await S.saveFcoScreenMatch({ vodTitleNo: 998877, atSec: 10, endedAt: '2026-09-01T01:00:00Z', sides: [{ nickname: 'A', score: 3, streamerSlug: 'hard-a', basis: 'manual' }, { nickname: 'B', score: 1, streamerSlug: 'hard-b', basis: 'manual' }] });
  const screen = 'fcs:998877@10';
  await C.applyFcoMatchContexts([id, screen].map(provider_match_id => ({ provider_match_id, conclusion: 'event', event })));
  const ev = (await C.listFcoEventOptions()).find(e => e.slug === event.slug)!;
  await sql`INSERT INTO fco_screen_link(screen_match_id,api_match_id,basis,decided_by) VALUES (${screen},${id},'{}'::jsonb,'admin')`;
  const snapshot = async () => Object.fromEntries((await C.getFcoReviewWorkspace({ eventId: ev.id }))[0].matches.filter(m => m.decision).map(m => [m.match_id,m.context_version]));
  assert.deepEqual(Object.keys(await snapshot()), [id]);
  await C.approveFcoEvent(ev.id, await snapshot());
  const approved = await row();
  assert.ok(approved.context_review_completed_at && approved.review_completed_at);
  await C.holdFcoEvent(ev.id, await snapshot());
  assert.deepEqual((await row()).review_completed_at, approved.review_completed_at);
  // Exercise the context triggers separately: none may clear a value completion.
  await sql`INSERT INTO match_series(id, game_code, event_id) VALUES ('hard-series', 'fconline', ${ev.id})`;
  const contextChanges: [string, () => Promise<unknown>][] = [
    ['match context', () => sql`UPDATE match SET series_id='hard-series', series_game_no=1, event_id=NULL WHERE match_id=${id}`],
    ['series context', () => sql`UPDATE match_series SET round_label='결승' WHERE id='hard-series'`],
    ['event metadata', () => C.updateFcoEvent(ev.id, { name: '수정 대회' })],
    ['decision', () => sql`INSERT INTO fco_event_match_decision(event_id,match_id,decision,note,created_by) VALUES (${ev.id},${id},'include','재확인','admin')`],
    ['context record', () => sql`UPDATE fco_match_context SET note=note || ' 수정' WHERE match_id=${id}`],
  ];
  for (const [name, change] of contextChanges) {
    await C.approveFcoEvent(ev.id, await snapshot());
    const saved = await row();
    await change();
    const changed = await row();
    assert.equal(changed.context_review_completed_at, null, name + ' invalidates context');
    assert.ok(changed.context_review_version > saved.context_review_version, name + ' advances context version');
    assert.equal(changed.review_version, saved.review_version, name + ' preserves value version');
    assert.deepEqual(changed.review_completed_at, saved.review_completed_at, name + ' preserves value completion');
    await assert.rejects(C.holdFcoEvent(ev.id, { [id]: saved.context_review_version }), /변경/);
  }
  await C.approveFcoEvent(ev.id, await snapshot());
  const last = await row();
  await sql`UPDATE match SET game_duration=1800 WHERE match_id=${id}`;
  assert.equal((await row()).review_completed_at, null, 'match metadata invalidates values');
  assert.deepEqual((await row()).context_review_completed_at, last.context_review_completed_at, 'match metadata preserves context');
  console.log('Admin hardening passed: identical/reordered/enriched refetch, real changes, independent reviews, stale rejection, bounded candidate audit, merged event confirmation.');
} finally { await closeDb(); await pg.stop(); }
