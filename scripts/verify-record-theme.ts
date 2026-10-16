/** Read-only browser checks for public area palettes against a running app.
 * RECORD_VERIFY_URL=http://localhost:3000 node scripts/verify-record-theme.ts
 * Uses public local fixtures; never creates posts, schedules or cam rooms.
 */
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.RECORD_VERIFY_URL ?? "http://localhost:3000";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", error => errors.push(error.message));
// Old design-preview preferences must no longer override the area's palette.
await page.addInitScript(() => localStorage.setItem("soop-seek-lol-theme", "black-white"));
async function color(selector: string, property = "color") {
  return page.locator(selector).first().evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop).trim(), property);
}
async function checkArea(area: "lol" | "shared") {
  await page.locator(`header[data-site-theme="${area}"]`).waitFor();
  assert.equal(await color("body", "background-color"), "rgb(13, 14, 20)");
  assert.equal(await color("html", "--accent-primary"), area === "lol" ? "#c8aa6e" : "#acc8ed");
  assert.equal(await page.getByRole("group", { name: "롤 화면 테마 비교" }).count(), 0);
  assert.equal(await color("html", "--result-win"), "#5b9bd5");
  assert.equal(await color("html", "--result-loss"), "#e84057");
  for (const [result, rgb] of [["win", "91, 155, 213"], ["loss", "232, 64, 87"]]) {
    const cards = page.locator(`.opponent-history-row[data-result=${result}] .personal-match-detail`);
    if (await cards.count()) {
      assert.equal(await cards.first().evaluate(el => getComputedStyle(el).backgroundColor), `rgba(${rgb}, 0.08)`);
      assert.equal(await cards.first().evaluate(el => getComputedStyle(el).borderTopColor), `rgba(${rgb}, 0.2)`);
    }
  }

  for (const [selector, expected] of [
    [".opponent-history-record b:first-child, .sf-win, .sc-w", "rgb(91, 155, 213)"],
    [".opponent-history-record b:last-child, .sf-loss, .sc-l, .cm-deaths", "rgb(232, 64, 87)"],
    [".sf-line-win", "rgb(91, 155, 213)"],
    [".sf-line-loss", "rgb(232, 64, 87)"],
  ]) {
    for (const element of await page.locator(selector).all()) {
      assert.equal(await element.evaluate((el, prop) => getComputedStyle(el).getPropertyValue(prop), selector.startsWith(".sf-line") ? "stroke" : "color"), expected, selector);
    }
  }

}
try {
  const detailPaths = new Set<string>();
  for (const path of ["/lol", "/lol/s/kimmingyo", "/lol/s/kimmingyo?tab=opponents", "/lol/versus?a=kimmingyo&b=jeoradet", "/lol/streamers", "/lol/tournaments", "/lol/challenges"]) {
    const response = await page.goto(base + path, { waitUntil: "networkidle" });
    assert.equal(response?.status(), 200, path);
    await checkArea("lol");
    if (path === "/lol/tournaments" || path === "/lol/challenges") {
      const link = page.locator(`a[href^="${path}/"]`).first();
      if (await link.count()) detailPaths.add((await link.getAttribute("href"))!);
      const selector = path.endsWith("tournaments") ? ".tournament-page" : ".sc-page";
      assert.equal(await color(selector, path.endsWith("tournaments") ? "--tp-accent" : "--sc-hot"), "#c8aa6e");
    }
  }
  for (const path of detailPaths) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    await checkArea("lol");
  }
  for (const [path, selector, token] of [
    ["/schedule", ".sched", "--sched-accent"],
    ["/community", ".cm", "--cm-accent"],
    ["/cam", ".cam", "--cam-accent"],
  ]) {
    for (const query of ["", "?site=lol&game=lol", "?site=fconline&game=fconline"]) {
      await page.goto(base + path + query, { waitUntil: "networkidle" });
      await checkArea("shared");
      assert.equal(await color(selector, token), "#acc8ed");
      assert.equal(await color(selector), "rgb(232, 232, 234)");
    }
  }
  // Filled controls must keep their foreground legible, including nested labels/icons.
  await page.goto(`${base}/schedule`, { waitUntil: "networkidle" });
  for (const selector of [".sched-date-strip > a[aria-current]", ".sched-date-strip > a[aria-current] small", ".sched-date-strip > a[aria-current] b", ".sched-match-link svg"]) {
    assert.equal(await color(selector), "rgb(0, 0, 0)", selector);
  }
  await page.locator(".sched-date-strip > a[aria-current]").hover();
  assert.equal(await color(".sched-date-strip > a[aria-current]", "background-color"), "rgb(172, 200, 237)");
  await page.locator(".sched-calendar > button").click();
  assert.equal(await color(".sched-calendar-days button[data-selected=true]"), "rgb(0, 0, 0)");
  await page.keyboard.press("Escape");
  await page.locator(".sched-headline").click();
  await page.locator("dialog[open]").waitFor();
  assert.equal(await page.locator("dialog[open]").evaluate(el => getComputedStyle(el, "::backdrop").backgroundColor), "rgba(0, 0, 0, 0.72)");
  await page.keyboard.press("Escape");
  for (const path of detailPaths) {
    if (!path.startsWith("/lol/tournaments/")) continue;
    await page.goto(`${base}${path}?tab=bracket`, { waitUntil: "networkidle" });
    assert.equal(await color(".tp-edition"), "rgb(0, 0, 0)");
    await page.locator(".bk-slot").first().click();
    await page.locator("dialog[open]").waitFor();
    assert.equal(await page.locator("dialog[open]").evaluate(el => getComputedStyle(el, "::backdrop").backgroundColor), "rgba(0, 0, 0, 0.72)");
    await page.keyboard.press("Escape");
  }
  // Public module detail links must keep the same shared palette.
  for (const path of ["/schedule", "/community"]) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    const link = page.locator(`a[href^="${path}/"]`).first();
    if (await link.count()) {
      const href = await link.getAttribute("href");
      await page.goto(base + href, { waitUntil: "networkidle" });
      await checkArea("shared");
    }
  }
  // Client transitions: LoL -> shared module -> LoL -> FC. No stale palette.
  await page.goto(`${base}/lol`, { waitUntil: "networkidle" });
  await page.locator(".arena-nav").getByRole("link", { name: "커뮤니티", exact: true }).click();
  await checkArea("shared");
  await page.locator(".arena-nav").getByRole("link", { name: "전적 검색", exact: true }).click();
  await checkArea("lol");
  await page.locator(".game-switcher summary").click();
  await page.locator(".game-switcher-menu").getByRole("link", { name: "FC 온라인", exact: true }).click();
  await page.waitForURL("**/fc");
  await page.locator(".fc-header").waitFor();
  assert.equal(await page.locator("[data-site-theme]").count(), 0);
  assert.equal(await color("html", "--accent-primary"), "");
  for (const path of ["/fc/search", "/fc/s/kimmingyo", "/fc/versus?a=kimmingyo&b=doochiwa-ppukku"]) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    assert.equal(await page.locator("[data-site-theme]").count(), 0);
    assert.equal(await color("html", "--surface-base"), "");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/lol", "/lol/s/kimmingyo", "/lol/tournaments", "/lol/challenges", "/schedule", "/community", "/cam"]) {
    await page.goto(base + path, { waitUntil: "networkidle" });
    await checkArea(path.startsWith("/lol") ? "lol" : "shared");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${path}: mobile overflow`);
  }
  // Server-rendered theme also works without JS or localStorage hydration.
  const noJs = await browser.newContext({ javaScriptEnabled: false });
  const serverPage = await noJs.newPage();
  for (const path of ["/lol", "/community"]) {
    await serverPage.goto(base + path, { waitUntil: "load" });
    assert.equal(await serverPage.locator("body").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(13, 14, 20)");
  }
  await noJs.close();
  assert.deepEqual(errors, []);
  console.log("PASS: LoL gold, shared pale blue (all game contexts), detail routes, client navigation, FC isolation, mobile, no-JS rendering");
} finally {
  await browser.close();
}
