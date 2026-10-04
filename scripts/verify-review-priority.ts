import assert from 'node:assert/strict';
import { join } from 'node:path';
import { disposablePglite } from './lib/disposable-pglite.ts';
import { applyAll } from './lib/migrations.ts';
const pg = await disposablePglite();
process.env.DATABASE_URL = pg.url; process.env.DATABASE_POOL_MAX = '1';
const { db, closeDb } = await import('../packages/core/lib/db/client.ts');
const ck = await import('../packages/core/lib/db/ck.ts');
const { createStreamer } = await import('../packages/core/lib/db/streamers.ts');
const { countOverviewSeries, listOverviewSeries } = await import('../packages/core/lib/db/match-overview.ts');
const { completeReviewBatch } = await import('../packages/core/lib/db/review-batch.ts');
const { listFcoReviewPriorities } = await import('../packages/core/lib/db/review-priority.ts');
const { saveFcoScreenMatch } = await import('../packages/core/lib/games/fconline/screen.ts');
try {
  await applyAll(sql => pg.database.exec(sql), join(import.meta.dirname, '..'));
  const sql = db(), people = [];
  for (let i = 0; i < 10; i++) people.push(await createStreamer({ slug: 'priority-' + i, display_name: '우선 ' + i }));
  for (const n of [1, 2]) await ck.upsertMatchFromScan({ match_id: 'priority-lol:' + n, series_id: 'priority-series', series_game_no: n,
    played_at: new Date('2026-10-04T01:00:00Z'), played_at_precision: 'datetime', winning_team: 100, origin: 'admin', result_evidence: '검증 결과',
    participants: people.map((p, i) => ({ participant_id: i + 1, team_id: i < 5 ? 100 : 200, streamer_id: p.id,
      team_position: ['TOP','JUNGLE','MIDDLE','BOTTOM','UTILITY'][i % 5] as 'TOP', champion_id: 34, kills: 1, deaths: 1, assists: 1 })) });
  assert.equal(await countOverviewSeries({ queue: 'general' }), 1);
  assert.equal(await countOverviewSeries({ queue: 'priority' }), 0);
  await sql`UPDATE match_participant SET kills = NULL WHERE match_id = 'priority-lol:2' AND participant_id = 1`;
  assert.equal(await countOverviewSeries({ queue: 'priority' }), 1);
  assert.equal(await countOverviewSeries({ queue: 'general' }), 1, 'mixed series remains available in both queues');
  const sets = (await listOverviewSeries({ queue: 'priority' }))[0].sets;
  assert.equal(sets.length, 2, 'series context preserved');
  assert.deepEqual(sets[0].priority_reasons, []); assert.ok(sets[1].priority_reasons.includes('필수 값 누락'));
  const targets = sets.map(s => ({ id: s.match_id, version: s.review_version }));
  await assert.rejects(completeReviewBatch('lol', [{ ...targets[0] }, { ...targets[1], version: -1 }]), /선택/);
  await assert.rejects(completeReviewBatch('lol', [{ ...targets[0] }, { ...targets[1], version: targets[1].version + 1 }]), /모두 취소/);
  assert.equal((await sql`SELECT count(*)::int n FROM match WHERE review_completed_at IS NOT NULL`)[0].n, 0);
  assert.equal(await completeReviewBatch('lol', targets), 2);
  await assert.rejects(completeReviewBatch('lol', targets), /모두 취소/);
  await ck.setMatchReviewCompleted(targets[0].id, false, targets[0].version);
  assert.ok((await listOverviewSeries({ queue: 'priority' }))[0].sets[0].priority_reasons.includes('검수 후 변경·해제'));
  for (const sec of [10, 700]) await saveFcoScreenMatch({ vodTitleNo: 998811, atSec: sec, endedAt: new Date('2026-10-04T02:00:00Z').toISOString(),
    sides: [{ nickname: '우선 0', score: 2, streamerSlug: people[0].slug, basis: 'manual' }, { nickname: '우선 1', score: 1, streamerSlug: people[1].slug, basis: 'manual' }] });
  const fc = ['fcs:998811@10', 'fcs:998811@700'];
  assert.ok((await listFcoReviewPriorities()).get(fc[0])!.includes('화면 판독'));
  await sql`UPDATE match SET source = 'provider_api' WHERE match_id = ${fc[0]}`;
  assert.deepEqual((await listFcoReviewPriorities()).get(fc[0]), [], 'complete official values remain general and unreviewed');
  await sql`INSERT INTO fco_screen_link (screen_match_id, api_match_id, basis, decided_by) VALUES (${fc[1]}, ${fc[0]}, '{}'::jsonb, 'admin') ON CONFLICT (screen_match_id) DO NOTHING`;
  await sql`UPDATE fco_match_participant SET nickname = '이름 변경' WHERE match_id = ${fc[1]} AND side_no = 1`;
  assert.ok((await listFcoReviewPriorities()).get(fc[0])!.includes('시점 불일치'), 'same person with changed nickname stays in priority');
  await sql`UPDATE fco_match_participant SET nickname = '우선 0' WHERE match_id = ${fc[1]} AND side_no = 1`;
  assert.deepEqual((await listFcoReviewPriorities()).get(fc[0]), [], 'aligned equal evidence remains general');
  await sql`DELETE FROM fco_screen_link WHERE screen_match_id = ${fc[1]}`;
  const current = await sql`SELECT match_id, review_version, context_review_version FROM match WHERE match_id = ANY(${fc}) ORDER BY match_id`;
  const fcTargets = current.map(r => ({ id: r.match_id, version: r.review_version, contextVersion: r.context_review_version }));
  await assert.rejects(completeReviewBatch('fconline', fcTargets.map((r, i) => i ? { ...r, contextVersion: r.contextVersion + 1 } : r)), /모두 취소/);
  assert.equal((await sql`SELECT count(*)::int n FROM match WHERE game_code='fconline' AND review_completed_at IS NOT NULL`)[0].n, 0);
  assert.equal(await completeReviewBatch('fconline', fcTargets), 2);
  assert.equal((await sql`SELECT count(*)::int n FROM match WHERE game_code='fconline' AND context_review_completed_at IS NOT NULL`)[0].n, 0, 'value batch never confirms classification');
  console.log('Priority queues and atomic review batches passed: normal/priority/mixed series, stale rollback, duplicate handling, FC independence.');
} finally { await closeDb(); await pg.stop(); }
