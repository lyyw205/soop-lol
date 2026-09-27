/** Browser acceptance checks for the two independent design proposals. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const out = fileURLToPath(new URL(".", import.meta.url));
const base =
  process.env.TOURNAMENT_PREVIEW_URL ||
  "http://localhost:3000/design-lab/tournaments/index.html";
const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  reducedMotion: "reduce",
});
page.on("pageerror", (e) => errors.push(e.message));
const go = async (qs) => {
  await page.goto(`${base}?${qs}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".shell");
};
const capture = async (name) =>
  page.screenshot({
    path: `${out}${name}.png`,
    fullPage: true,
    animations: "disabled",
  });
const noOverflow = async () =>
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    `horizontal overflow: ${page.url()}`,
  );
const noBrokenImages = async () => {
  const broken = await page
    .locator("img")
    .evaluateAll((imgs) =>
      imgs.filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src),
    );
  assert.deepEqual(broken, []);
};
for (const variant of ["a", "b"]) {
  for (const width of [1440, 390, 360]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
    await go(`variant=${variant}`);
    assert.equal(await page.locator(".event-card").count(), 6);
    await noOverflow();
    await noBrokenImages();
    if (width !== 360)
      await capture(
        `${variant}-index-${width === 1440 ? "desktop" : "mobile"}`,
      );
    for (const tab of [
      "overview",
      "matches",
      "bracket",
      "teams",
      "records",
      "info",
    ]) {
      await go(`variant=${variant}&event=meljang-2026-geng&tab=${tab}`);
      await noOverflow();
      await noBrokenImages();
      if (tab === "teams")
        assert.equal(await page.locator(".roster-card").count(), 8);
      if (tab === "bracket")
        assert.equal(await page.locator(".bracket-match").count(), 14);
      if (tab === "matches")
        assert.equal(await page.locator(".match-row").count(), 14);
      if (
        width !== 360 &&
        (tab === "overview" ||
          (width === 1440 &&
            variant === "a" &&
            ["bracket", "teams", "records"].includes(tab)))
      )
        await capture(
          `${variant}-${tab === "overview" ? "detail" : tab}-${width === 1440 ? "desktop" : "mobile"}`,
        );
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await go(`variant=${variant}`);
  await page.locator('[data-category="event"]').click();
  assert.equal(await page.locator(".event-card").count(), 3);
  await page.locator("#search").fill("95즈");
  assert.equal(await page.locator(".event-card").count(), 1);
  await page.locator("#search").fill("없는대회검증");
  assert.equal(await page.locator(".event-card").count(), 0);
  await page.locator("#reset").click();
  assert.equal(await page.locator(".event-card").count(), 30);
  await page.locator("#year").selectOption("2026");
  assert.equal(await page.locator(".event-card").count(), 6);
  await page.locator("#status").selectOption("예정");
  assert.equal(await page.locator(".event-card").count(), 0);
  await page.locator("#status").selectOption("all");
  await page.locator("#search").fill("김민교");
  assert.ok((await page.locator(".event-card").count()) > 0);
  await go(`variant=${variant}&event=meljang-2026-geng&tab=matches`);
  await page.locator("#stage").selectOption("결승");
  assert.equal(await page.locator(".match-row").count(), 1);
  await page.locator(".match-row").click();
  assert.equal(await page.locator("#match-dialog[open]").count(), 1);
  assert.equal(await page.locator(".scoreboard tbody tr").count(), 10);
  assert.match(
    await page.locator(".set-summary").innerText(),
    /교권보호국 승리/,
  );
  await page.locator('[data-dialog-set="1"]').click();
  assert.match(await page.locator(".set-summary").innerText(), /고점폭발 승리/);
  await page.locator('[data-dialog-set="2"]').click();
  assert.equal(
    await page
      .locator(".scoreboard td")
      .filter({ hasText: /^미확인$/ })
      .count(),
    10,
  );
  await capture(`${variant}-set-detail-desktop`);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#match-dialog[open]").count(), 0);
  await page.locator("#stage").selectOption("all");
  await page.locator("#team").selectOption("교권보호국");
  assert.equal(await page.locator(".match-row").count(), 6);
  await page.locator(".variant-switch a:not(.selected)").click();
  assert.match(page.url(), /event=meljang-2026-geng/);
  assert.match(page.url(), /tab=matches/);
  await page.goBack();
  assert.match(
    await page.locator("body").getAttribute("data-variant"),
    new RegExp(variant),
  );
  console.log(
    `PASS variant ${variant}: 1440/390/360px, all 6 detail views, filters, dialog, source data, history.`,
  );
}
await go("variant=b&category=event");
await page.locator(".event-card").first().click();
assert.match(await page.locator("h1").innerText(), /95즈/);
await page.locator(".match-row").first().click();
assert.equal(await page.locator("#match-dialog[open]").count(), 1);
await page.keyboard.press("Escape");
assert.deepEqual(errors, []);
console.log(
  "PASS: no browser JavaScript errors; event-match navigation works.",
);
fs.writeFileSync(
  `${out}verification.json`,
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      viewports: [1440, 390, 360],
      variants: ["a", "b"],
      tabs: ["overview", "matches", "bracket", "teams", "records", "info"],
      browserErrors: errors,
      result: "pass",
    },
    null,
    2,
  ) + "\n",
);
await browser.close();
