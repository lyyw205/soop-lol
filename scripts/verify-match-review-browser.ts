/**
 * 경기 검수 화면 브라우저 시나리오(2026-10-11) — 임시 DB(PGlite) + 실제 Next + Chromium. 운영 DB 를 쓰지 않는다.
 *
 * 코덱스가 재현한 혼란을 그대로 시나리오로 둔다(docs/CK-MULTI-POV-PLAN.md §6):
 *   1. 같은 작업 범위면 어느 경기에서 들어와도 경기 ID 목록과 순서가 같다(목록과 같은 함수).
 *   2. 방송 필터는 보이는 사진만 바꾸고 편집 대상(경기)은 그대로다. 사진이 없는 방송은 "근거 없음".
 *   3. 연결 사진과 참고(미연결) 사진을 구별해 보여 준다. 어느 사진을 봐도 편집 대상은 그 경기다.
 *   4. 시점 기록 없이 사진만 연결된 방송도 근거로 나온다.
 *   5. 이전·다음(키보드 포함)·완료 후 이동이 같은 목록·같은 순서다.
 *   6. 예전 대회 검수 주소는 그 대회 목록으로 간다.
 *   7. VOD 화면의 "편집할 세트" 를 바꾸면 보는 사진도 그 세트로 간다(편집 대상과 사진이 어긋나지 않는다).
 */
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
import { listOverviewWorkList } from '../packages/core/lib/db/match-overview.ts';

