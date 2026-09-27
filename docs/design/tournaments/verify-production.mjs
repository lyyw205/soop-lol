/** Acceptance checks against the running app and its public database. */
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const base = process.env.TOURNAMENT_APP_URL || 'http://localhost:3000';
const out = new URL('./production/', import.meta.url);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
const go = async path => {
  const response = await page.goto(base + path, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200, path);
};
const capture = name => page.screenshot({ path: new URL(name + '.png', out).pathname, fullPage: true, animations: 'disabled' });
const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow ${page.url()}`);
const detail = '/tournaments/meljang-2026-geng';
try {
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await go('/tournaments');
    assert.equal(await page.locator('.tp-category-tabs a').count(), 3);
    assert.equal(await page.locator('.tp-hero-compact').count(), 1);
    assert.ok(await page.locator('.tp-catalog-list li').count() > 0);
    await noOverflow();
    if (width !== 360) await capture(`index-${width === 1440 ? 'desktop' : 'mobile'}`);
    await page.getByRole('link', { name: '멸망전', exact: true }).click();
    await page.waitForURL('**/tournaments?category=meljang');
    await page.locator('.tp-hero h2').filter({ hasText: 'Gen.G' }).waitFor();
    if (width !== 360) await capture(`meljang-${width === 1440 ? 'desktop' : 'mobile'}`);
    for (const tab of ['overview', 'bracket', 'teams', 'records', 'info']) {
      await go(`${detail}?tab=${tab}`);
      assert.equal(await page.locator('.tp-detail-tabs a').count(), 5);
      assert.doesNotMatch(await page.locator('.tp-detail-tabs').innerText(), /일정/);
      if (width === 1440) assert.ok((await page.locator('.tp-hero').boundingBox()).height < 300);
      if (tab === 'teams') assert.equal(await page.locator('.tp-roster-table tbody tr').count(), 8);
      if (tab === 'bracket') {
        assert.equal(await page.locator('.tp-match-card').count(), 14);
        assert.ok(await page.locator('.tp-connectors path').count() > 0);
        await page.getByLabel('라운드', { exact: true }).selectOption('결승');
        assert.match(await page.locator('.tp-bracket-filters').innerText(), /선택한 경기 1개/);
        await page.locator('.tp-match-card:not(.tp-match-muted)').click();
        await page.locator('dialog[open]').waitFor();
        assert.equal(await page.locator('.tp-set-tabs button').count(), 3);
        await page.locator('.tp-set-tabs button').nth(2).click();
        assert.match(await page.locator('.tp-dialog .tp-data-note').innerText(), /집계에서 제외/);
        await noOverflow();
        if (width !== 360) await capture(`set-${width === 1440 ? 'desktop' : 'mobile'}`);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('dialog[open]').count(), 0);
        await page.getByLabel('라운드', { exact: true }).selectOption('all');
        await page.getByLabel('팀', { exact: true }).selectOption({ label: '교권보호국' });
        assert.match(await page.locator('.tp-bracket-filters').innerText(), /선택한 경기 6개/);
        await page.getByRole('button', { name: '초기화', exact: true }).click();
      }
      await noOverflow();
      if (width !== 360) await capture(`${tab === 'overview' ? 'detail' : tab}-${width === 1440 ? 'desktop' : 'mobile'}`);
    }
    console.log(`PASS ${width}px: index, 5 tabs, roster, bracket, set dialog, no overflow.`);
  }
  await go('/tournaments?category=event');
  assert.doesNotMatch(await page.locator('main').innerText(), /니가가라 하와이/);
  await go('/tournaments');
  assert.doesNotMatch(await page.locator('main').innerText(), /니가가라 하와이/);
  assert.match(await page.locator('.tp-hero h2').innerText(), /Gen.G/);
  const excluded = await page.request.get(`${base}/tournaments/ck-2026-09-19-sangho-mansik`);
  assert.equal(excluded.status(), 404);
  await go('/tournaments?category=event');
  await page.locator('.tp-hero h2 a').click();
  await page.locator('.tp-detail-tabs').waitFor();
  await page.getByRole('link', { name: '대진표', exact: true }).click();
  await page.locator('.tp-match-card').first().click();
  await page.locator('dialog[open]').waitFor();
  await page.keyboard.press('Escape');
  await go('/tournaments');
  await page.getByLabel('대회, 팀, 스트리머 검색').fill('김민교');
  await page.getByRole('button', { name: '검색', exact: true }).click();
  await page.waitForURL(/q=/);
  assert.ok(await page.locator('.tp-hero').count() > 0);
  await page.getByLabel('대회 연도').selectOption('2026');
  await page.waitForURL(/year=2026/);
  assert.match(await page.locator('.tp-hero-date').innerText(), /2026/);
  await go('/tournaments?q=존재하지않는대회검증');
  assert.equal(await page.locator('.tp-hero').count(), 0);
  await page.getByRole('link', { name: '필터 초기화' }).click();
  await page.waitForURL('**/tournaments');
  await go(`${detail}?tab=matches`);
  assert.equal(await page.locator('.tp-match-card').count(), 14);
  assert.deepEqual(errors, []);
  fs.writeFileSync(new URL('verification.json', out), JSON.stringify({ checkedAt: new Date().toISOString(), widths: [1440, 390, 360], tabs: ['overview','bracket','teams','records','info'], browserErrors: errors, result: 'pass' }, null, 2) + '\n');
  console.log('PASS category/year/person search, empty/reset, event detail, legacy tab, no JS errors.');
} finally {
  await browser.close();
}
