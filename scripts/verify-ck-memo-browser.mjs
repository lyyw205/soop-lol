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
  const response = await page.goto(`${base}/admin/ck/event/ck-2026-09-03-babamba-okkyu`);
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
  const before = await current(); assert.ok(before);
  const editSet = page.getByRole('combobox', { name: '편집할 세트' });
  const secondSet = await editSet.locator('option').nth(1).getAttribute('value');
  await editSet.selectOption(secondSet);
  assert.equal(await current(), before); // Editor changes do not move the reference image.
  const draft = page.locator('input[name="series_id"]').first();
  const originalDraft = await draft.inputValue();
  await page.getByRole('button', { name: originalDraft, exact: true }).click();
  await draft.fill(originalDraft + '-memo-preview-test');
  await list.locator('button[data-kind="memo"]').first().click();
  const controls = page.locator('.ck-memo-inline');
  await controls.waitFor();
  assert.equal(await draft.isVisible(), true);
  assert.equal(await editSet.inputValue(), secondSet);
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
  assert.equal(await draft.inputValue(), originalDraft + '-memo-preview-test');
  await draft.fill(originalDraft);
  // Selecting a normal queue item must also leave memo mode.
  await list.locator('button[data-kind="memo"]').first().click();
  await page.locator('.ck-review-queue-item[data-kind="match"]').first().click();
  assert.equal(await page.locator('.ck-memo-inline').count(), 0);
  assert.equal(await current(), before);
  assert.equal(await editSet.inputValue(), secondSet); // Selecting another set's photo does not retarget writes.
  await page.getByRole('tab', { name: '로스터', exact: true }).click();
  const row = page.locator('.ck-roster-row').first();
  await row.getByRole('button', { name: /참가자 .* 이름/ }).click();
  const nameInput = row.getByPlaceholder('화면에서 읽은 인게임명');
  const originalName = await nameInput.inputValue();
  await nameInput.fill(originalName + '-reference-test');
  await list.locator('button[data-kind="memo"]').first().click();
  assert.equal(await nameInput.isVisible(), true);
  assert.equal(await nameInput.inputValue(), originalName + '-reference-test');
  assert.equal(await editSet.inputValue(), secondSet);
  const positionButton = row.getByRole('button', { name: /참가자 .* 포지션/ });
  await positionButton.click();
  await row.locator('.ck-roster-position-choices button').nth(1).click();
  const draftedPosition = await positionButton.innerText();
  await page.locator('.ck-review-queue-item[data-kind="match"]').first().click();
  assert.equal(await positionButton.innerText(), draftedPosition);
  assert.equal(await editSet.inputValue(), secondSet);
  const form = row.locator('xpath=ancestor::form');
  assert.equal(await form.locator('input[name="match_id"]').inputValue(), secondSet);
  await row.getByRole('button', { name: /참가자 .* 이름/ }).click();
  assert.equal(await nameInput.inputValue(), originalName + '-reference-test');
  await list.locator('button[data-kind="memo"]').first().click();
  await page.screenshot({ path: 'out/ck-memo-training/independent-set-editor.png' });
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  const report = { queue_groups: count, representative_image_loaded: true,
    chronological_queue: true, filters_verified: true, vertical_navigation: true, inline_preview: true, arrow_navigation: true, match_selection_restored: true, unsaved_draft_preserved: true, independent_set_editor: true, roster_and_position_preserved: true, browser_errors: errors, write_requests: writes };
  await writeFile('out/ck-memo-training/browser-report.json', JSON.stringify(report, null, 2));
  console.log(report);
} finally { await browser.close(); }