const root = join(import.meta.dirname, '..'), pg = await disposablePglite();
process.env.DATABASE_URL = pg.url;
process.env.DATABASE_POOL_MAX = '1';
let app: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const dist = `.next-match-review-${process.pid}`;
const scratch = await mkdtemp(join(tmpdir(), 'soop-match-review-'));
const LEAD_A = '00000000-0000-4000-8000-0000000e0001', LEAD_B = '00000000-0000-4000-8000-0000000e0002';
try {
  await applyAll(sql => pg.database.exec(sql), root, { includeModules: true });
  const sql = db();
  const [event] = await sql`INSERT INTO event (slug, name, kind) VALUES ('mr-ck', '경기 화면 검증 CK', 'ck') RETURNING id`;
  // 시리즈 없는 경기 3개(다누리 9시 CK 처럼) — 목록은 각각 한 묶음으로 센다.
  const ids = ['mr:M1', 'mr:M2', 'mr:M3'];
  for (const [i, id] of ids.entries()) {
    await sql`INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, map_id, source, origin, game_creation, game_creation_precision, game_duration, winning_team, event_id)
      VALUES (${id}, 'lol', 0, '0', 'CLASSIC', 11, 'manual', 'vod_scan', ${new Date(Date.UTC(2030, 0, 1, 12 + i))}, 'datetime', 1800, 100, ${event.id})`;
    for (let p = 1; p <= 2; p++) await sql`INSERT INTO match_participant (match_id, participant_id, team_id, observed_name, champion_id, outcome)
      VALUES (${id}, ${p}, ${p === 1 ? 100 : 200}, ${`선수${p}`}, ${p}, ${p === 1 ? 'win' : 'loss'})`;
  }
  await sql`INSERT INTO event_lead (id, source, source_key, title, observed_at, raw, state, url) VALUES
    (${LEAD_A}, 'vod_title', 'vod:mr-a', '방송 A', now(), '{}'::jsonb, 'confirmed', 'https://example.test/a'),
    (${LEAD_B}, 'vod_title', 'vod:mr-b', '방송 B', now(), '{}'::jsonb, 'confirmed', 'https://example.test/b')`;
  // 방송 A: M1·M2 를 만들었다(시점 기록). M1 결과창 + 같은 구간 미연결 밴픽 사진, M2 결과창 + 구간 안 미연결 사진.
  // 방송 B: M1 은 시점 기록과 사진, M2 는 **시점 기록 없이 사진만** 연결(예전 경기).
  await sql`INSERT INTO match_pov (match_id, lead_id, role, source) VALUES
    ('mr:M1', ${LEAD_A}, 'created', 'own'), ('mr:M2', ${LEAD_A}, 'created', 'own'), ('mr:M1', ${LEAD_B}, 'added', 'own')`;
  await sql`INSERT INTO match_evidence_frame (lead_id, match_id, frame_path, at_sec, kind) VALUES
    (${LEAD_A}, NULL, 'out/ck/mr-a/ban.jpg', 1000, 'other'),
    (${LEAD_A}, 'mr:M1', 'out/ck/mr-a/m1-result.jpg', 2500, 'result'),
    (${LEAD_A}, NULL, 'out/ck/mr-a/m2-game.jpg', 5000, 'other'),
    (${LEAD_A}, 'mr:M2', 'out/ck/mr-a/m2-result.jpg', 6000, 'result'),
    (${LEAD_B}, 'mr:M1', 'out/ck/mr-b/m1-result.jpg', 2400, 'result'),
    (${LEAD_B}, 'mr:M2', 'out/ck/mr-b/m2-result.jpg', 5900, 'result')`;
  const listQuery = 'queue=all&review=all&event=mr-ck';
  const expected = (await listOverviewWorkList({ collection: 'rift', event: 'mr-ck', unreviewed: false })).map((w) => w.match_id);
  assert.deepEqual([...expected].sort(), ids);
  console.log('match review DB fixture ready; work list', expected.join(' → '));

  await closeDb();
  const port = await freePort(), base = `http://127.0.0.1:${port}`;
  const logPath = join(scratch, 'next.log'), log = createWriteStream(logPath);
  app = spawn(process.execPath, [join(root, 'node_modules/next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: join(root, 'apps/web'), env: { ...process.env, NEXT_DIST_DIR: dist, ADMIN_USER: 'test', ADMIN_PASSWORD: 'disposable-only', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout!.pipe(log); app.stderr!.pipe(log);
  const deadline = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (app.exitCode !== null) throw new Error(await readFile(logPath, 'utf8'));
    try { ready = (await fetch(base + '/admin/ck?' + listQuery, { headers: { authorization: 'Basic ' + Buffer.from('test:disposable-only').toString('base64') }, signal: AbortSignal.timeout(30_000) })).ok; } catch { /* compiling */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.ok(ready, await readFile(logPath, 'utf8'));
  browser = await chromium.launch();
  const context = await browser.newContext({ httpCredentials: { username: 'test', password: 'disposable-only' }, viewport: { width: 1440, height: 950 } });
  const page = await context.newPage(), errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.setDefaultTimeout(60_000);
  await page.route('**/admin/ck/frame/**', r => r.fulfill({ status: 200, contentType: 'image/svg+xml',
    body: `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#123"/><text x="100" y="100" fill="white">${r.request().url().split('/').pop()}</text></svg>` }));

  const editing = () => page.locator('form:has(.ck-review-match-summary) input[name=match_id]').inputValue();
  const currentId = () => decodeURIComponent(new URL(page.url()).pathname.split('/').pop()!);
  const vodRow = (name: string) => page.getByRole('region', { name: '작업 목록과 방송별 근거' }).locator('button.ck-review-queue-item', { hasText: name });
  const strip = page.locator('.ck-review-frame-strip > button');

  // 6. 예전 대회 검수 주소는 그 대회 목록으로 간다.
  await page.goto(base + '/admin/ck/event/mr-ck');
  await page.waitForURL(/\/admin\/ck\?/);
  assert.equal(new URL(page.url()).searchParams.get('event'), 'mr-ck');

  // 1·5. 같은 범위 → 같은 목록·같은 순서. 어느 경기로 들어와도 n/N 과 다음 순서가 목록 함수와 같다.
  const from = `/admin/ck?${listQuery}`;
  for (const entry of [expected[0], expected[2]]) {
    await page.goto(`${base}/admin/ck/match/${encodeURIComponent(entry)}?from=${encodeURIComponent(from)}`);
    await page.getByText(`${expected.indexOf(entry) + 1} / ${expected.length}`, { exact: true }).waitFor();
  }
  await page.goto(`${base}/admin/ck/match/${encodeURIComponent(expected[0])}?from=${encodeURIComponent(from)}`);
  const visited = [currentId()];
  for (let i = 1; i < expected.length; i++) {
    await page.getByRole('button', { name: '다음 ↓', exact: true }).click();
    await page.waitForURL((url) => decodeURIComponent(url.pathname).endsWith(expected[i]));
    visited.push(currentId());
  }
  assert.deepEqual(visited, expected, '다음 버튼이 목록 순서를 따른다');
  assert.equal(await page.getByRole('button', { name: '다음 ↓', exact: true }).isDisabled(), true);
  await page.keyboard.press('ArrowUp');
  await page.waitForURL((url) => decodeURIComponent(url.pathname).endsWith(expected[expected.length - 2]));
  assert.equal(new URL(page.url()).searchParams.get('from'), from, '앞뒤로 넘어가도 돌아갈 목록을 들고 간다');

  // 2·3·4. M1: 방송 두 개, 연결 사진과 참고 사진, 필터는 사진만 바꾼다.
  await page.goto(`${base}/admin/ck/match/${encodeURIComponent('mr:M1')}?from=${encodeURIComponent(from)}`);
  await vodRow('전체').waitFor();
  assert.equal(await editing(), 'mr:M1');
  assert.match(await vodRow('전체').innerText(), /연결 2 · 참고 1/);
  assert.equal(await strip.count(), 3);
  assert.equal(await page.locator('.ck-review-frame-strip > button[data-reference]').count(), 1, '참고 사진은 구별 표시');
  for (let i = 0; i < 3; i++) {
    await strip.nth(i).click();
    assert.equal(await editing(), 'mr:M1', '어느 사진을 봐도 편집 대상은 이 경기');
    const badge = await page.locator('.ck-review-preview > header').innerText();
    assert.match(badge, (await strip.nth(i).getAttribute('data-reference')) ? /참고 · 미연결/ : /이 경기 근거/);
  }
  await vodRow('방송 B').click();
  assert.equal(await editing(), 'mr:M1', '방송 필터는 편집 대상을 바꾸지 않는다');
  assert.equal(await strip.count(), 0, '사진이 한 장이면 줄은 없다');
  assert.match(await page.locator('.ck-review-frame-image').getAttribute('src') ?? '', /mr-b/);
  await page.getByText('방송 B 이(가) 읽은 값').waitFor();

  // 4. M2: 방송 B 는 시점 기록 없이 사진만 연결 — 근거로 나오고 "판독 없음".
  await page.goto(`${base}/admin/ck/match/${encodeURIComponent('mr:M2')}?from=${encodeURIComponent(from)}`);
  await vodRow('방송 B').waitFor();
  assert.match(await vodRow('방송 B').innerText(), /연결 1 · 참고 0 · 판독 없음/);
  // 참고 사진을 이 경기 근거로 연결하면 표시가 바뀐다(DB 연결도 바뀐다).
  await vodRow('방송 A').click();
  await page.locator('.ck-review-frame-strip > button[data-reference]').click();
  await page.getByRole('button', { name: '이 경기 근거로 연결', exact: true }).click();
  await page.getByRole('button', { name: '이 경기 근거에서 빼기', exact: true }).waitFor();
  assert.equal(await page.locator('.ck-review-frame-strip > button[data-reference]').count(), 0);

  // M3: 근거가 없는 경기도 열리고 고칠 수 있다.
  await page.goto(`${base}/admin/ck/match/${encodeURIComponent('mr:M3')}?from=${encodeURIComponent(from)}`);
  await page.getByText('이 경기에 근거가 붙은 방송이 없습니다.').waitFor();
  assert.equal(await editing(), 'mr:M3');

  // 5. 완료 후 이동 = 같은 목록에서 다음 미완료.
  await page.goto(`${base}/admin/ck/match/${encodeURIComponent(expected[0])}?from=${encodeURIComponent(from)}`);
  await page.getByRole('button', { name: '검수 완료로 표시' }).click();
  await page.waitForURL((url) => decodeURIComponent(url.pathname).endsWith(expected[1]));

  // 7. VOD 화면: "편집할 세트" 를 바꾸면 보는 사진도 그 세트로 간다.
  await page.goto(`${base}/admin/ck/${LEAD_A}`);
  const editSet = page.getByRole('combobox', { name: '편집할 세트' });
  await editSet.waitFor();
  await editSet.selectOption('mr:M2');
  assert.equal(await page.locator('select[name=match_id]').inputValue(), 'mr:M2', '보는 사진의 경기 = 편집 대상');
  await editSet.selectOption('mr:M1');
  assert.equal(await page.locator('select[name=match_id]').inputValue(), 'mr:M1');

  assert.deepEqual(errors, []);
  console.log('match review browser scenarios passed: same work list/order, VOD filter keeps target, linked vs reference, frames without POV, prev/next/keyboard/completion, event permalink, VOD set selector moves photo');
} catch (error) {
  if (app) console.error((await readFile(join(scratch, 'next.log'), 'utf8')).slice(-6000));
  throw error;
} finally {
  await browser?.close();
  if (app && app.exitCode === null) { app.kill('SIGTERM'); await once(app, 'exit'); }
  await closeDb(); await pg.stop();
  await rm(join(root, 'apps/web', dist), { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}
