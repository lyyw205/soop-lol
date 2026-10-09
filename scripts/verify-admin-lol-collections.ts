/** Collection boundaries, plus real Next navigation with --browser. Always uses a disposable DB. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { disposablePglite } from './lib/disposable-pglite.ts';
import { freePort } from './lib/disposable-postgres.ts';
import { applyAll } from './lib/migrations.ts';
import { db, closeDb } from '../packages/core/lib/db/client.ts';
import { countOverviewSeries, listOverviewSeries, getOverviewSeriesSets } from '../packages/core/lib/db/match-overview.ts';
import { countUnidentifiedNames, listUnidentifiedParticipants, listEventLeads, upsertEventLead } from '../packages/core/lib/db/ck.ts';
import { listEventPovLeads } from '../packages/core/lib/db/ck-pov.ts';
import { lolReviewQueueIds } from '../packages/core/lib/db/review-priority.ts';

const root = join(import.meta.dirname, '..'), pg = await disposablePglite();
process.env.DATABASE_URL = pg.url;
process.env.DATABASE_POOL_MAX = '1';
let app: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const dist = `.next-lol-collections-${process.pid}`;
const scratch = await mkdtemp(join(tmpdir(), 'soop-lol-collections-'));
try {
  await applyAll(sql => pg.database.exec(sql), root, { includeModules: true });
  const sql = db();
  const [event] = await sql`INSERT INTO event (slug, name, kind) VALUES ('mixed-modes', '혼합 경기 검증', 'ck') RETURNING id`;
  await sql`INSERT INTO match_series (id, game_code, event_id) VALUES ('mixed-modes', 'lol', ${event.id})`;
  const cases = [
    ['rift', 'CLASSIC', 'manual', 0], ['aram', 'ARAM', 'manual', 0],
    ['legacy', 'CUSTOM', 'manual', 0], ['unknown', null, 'manual', 0],
    ['urf', 'URF', 'manual', 0], ['mayhem', 'KIWI', 'public_queue', 2400],
  ] as const;
  const lead = await upsertEventLead({ source: 'vod_title', source_key: 'vod:collection-test',
    channel_id: 'collection-test', url: 'https://example.test/mixed', title: '혼합 방송', observed_at: new Date() });
  for (const [index, [id, mode, source, queue]] of cases.entries()) {
    await sql`INSERT INTO match (match_id, riot_game_id, platform_id, game_code, queue_id, mode_key, game_mode, source, origin, game_creation, series_id, series_game_no, source_url)
      VALUES (${id}, ${index + 1}, 'KR', 'lol', ${queue}, ${String(queue)}, ${mode}, ${source}, 'admin', '2026-10-09T01:00:00Z', 'mixed-modes', ${index + 1}, 'https://example.test/mixed')`;
    await sql`INSERT INTO match_participant (match_id, participant_id, team_id, observed_name, champion_id, outcome)
      VALUES (${id}, 1, 100, '공통이름', 103, 'unknown')`;
  }
  for (const collection of ['rift', 'aram'] as const) {
    const ids = collection === 'rift' ? ['legacy', 'rift', 'unknown'] : ['aram'];
    const opts = { collection, unreviewed: true, queue: 'priority' as const };
    assert.equal(await countOverviewSeries(opts), 1);
    assert.equal(await countOverviewSeries({ ...opts, q: collection === 'rift' ? 'aram' : 'rift' }), 0, 'search cannot match another collection in the same series');
    assert.equal(await countOverviewSeries({ ...opts, queue: 'general' }), 0);
    const series = await listOverviewSeries({ ...opts, limit: 1 });
    assert.deepEqual(series[0].sets.map(s => s.match_id).sort(), ids);
    assert.deepEqual((await getOverviewSeriesSets('mixed-modes', collection)).map(s => s.match_id).sort(), ids, 'expanding a mixed series stays scoped');
    assert.equal((await listOverviewSeries({ ...opts, limit: 1, offset: 1 })).length, 0);
    assert.equal(await countUnidentifiedNames('', collection), 1);
    const people = await listUnidentifiedParticipants(50, 0, '공통', collection);
    assert.deepEqual(people[0].targets.map(t => t.match_id).sort(), collection === 'aram' ? ['aram', 'mayhem'] : ids, 'same name selects only seats in this collection, including Mayhem');
    const leads = await listEventLeads({ collection, channel_id: 'collection-test', with_matches: true });
    assert.equal(leads[0].id, lead);
    assert.equal(leads[0].match_count, collection === 'aram' ? 2 : 3);
    assert.equal((await listEventPovLeads(event.id, collection))[0].match_count, collection === 'aram' ? 2 : 3);
    const queueIds = await lolReviewQueueIds(cases.map(c => c[0]), '/admin/aram?queue=all', collection);
    assert.deepEqual(queueIds.sort(), collection === 'aram' ? ['aram', 'mayhem'] : ids);
  }
  await sql`UPDATE match SET review_completed_at = now() WHERE match_id = 'aram'`;
  assert.equal(await countOverviewSeries({ collection: 'aram', unreviewed: true }), 0);
  assert.equal(await countOverviewSeries({ collection: 'rift', unreviewed: true }), 1, 'ARAM completion does not complete the Rift portion');
  assert.deepEqual(await lolReviewQueueIds(['aram', 'rift'], '/admin/aram?queue=priority', 'aram'), []);
  await sql`UPDATE match SET review_completed_at = NULL WHERE match_id = 'aram'`;
  console.log('LoL collection DB checks passed: mixed series, counts, search, pagination, participants, channels, POVs, queues, completion.');
  if (process.argv.includes('--browser')) {
    // Release the only PGlite connection before the Next process connects.
    await closeDb();
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    const logPath = join(scratch, 'next.log'), log = createWriteStream(logPath);
    app = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
      cwd: join(root, 'apps/web'), env: { ...process.env, NEXT_DIST_DIR: dist, ADMIN_USER: 'test', ADMIN_PASSWORD: 'disposable-only', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    app.stdout!.pipe(log); app.stderr!.pipe(log);
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (app.exitCode !== null) throw new Error(await readFile(logPath, 'utf8'));
      try { ready = (await fetch(base + '/admin/aram', { headers: { authorization: 'Basic ' + Buffer.from('test:disposable-only').toString('base64') }, signal: AbortSignal.timeout(15_000) })).ok; } catch { /* compiling */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    assert.ok(ready, await readFile(logPath, 'utf8'));
    browser = await chromium.launch();
    const context = await browser.newContext({ httpCredentials: { username: 'test', password: 'disposable-only' }, viewport: { width: 1366, height: 900 } });
    const page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.setDefaultTimeout(20_000);
    for (const [path, label, count] of [['/admin/ck', '협곡', 3], ['/admin/aram', '칼바람', 1]] as const) {
      await page.goto(base + path + '?queue=all&q=혼합');
      await page.getByRole('heading', { name: `${label} 경기 검수`, exact: true }).waitFor();
      assert.equal(await page.locator('.admin-navigation [aria-current=page]').innerText(), `${label} 경기`);
      await page.locator('.overview-series-head').click();
      assert.equal(await page.getByRole('checkbox', { name: /확인한 경기 선택/ }).count(), count);
      await page.getByRole('link', { name: '같은 목록을 시리즈로 비교', exact: true }).click();
      await page.getByRole('heading', { name: `${label} 시리즈 비교`, exact: true }).waitFor();
      await page.locator('.overview-series-head').click();
      await page.locator('.overview-sets').getByRole('checkbox').first().waitFor();
      assert.equal(await page.getByRole('checkbox', { name: /확인한 경기 선택/ }).count(), count, 'server action preserves collection');
      await page.locator('.overview-start').click();
      await page.locator('.ck-review-queue-item[data-kind=match]').first().waitFor();
      assert.equal(await page.locator('.ck-review-queue-item[data-kind=match]').count(), label === '칼바람' ? 2 : 3);
      assert.equal(await page.locator('.admin-navigation [aria-current=page]').innerText(), `${label} 경기`, 'detail retains active section');
      await page.getByRole('link', { name: '← 검수 목록', exact: true }).click();
      await page.getByRole('heading', { name: `${label} 시리즈 비교`, exact: true }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('q'), '혼합');
    }
    await page.goto(base + '/admin/aram/unknown?q=공통');
    await page.getByText('공통이름', { exact: true }).click();
    await page.getByText(/열어서 연결/).waitFor();
    await page.locator('form details summary').first().click();
    await page.getByRole('link', { name: '경기 근거 보기 ↗', exact: true }).first().click();
    await page.getByRole('link', { name: '← 검수 목록', exact: true }).click();
    await page.getByRole('heading', { name: '칼바람 미확인 참가자', exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('q'), '공통');
    await page.goto(base + '/admin');
    for (const label of ['협곡 우선 검수', '칼바람 우선 검수', '협곡 참가자 연결', '칼바람 참가자 연결']) await page.getByRole('link', { name: new RegExp(label) }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    for (const path of ['/admin/aram', '/admin/aram/overview', '/admin/aram/unknown']) {
      await page.goto(base + path);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${path}: mobile overflow`);
    }
    await page.screenshot({ path: join(scratch, 'aram-mobile.png') });
    assert.deepEqual(errors, []);
    console.log(`LoL collection browser checks passed; screenshot: ${join(scratch, 'aram-mobile.png')}`);
  }
} catch (error) {
  if (app) console.error((await readFile(join(scratch, 'next.log'), 'utf8')).slice(-6000));
  throw error;
} finally {
  await browser?.close();
  if (app && app.exitCode === null) { app.kill('SIGTERM'); await once(app, 'exit'); }
  await closeDb(); await pg.stop();
  await rm(join(root, 'apps/web', dist), { recursive: true, force: true });
}
