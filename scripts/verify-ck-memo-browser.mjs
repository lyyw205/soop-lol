/** Read-only smoke check against the selected memo pilot; all browser writes blocked.
 * node --env-file=apps/web/.env.local scripts/verify-ck-memo-browser.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    httpCredentials: { username: process.env.ADMIN_USER, password: process.env.ADMIN_PASSWORD },
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [], writes = [];
  await context.route('**/*', route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      writes.push(route.request().method()); return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const base = process.env.CK_MEMO_TEST_BASE ?? 'http://localhost:3000';
  // 메모장 후보는 VOD 화면의 찾기 기능이다(대회 검수 주소는 2026-10-11부터 목록으로 간다). vod:206156659 = 바밤바·오뀨 CK 시험 VOD.
  const response = await page.goto(`${base}/admin/ck/09ca079b-093b-4240-a2a1-0c91ecd0f5a0`);
  assert.equal(response.status(), 200);
  const list = page.getByRole('region', { name: '검수 큐', exact: true });
  await list.locator('button[data-kind="memo"]').first().waitFor();
  const count = await list.locator('button[data-kind="memo"]').count();
  assert.ok(count > 0);
  const times = await list.locator('.ck-review-queue-item time').allTextContents();
  const seconds = times.map(t => t === '시각 미상' ? Number.MAX_SAFE_INTEGER : t.split('–')[0].split(':').reduce((n, part) => n * 60 + Number(part), 0));
  assert.deepEqual(seconds, [...seconds].sort((a, b) => a - b));
  assert.equal(await page.locator('.ck-memo-references').count(), 0);
  await list.getByRole('button', { name: '경기', exact: true }).click();
  assert.equal(await list.locator('button[data-kind="memo"]').count(), 0);
  await list.getByRole('button', { name: '전체', exact: true }).click();
  assert.equal(await list.locator('button[data-kind="memo"]').count(), count);
  await list.locator('button[data-kind="memo"]').first().click();
  const followingId = await list.locator('button[data-kind="memo"]').first().evaluate(button => button.parentElement.nextElementSibling.id);
  await page.keyboard.press('ArrowDown');
  assert.equal(await list.locator('button[aria-current="true"]').evaluate(button => button.parentElement.id), followingId);
  await page.keyboard.press('ArrowUp');
  assert.equal(await list.locator('button[data-kind="memo"]').first().getAttribute('aria-current'), 'true');
  await list.locator('button[data-kind="match"]').first().click();
  const current = () => page.locator('.ck-review-frame-image').getAttribute('src');
  // ★ VOD 화면은 찾기 전용(2026-10-12) — 편집기가 없고, 고른 경기는 오른쪽 요약에 나온다.
  const summary = page.getByRole('complementary', { name: '선택한 항목' });
  const chosen = await summary.getByRole('heading').innerText();
  assert.equal(await page.getByRole('tab', { name: '로스터' }).count(), 0);
  const before = await current(); assert.ok(before);
  await list.locator('button[data-kind="memo"]').first().click();
  const controls = page.locator('.ck-memo-inline');
  await controls.waitFor();
  assert.equal(await summary.getByRole('heading').innerText(), chosen, 'memo preview does not change the chosen match');
  assert.equal(await page.locator('dialog').count(), 0);
  assert.notEqual(await current(), before);
  assert.equal(await page.locator('.ck-review-preview .ck-review-frame').count(), 1);
  await page.waitForFunction(() => {
    const image = document.querySelector('.ck-review-frame-image');
    return image?.complete && image.naturalWidth > 0;
  });
  const memoImage = await current();
  const slider = controls.getByRole('slider');
  const initialIndex = Number(await slider.inputValue());
  await page.keyboard.press('ArrowRight');
  assert.equal(Number(await slider.inputValue()), initialIndex + 1);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await current(), memoImage);
  assert.equal(await page.locator('form[action] input[name="frame_id"]:visible').count(), 0);
  await mkdir('out/ck-memo-training', { recursive: true });
  await page.screenshot({ path: 'out/ck-memo-training/review-queue.png' });
  await controls.getByRole('button', { name: '경기 프레임으로 돌아가기' }).click();
  assert.equal(await current(), before);
  // Selecting a normal queue item must also leave memo mode.
  await list.locator('button[data-kind="memo"]').first().click();
  await page.locator('.ck-review-queue-item[data-kind="match"]').first().click();
  assert.equal(await page.locator('.ck-memo-inline').count(), 0);
  assert.equal(await current(), before);
  assert.equal(await summary.getByRole('heading').innerText(), chosen);
  await page.screenshot({ path: 'out/ck-memo-training/find-only-vod.png' });
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  const report = { queue_groups: count, representative_image_loaded: true,
    chronological_queue: true, filters_verified: true, vertical_navigation: true, inline_preview: true, arrow_navigation: true, match_selection_restored: true, find_only_vod_screen: true, browser_errors: errors, write_requests: writes };
  await writeFile('out/ck-memo-training/browser-report.json', JSON.stringify(report, null, 2));
  console.log(report);
} finally { await browser.close(); }
