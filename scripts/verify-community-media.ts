/** 영상 본문 작성·미리보기·저장 브라우저 검사. 폐기할 DB만 사용한다. */
import { chromium } from "playwright";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { applyAll } from "./lib/migrations.ts";
import { freePort } from "./lib/disposable-postgres.ts";
import { SESSION_COOKIE } from "../packages/core/lib/auth/session.ts";

const root = join(import.meta.dirname, "..");
const memory = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
const port = await freePort();
const server = new PGLiteSocketServer({ db: memory, host: "127.0.0.1", port });
await server.start();
process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
process.env.DATABASE_POOL_MAX = "1";
process.env.ADMIN_AUTH_MODE = "member";
const { closeDb } = await import("../packages/core/lib/db/client.ts");
const { loginWithIdentity, createSession, setNickname } = await import("../packages/core/lib/db/member.ts");
let app: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let appLog = "";
try {
  await applyAll((sql) => memory.exec(sql), root);
  async function member(subject: string, nickname: string) {
    const m = await loginWithIdentity("google", subject);
    assert.equal(m.kind, "ok");
    if (m.kind !== "ok") throw new Error("unexpected blocked fixture");
    const session = await createSession(m.memberId);
    await setNickname(session.token, nickname, { agreed: true });
    return { id: m.memberId, token: session.token };
  }
  const other = await member("media-author", "영상검증회원");
  // Release the single PGlite socket before the Next process connects.
  await closeDb();
  const appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    cwd: join(root, "apps/web"), env: { ...process.env, NEXT_DIST_DIR: ".next-media-check", NEXT_TELEMETRY_DISABLED: "1", BOT_GUARD: "off", SITE_ORIGIN: base },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Next startup timeout")), 120_000);
    const read = (data: Buffer) => {
      appLog += data.toString();
      if (/Ready in/.test(appLog)) { clearTimeout(timer); resolve(); }
    };
    app!.stdout!.on("data", read); app!.stderr!.on("data", read);
    app!.once("exit", () => { clearTimeout(timer); reject(new Error("Next exited before ready")); });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.addCookies([{ name: SESSION_COOKIE, value: other.token, url: base }]);
  // 외부 서비스의 가용성과 독립적으로 앱의 입력/저장/렌더링을 검증한다. 실재생은 별도로 확인.
  await context.route(/https:\/\/(?:www\.youtube-nocookie\.com|vod\.sooplive\.com)\//, route => route.fulfill({ contentType: "text/html", body: "<html><body>공식 플레이어 자리</body></html>" }));
  const page = await context.newPage();
  await page.goto(base + "/community?write=1");
  await page.locator('input[name="title"]').fill("영상 임베드 검증");
  const body = "설명입니다.\nhttps://vod.sooplive.co.kr/player/192114259?change_second=5\n중간 설명\nhttps://youtu.be/M7lc1UVf-VE?t=90\nhttps://www.youtube.com/shorts/M7lc1UVf-VE\nhttps://example.com/unsupported\n<script>alert(1)</script>";
  await page.locator('textarea[name="body"]').fill(body);
  assert.equal(await page.locator("iframe").count(), 0);
  await page.getByRole("button", { name: "본문 미리보기", exact: true }).click();
  assert.equal(await page.locator("#cm-body-preview iframe").count(), 3);
  const sources = await page.locator("#cm-body-preview iframe").evaluateAll(els => els.map(el => el.getAttribute("src")));
  await page.getByRole("button", { name: "미리보기 닫기" }).click();
  assert.equal(await page.locator("#cm-body-preview iframe").count(), 0);
  assert.equal(await page.locator('textarea[name="body"]').inputValue(), body);
  await page.getByRole("button", { name: "등록", exact: true }).click();
  await page.waitForURL(url => /^\/community\/\d+$/.test(url.pathname), { timeout: 60000 });
  assert.deepEqual(await page.locator(".cm-body iframe").evaluateAll(els => els.map(el => el.getAttribute("src"))), sources);
  assert.equal(await page.locator(".cm-body script").count(), 0);
  assert.ok((await page.locator(".cm-body").innerText()).includes("<script>alert(1)</script>"));
  assert.equal(await page.locator('.cm-body a[href="https://example.com/unsupported"]').count(), 1);
  const postUrl = page.url();
  await page.getByRole("link", { name: "수정", exact: true }).click();
  await page.waitForURL(url => url.searchParams.get("edit") === "1");
  await page.locator(".cm-compose").waitFor();
  assert.equal(await page.locator('textarea[name="body"]').inputValue(), body);
  await page.goto(postUrl);
  await page.getByLabel("댓글", { exact: true }).fill("https://youtu.be/M7lc1UVf-VE");
  await page.getByRole("button", { name: "댓글 달기", exact: true }).click();
  await page.locator('.cm-comment a[href="https://youtu.be/M7lc1UVf-VE"]').waitFor();
  assert.equal(await page.locator(".cm-comment iframe").count(), 0);
  await page.screenshot({ path: "/tmp/community-media-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: "/tmp/community-media-mobile.png", fullPage: true });
  await context.clearCookies();
  await page.reload();
  assert.equal(await page.locator(".cm-body iframe").count(), 3);
  console.log("PASS preview/save/edit parity, safe text and fallback, comments unchanged, mobile layout, anonymous viewing (provider frames stubbed)");

} finally {
  await browser?.close();
  if (app && app.exitCode === null) {
    const exited = new Promise<void>((resolve) => app!.once("exit", () => resolve()));
    app.kill("SIGTERM"); await exited;
  }
  await closeDb(); await server.stop(); await memory.close();
}
