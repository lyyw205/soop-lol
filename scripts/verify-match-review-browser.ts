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
 *   8. 묶지 않은 경기는 "시리즈 미지정" 이고 시리즈로 세지 않는다. 근거를 적어 "단판으로 확인" 하면 단판이 된다.
 *  10. 시리즈 칸: 시리즈 미지정이면 같은 대회의 앞뒤 경기가 후보로 나오고, 묶으면 세트·스코어가 보인다.
 *   9. 편집은 경기 화면에서 — 경기 사이를 오가도 경기별 로스터 초안이 남고, 저장·승자 변경이 DB 와 이력에 남는다
 *      (Next 를 내린 뒤 같은 임시 DB 에 다시 붙어 확인한다). VOD 화면은 찾기 전용이라 편집기가 없다.
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
    for (let p = 1; p <= 2; p++) await sql`INSERT INTO match_participant (match_id, participant_id, team_id, observed_name, champion_id, outcome, kills, deaths, assists)
      VALUES (${id}, ${p}, ${p === 1 ? 100 : 200}, ${`선수${p}`}, ${p}, ${p === 1 ? 'win' : 'loss'}, ${i + p}, 1, 2)`;
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

  // 9. 편집은 경기 화면에서. 경기 사이를 오가도(다음·이전) 경기별 로스터 초안이 남는다.
  const roster = () => page.locator('form:has(input[name=roster])');
  const kda = async () => { await page.getByRole('tab', { name: '로스터', exact: true }).click();
    await page.locator('[data-participant-id="1"]').getByRole('button', { name: '참가자 1 KDA' }).click();
    return page.locator('[data-participant-id="1"] input[placeholder=K]'); };
  await page.goto(`${base}/admin/ck/match/${encodeURIComponent('mr:M1')}?from=${encodeURIComponent(from)}`);
  await (await kda()).fill('77');
  await page.getByRole('button', { name: '다음 ↓', exact: true }).click();
  await page.waitForURL((url) => decodeURIComponent(url.pathname).endsWith('mr:M2'));
  assert.equal(await (await kda()).inputValue(), '2', '다른 경기의 값이 보인다(초안이 새지 않는다)');
  await page.getByRole('button', { name: '↑ 이전', exact: true }).click();
  await page.waitForURL((url) => decodeURIComponent(url.pathname).endsWith('mr:M1'));
  assert.equal(await (await kda()).inputValue(), '77', '돌아오면 그 경기의 초안이 남아 있다');
  await roster().getByRole('button', { name: '변경사항 저장', exact: true }).click();
  await roster().locator('[role=status]', { hasText: '저장했습니다' }).waitFor();
  await page.getByRole('tab', { name: '경기', exact: true }).click();
  const meta = page.locator('form:has(.ck-review-match-summary)');
  await meta.getByRole('button', { name: '2팀', exact: true }).click();
  await meta.locator('[role=status]').waitFor();
  await page.getByRole('button', { name: '2팀', exact: true, pressed: true }).waitFor();

  // M3: 근거가 없는 경기도 열리고 고칠 수 있다.
  await page.goto(`${base}/admin/ck/match/${encodeURIComponent('mr:M3')}?from=${encodeURIComponent(from)}`);
  await page.getByText('이 경기에 근거가 붙은 방송이 없습니다.').waitFor();
  assert.equal(await editing(), 'mr:M3');

  // 8. 시리즈 미지정 ≠ 단판. 목록은 묶지 않은 경기를 시리즈로 세지 않는다.
  const eventMeta = async () => { await page.goto(`${base}${from}`); return (await page.locator('.overview-event-meta').first().innerText()).replace(/\s+/g, ' '); };
  assert.equal(await eventMeta(), '시리즈 0 · 시리즈 미지정 3경기 · 세트 3');
  assert.equal(await page.locator('.overview-series-round', { hasText: '단판' }).count(), 0, '묶지 않은 경기를 단판이라고 부르지 않는다');
  await page.goto(`${base}/admin/ck/match/${encodeURIComponent('mr:M3')}?from=${encodeURIComponent(from)}`);
  assert.match(await page.locator('.ck-review-page-head h1').innerText(), /시리즈 미지정/);
  await page.getByRole('button', { name: '단판으로 확인', exact: true }).click();
  const evidenceInput = page.getByRole('textbox', { name: '단판 근거', exact: true });
  await evidenceInput.fill('VOD 2:10:00 "단판 한 판만" 공지');
  await evidenceInput.press('Enter');
  await page.locator('form:has(.ck-review-match-summary) [role=status]').waitFor();
  // (Next 가 임시 DB 의 유일한 연결을 쓰므로 저장 결과는 화면으로 확인한다.)
  await page.locator('.ck-review-page-head h1', { hasText: '단판' }).waitFor();
  await page.getByRole('button', { name: 'Bo1 · VOD 2:10:00 "단판 한 판만" 공지', exact: true }).waitFor();
  // 같은 대회 묶음에 남는다 = 시리즈가 대회를 넘겨받았다(시리즈 경기는 match.event_id 를 비운다).
  assert.equal(await eventMeta(), '시리즈 1 · 시리즈 미지정 2경기 · 세트 3');
  assert.equal(await page.locator('.overview-series-round', { hasText: '단판' }).count(), 1);

  // 10. 시리즈 칸 — M1 은 시리즈 미지정, 같은 대회의 M2·M3 가 후보. M2 와 새 시리즈로 묶으면 세트·스코어가 보인다.
  await page.goto(`${base}/admin/ck/match/${encodeURIComponent('mr:M1')}?from=${encodeURIComponent(from)}`);
  const seriesPanel = page.getByRole('region', { name: '시리즈', exact: true });
  await seriesPanel.getByText('시리즈 미지정 — 단판인지 다전제의 한 판인지 아직 모릅니다.').waitFor();
  assert.equal(await seriesPanel.locator('.ck-series-sets > li').count(), 3, '같은 대회의 앞뒤 경기 + 시각 순서 자리의 지금 경기');
  assert.match(await seriesPanel.locator('.ck-series-sets > li').nth(0).innerText(), /지금 경기/, 'M1 이 가장 먼저 시작했다');
  const m2Row = seriesPanel.locator('.ck-series-sets > li', { has: page.locator('a[title="mr:M2"]') });
  assert.match(await m2Row.innerText(), /같은 선수 2\/2/);
  await m2Row.getByRole('button', { name: '이 경기와 새 시리즈로 묶기' }).click();
  await seriesPanel.getByText('스코어는 첫 세트 1팀 기준', { exact: false }).waitFor();
  const setRows = seriesPanel.locator('.ck-series-sets > li');
  assert.equal(await setRows.count(), 2);
  // M1 은 9번에서 2팀 승으로 바꿨다(0:1), M2 는 1팀 승 — 같은 선수가 1팀이라 1:1.
  assert.match(await setRows.nth(0).innerText(), /2팀 승[\s\S]*0:1/);
  assert.match(await setRows.nth(1).innerText(), /1팀 승[\s\S]*1:1/);
  assert.equal(await setRows.nth(0).getAttribute('aria-current'), 'true', '지금 경기 강조');
  const compare = await seriesPanel.getByRole('link', { name: '시리즈 비교로 보기 ↗' }).getAttribute('href');
  assert.equal(new URL(compare!, base).searchParams.get('q'), 'series:mr:M1');
  await setRows.nth(1).getByRole('link').click();
  await page.waitForURL((url) => decodeURIComponent(url.pathname).endsWith('mr:M2'));
  assert.equal(new URL(page.url()).searchParams.get('from'), from, '세트로 넘어가도 작업 목록을 들고 간다');
  await page.getByRole('region', { name: '시리즈', exact: true }).locator('.ck-series-sets > li[aria-current=true] a[title="mr:M2"]').waitFor();

  // 5. 완료 후 이동 = 같은 목록에서 다음 미완료.
  await page.goto(`${base}/admin/ck/match/${encodeURIComponent(expected[0])}?from=${encodeURIComponent(from)}`);
  await page.getByRole('button', { name: '검수 완료로 표시' }).click();
  await page.waitForURL((url) => decodeURIComponent(url.pathname).endsWith(expected[1]));

  // 7. VOD 화면은 찾기 전용 — 큐에서 경기를 고르면 사진과 요약이 그 경기로 가고, 편집은 경기 화면 링크로.
  await page.goto(`${base}/admin/ck/${LEAD_A}?from=${encodeURIComponent(from)}`);
  await page.locator('.ck-review-queue-item[data-kind=match]').first().waitFor();
  assert.equal(await page.getByRole('tab', { name: '로스터' }).count(), 0, 'VOD 화면에는 편집기가 없다');
  assert.equal(await page.getByRole('combobox', { name: '편집할 세트' }).count(), 0);
  for (const id of ['mr:M2', 'mr:M1']) {
    await page.locator(`[id="ck-review-queue-match:${id}"] button`).click();
    const summary = page.getByRole('complementary', { name: '선택한 항목' });
    await summary.getByRole('heading', { name: id, exact: true }).waitFor();
    assert.equal(await page.locator('select[name=match_id]').inputValue(), id, '보는 사진의 경기 = 고른 경기');
    const href = await summary.getByRole('link', { name: '경기 화면에서 검수 →' }).getAttribute('href');
    assert.equal(new URL(href!, base).searchParams.get('from'), from, '경기 화면으로 갈 때 작업 목록을 들고 간다');
  }

  assert.deepEqual(errors, []);
  await browser.close(); browser = undefined;
  app.kill('SIGTERM'); await once(app, 'exit'); app = undefined;

  // 9(이어서). Next 를 내리고 같은 임시 DB 에 다시 붙어 화면에서 한 저장을 확인한다.
  const after = db();
  const [m1] = await after`SELECT winning_team, review_completed_at IS NOT NULL AS done FROM match WHERE match_id = 'mr:M1'`;
  assert.equal(m1.winning_team, 200, '승자 변경 저장');
  assert.equal((await after`SELECT kills FROM match_participant WHERE match_id = 'mr:M1' AND participant_id = 1`)[0].kills, 77, '로스터 저장');
  assert.equal((await after`SELECT bool_and((outcome = 'win') = (team_id = 200)) AS ok FROM match_participant WHERE match_id = 'mr:M1'`)[0].ok, true, '승자를 바꾸면 참가자 승패도 맞춰진다');
  assert.ok((await after`SELECT 1 FROM review_change WHERE match_id = 'mr:M1' AND field = 'winning_team' AND after = '200'::jsonb`).length, '화면에서 고친 값은 수정 이력에 남는다');
  assert.equal((await after`SELECT match_id FROM match_evidence_frame WHERE frame_path = 'out/ck/mr-a/m2-game.jpg'`)[0].match_id, 'mr:M2', '참고 사진 연결 저장');
  const [single] = await after`SELECT m.series_id, m.series_game_no, s.best_of, s.event_id IS NOT NULL AS has_event FROM match m JOIN match_series s ON s.id = m.series_id WHERE m.match_id = 'mr:M3'`;
  assert.deepEqual({ ...single }, { series_id: 'mr:M3', series_game_no: 1, best_of: 1, has_event: true }, '단판 확인 저장 — 시리즈가 대회를 넘겨받는다');
  assert.deepEqual((await after`SELECT match_id, series_id, series_game_no FROM match WHERE match_id IN ('mr:M1', 'mr:M2') ORDER BY match_id`).map((r) => ({ ...r })),
    [{ match_id: 'mr:M1', series_id: 'series:mr:M1', series_game_no: 1 }, { match_id: 'mr:M2', series_id: 'series:mr:M1', series_game_no: 2 }], '시리즈 칸에서 묶은 결과');
  console.log('match review browser scenarios passed: same work list/order, VOD filter keeps target, linked vs reference, frames without POV, prev/next/keyboard/completion, event permalink, VOD screen find-only, unassigned vs confirmed single, series panel (candidates, pair, score, set navigation), edits persisted (roster draft per match, save, winner/outcome, history)');
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
