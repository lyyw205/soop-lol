import assert from 'node:assert/strict';
import type { BrowserContext, Locator } from 'playwright';
import { db } from '../../packages/core/lib/db/client.ts';
import { upsertRiotAccount } from '../../packages/core/lib/db/streamers.ts';
import { saveFcoScreenMatch } from '../../packages/core/lib/games/fconline/screen.ts';
import { buildMatchUnits } from '../../packages/core/lib/games/fconline/match-units.ts';
import { listFcoSessions } from '../../packages/core/lib/games/fconline/sessions.ts';
import { mkdir } from 'node:fs/promises';

export async function verifyAdminBrowser(context: BrowserContext, base: string, streamerId: string) {
  const sql = db(), p = await context.newPage(), errors: string[] = [];
  p.on('pageerror', e => { errors.push(e.message); console.error('Admin page error:',e.message); });
  p.on('console', m => { if (m.type() === 'error' && /hydration|same key|unique.*key/.test(m.text())) errors.push(m.text()); });
  p.on('dialog', d => d.accept());
  p.setDefaultTimeout(20_000);
  // Compile this route before navigating; Next dev can reload a pending navigation when a new route adds shared chunks.
  assert.ok((await context.request.get(base + '/admin/streamers/' + streamerId)).ok());
  const submit = async (form: Locator, name: string) => {
    const response = p.waitForResponse(r => r.request().method() === 'POST' && !!r.request().headers()['next-action']);
    await form.getByRole('button', { name, exact: true }).click();
    const r = await response; assert.ok(r.ok(), `server action ${name}`);
    if (name === '근거 저장') await form.locator('button[type=submit]:not([disabled])').first().waitFor();
  };
  await mkdir('/tmp/soop-admin-implemented', { recursive: true });
  await upsertRiotAccount({ puuid: 'browser-candidate', game_name: '최신브라우저후보', tag_line: 'KR1' });
  await sql`INSERT INTO account_candidate(puuid, game_name, tag_line, seen_with) VALUES ('browser-candidate','브라우저후보','KR1',ARRAY[${streamerId}::uuid])`;
  await p.setViewportSize({ width: 1366, height: 768 });
  await p.goto(base + '/admin/candidates?q=브라우저후보');
  await p.getByText('스트리머에 연결', { exact: true }).click();
  const link = p.locator('form:has(input[name=candidate_id])');
  await link.getByRole('combobox', { name: '연결할 스트리머' }).selectOption('ck-browser-a');
  await link.locator('[name=evidence_note]').fill('브라우저에서 근거 확인');
  await submit(link, '계정 연결');
  assert.equal((await sql`SELECT state FROM account_candidate WHERE puuid = 'browser-candidate'`)[0].state, 'approved');
  assert.equal((await sql`SELECT game_name FROM riot_account WHERE puuid = 'browser-candidate'`)[0].game_name, '최신브라우저후보');
  await p.getByRole('link', { name: /연결 완료/ }).click();
  await p.getByText('브라우저후보#KR1', { exact: true }).waitFor();
  await p.screenshot({ path: '/tmp/soop-admin-implemented/candidates.png' });

  for (const sec of [10, 700]) await saveFcoScreenMatch({ vodTitleNo: 990101, atSec: sec, endedAt: new Date(Date.now() - (30000 - sec) * 1000).toISOString(),
    sides: [{ nickname: '검사 A', score: 2, streamerSlug: 'ck-browser-a', basis: 'manual' }, { nickname: '검사 B', score: 1, streamerSlug: 'ck-browser-b', basis: 'manual' }],
    evidence: [{ observed: '검증 화면', frame_path: `out/ck/990101/g${sec}.jpg` }],
  });
  const ids = ['fcs:990101@10', 'fcs:990101@700'];
  const session = (await listFcoSessions()).find(s => s.match_ids.includes(ids[0]))!;
  await p.route('**/admin/**/frame/**', r => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><rect width="1920" height="1080" fill="#123"/><text x="100" y="100" fill="white">검증 프레임</text></svg>' }));
  await p.goto(base + '/admin/fco/session/' + encodeURIComponent(session.id) + '?from=' + encodeURIComponent('/admin/fco?view=all&vod=990101'));
  const queue = p.locator('.ck-review-queue-item');
  const values = () => p.locator('form:has(input[name=score1])');
  await p.getByRole('button', { name: '원본 크기', exact: true }).click();
  assert.ok(await p.locator('.ck-review-frame[data-zoom=true]').evaluate(e => e.scrollWidth > e.clientWidth), 'original-size evidence can be scrolled');
  await p.getByRole('button', { name: '맞추기', exact: true }).click();
  try { await values().locator('input[name=score1]').fill('8'); } catch (error) { console.error(await p.locator('body').innerText()); await p.screenshot({path:'/tmp/soop-admin-implemented/fc-failure.png'}); throw error; }
  await p.getByRole('tab', { name: '대전', exact: true }).click();
  await p.getByRole('tab', { name: '경기', exact: true }).click();
  assert.equal(await values().locator('input[name=score1]').inputValue(), '8');
  await queue.nth(1).click(); assert.equal(await values().locator('input[name=score1]').inputValue(), '2');
  await queue.nth(0).click(); assert.equal(await values().locator('input[name=score1]').inputValue(), '8');
  await submit(values(), '값만 저장');
  await values().getByRole('status').waitFor();
  assert.equal(await values().locator('input[name=score1]').inputValue(), '8', 'saved FC value stays visible');
  await values().locator('input[name=score1]').fill('9');
  await submit(values(), '값만 저장');
  await values().locator('button[type=submit]:not([disabled])').first().waitFor();
  assert.equal((await buildMatchUnits([ids[0]]))[0].sides[0].score, 9, 'second FC save uses the new version');
  await values().locator('input[name=score1]').fill('8');
  await submit(values(), '저장하고 검수 완료');
  await p.waitForFunction(() => (document.querySelector('input[name=score1]') as HTMLInputElement)?.value === '2');
  assert.equal(await values().locator('input[name=score1]').inputValue(), '2', 'completion advances to the next unreviewed match');
  await queue.nth(0).click();
  assert.ok((await buildMatchUnits([ids[0]]))[0].review_completed_at);
  await p.getByRole('button', { name: '단순 친선', exact: true }).click();
  const classification = p.locator('form:has(input[name=target][value=casual])');
  await classification.locator('textarea[name=note]').fill('검증한 친선');
  await submit(classification, '단순 친선 저장');
  await p.getByRole('button', { name: '분류 판단 확정', exact: true }).waitFor();
  const confirm = p.locator('form:has(button[value=approve])');
  await submit(confirm, '분류 판단 확정');
  let match = (await buildMatchUnits([ids[0]]))[0];
  assert.ok(match.context_completed_at && match.review_completed_at, 'both independent completions visible');
  await submit(p.locator('form:has(button[value=hold])'), '분류 확정 해제');
  match = (await buildMatchUnits([ids[0]]))[0]; assert.ok(match.review_completed_at); assert.equal(match.context_completed_at, null);
  await p.getByText('근거 직접 추가', { exact: true }).click();
  const evidence = p.locator('form:has(select[name=kind])');
  for (const kind of ['chat', 'audio', 'notice']) {
    await evidence.locator('select[name=kind]').selectOption(kind);
    await evidence.locator('[name=vod_title_no]').fill('990101'); await evidence.locator('[name=at_sec]').fill('123');
    await evidence.locator('[name=url]').fill('https://example.test/notice'); await evidence.locator('[name=observed]').fill(`검증 ${kind}`);
    await submit(evidence, '근거 저장');
    assert.equal((await sql`SELECT count(*)::int n FROM fco_context_evidence WHERE match_id = ${ids[0]} AND kind = ${kind}`)[0].n, 1, await evidence.innerText());
  }
  await p.getByText('내부 변경 이력', { exact: true }).click();
  await p.getByText('불러오는 중…', { exact: true }).waitFor({ state: 'hidden' });
  await p.screenshot({ path: '/tmp/soop-admin-implemented/fc-workbench.png' });
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow at 1366px');
  await p.getByRole('link', { name: '← FC 경기 목록', exact: true }).click();
  await p.waitForURL(/\/admin\/fco\?view=all&vod=990101/);
  assert.match(p.url(), /view=all&vod=990101/);
  await p.getByText(session.title, { exact: true }).waitFor();
  await p.screenshot({ path: '/tmp/soop-admin-implemented/fc-list.png' });
  await p.getByRole('link', { name: session.title, exact: true }).click();
  await p.getByRole('tab', { name: '대전', exact: true }).click();
  const sessionPanel = p.getByRole('tabpanel');
  await sessionPanel.getByRole('button', { name: '대회', exact: true }).click();
  await sessionPanel.getByRole('button', { name: '+ 새 행사 만들기', exact: true }).click();
  const newEvent = sessionPanel.locator('form:has(input[name=slug])');
  await newEvent.locator('[name=slug]').fill('browser-admin-event');
  await newEvent.locator('[name=name]').fill('브라우저 검수 대회');
  await newEvent.locator('[name=source_url]').fill('https://example.test/event');
  await submit(newEvent, '새 행사로 연결');
  await p.waitForURL(/\/admin\/fco\/event-/);
  assert.ok((await buildMatchUnits([ids[0]]))[0].review_completed_at, 'moving session into an event preserves value completion');
  await p.getByRole('tab', { name: '대회', exact: true }).click();
  await p.screenshot({ path: '/tmp/soop-admin-implemented/fc-event.png' });
  await p.getByRole('tab', { name: '경기', exact: true }).click();
  await p.getByRole('checkbox', { name: `${ids[1]} 확인한 경기 선택`, exact: true }).check();
  await values().locator('input[name=score1]').fill('7');
  await p.getByRole('button', { name: '초안 버리고 최신 값 보기', exact: true }).waitFor();
  assert.ok(await p.getByRole('button', { name: /선택한 .*경기 완료/ }).isDisabled(), 'unsaved edits remove the match from bulk selection');
  await p.getByRole('button', { name: '초안 버리고 최신 값 보기', exact: true }).click();
  await p.getByRole('checkbox', { name: `${ids[1]} 확인한 경기 선택`, exact: true }).check();
  const beforeContext = (await buildMatchUnits([ids[1]]))[0].context_completed_at;
  await p.getByRole('button', { name: '선택한 1경기 완료', exact: true }).click();
  await p.getByRole('status').filter({ hasText: '확인한 1경기를 완료' }).waitFor();
  const afterBulk = (await buildMatchUnits([ids[1]]))[0];
  assert.ok(afterBulk.review_completed_at, 'FC selected completion saves');
  assert.equal(afterBulk.context_completed_at, beforeContext, 'bulk completion preserves independent classification');
  await p.goto(base + '/admin/fco/session/meet~1000000000~99', { waitUntil: 'networkidle' });
  await p.getByRole('heading', { name: '대상을 찾을 수 없습니다.' }).waitFor();
  await p.goto(base + '/admin/schedule/not-a-uuid', { waitUntil: 'networkidle' });
  await p.getByRole('heading', { name: '대상을 찾을 수 없습니다.' }).waitFor();
  await p.goto(base + '/admin/schedule/new');
  await p.getByLabel('제목 *', { exact: true }).fill('브라우저 샘플 일정');
  await p.getByLabel('날짜', { exact: true }).fill('2026-10-04');
  await p.getByLabel('공지 주소', { exact: true }).fill('https://example.test/schedule');
  await p.getByLabel('반복 일수', { exact: true }).fill('2');
  await p.getByRole('button', { name: '일 추가', exact: true }).click();
  assert.equal(await p.getByLabel('날짜', { exact: true }).count(), 3);
  await submit(p.locator('form:has(input[name=payload])'), '일정 등록');
  await p.waitForURL(/\/admin\/schedule\/[0-9a-f-]+\?/);
  await p.getByRole('link', { name: '공지 열기 ↗', exact: true }).waitFor();
  await p.getByLabel('제목 *', { exact: true }).fill('브라우저 샘플 일정 수정');
  await p.getByLabel('오타 수정 — 공개 변경 이력에 남기지 않음', { exact: true }).check();
  await submit(p.locator('form:has(input[name=payload])'), '저장');
  const savedSchedule = JSON.parse(await p.locator('input[name=payload]').inputValue());
  assert.equal(savedSchedule.title, '브라우저 샘플 일정 수정', 'saved schedule stays visible');
  assert.equal(savedSchedule.version, (await sql`SELECT updated_at::text version FROM schedule_entry WHERE id=${savedSchedule.id}`)[0].version, 'schedule adopts the saved version immediately');
  await p.getByLabel('제목 *', { exact: true }).fill('브라우저 샘플 일정 재수정');
  await submit(p.locator('form:has(input[name=payload])'), '저장');
  assert.equal((await sql`SELECT title FROM schedule_entry WHERE id=${savedSchedule.id}`)[0].title, '브라우저 샘플 일정 재수정');

  await p.getByText('내부 변경 이력', { exact: true }).click();
  await p.getByText('불러오는 중…', { exact: true }).waitFor({ state: 'hidden' });
  await p.screenshot({ path: '/tmp/soop-admin-implemented/schedule.png' });
  await p.goto(base + '/admin/streamers?q=검사');
  await p.locator(`a[href^="/admin/streamers/${streamerId}"]`).click();
  await p.waitForURL(new RegExp(`/admin/streamers/${streamerId}`));
  try { await p.getByRole('heading', { name: '검사 A', exact: true }).waitFor(); }
  catch (error) { console.error('Streamer detail body:', await p.locator('body').innerText()); throw error; }
  await p.getByText('계정 정보·근거 수정', { exact: true }).click();
  const accountForm = p.locator('form:has(input[name=account_mode][value=edit])');
  await accountForm.locator('[name=label]').fill('연결 정보 수정');
  await submit(accountForm, '계정 정보 저장');
  await accountForm.getByText('계정 정보를 저장했습니다.', { exact: true }).waitFor();
  await p.getByRole('link', { name: /← 스트리머/ }).click();
  await p.waitForURL(/\/admin\/streamers\?q=/);
  assert.match(p.url(), /q=/);
  for (const width of [1366, 390]) {
    await p.setViewportSize({ width, height: 844 });
    for (const route of ['/admin', '/admin/ck?review=pending', '/admin/overview', '/admin/candidates', '/admin/ck/unknown', '/admin/schedule?overdue=1']) {
      const response = await p.goto(base + route); assert.ok(response?.ok(), route);
      assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route}: ${width}px overflow`);
      await p.screenshot({ path: `/tmp/soop-admin-implemented/${route.split('?')[0].replaceAll('/', '-')}-${width}.png` });
    }
  }
  assert.deepEqual(errors, []);
  await p.close();
  console.log('Admin browser passed: candidate connect, FC drafts/actions/independent states/3 evidence kinds, history, return filters, schedule, admin 404, desktop/mobile routes.');
}
