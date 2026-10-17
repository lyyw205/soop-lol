/** 비공개 문의 권한·DB 제약·실제 브라우저 접수/답변. 외부 DB는 사용하지 않는다. */
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
import { checkAdminAuth } from "../apps/web/lib/admin-auth.ts";
import { SESSION_COOKIE } from "../packages/core/lib/auth/session.ts";

const root = join(import.meta.dirname, "..");
const memory = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
const port = await freePort();
const server = new PGLiteSocketServer({ db: memory, host: "127.0.0.1", port });
await server.start();
process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${port}/postgres`;
process.env.DATABASE_POOL_MAX = "1";
process.env.ADMIN_AUTH_MODE = "member";
process.env.ADMIN_USER = "test";
process.env.ADMIN_PASSWORD = "disposable-only";
const basic = `Basic ${Buffer.from("test:disposable-only").toString("base64")}`;
const { db, closeDb } = await import("../packages/core/lib/db/client.ts");
const { loginWithIdentity, createSession, setNickname, deleteSession } = await import("../packages/core/lib/db/member.ts");
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
  const owner = await member("owner", "관리검증일");
  const other = await member("other", "관리검증이");
  process.env.SUPER_ADMIN_MEMBER_ID = owner.id;
  assert.equal((await checkAdminAuth(owner.token)).ok, true);
  const regular = await checkAdminAuth(other.token);
  assert.ok(!regular.ok && regular.status === 403);
  const anon = await checkAdminAuth(null, basic);
  assert.ok(!anon.ok && anon.status === 401); // valid Basic credentials cannot bypass member mode
  const forged = await checkAdminAuth("not-a-session");
  assert.ok(!forged.ok && forged.status === 401);
  const expired = await createSession(owner.id, new Date("2020-01-01"));
  assert.equal((await checkAdminAuth(expired.token)).ok, false);
  const loggedOut = await createSession(owner.id);
  await deleteSession(loggedOut.token);
  assert.equal((await checkAdminAuth(loggedOut.token)).ok, false);
  process.env.SUPER_ADMIN_MEMBER_ID = other.id;
  assert.equal((await checkAdminAuth(owner.token)).ok, false); // changed grant takes effect without a new session
  delete process.env.SUPER_ADMIN_MEMBER_ID;
  const unset = await checkAdminAuth(owner.token, basic);
  assert.ok(!unset.ok && unset.status === 503);
  process.env.SUPER_ADMIN_MEMBER_ID = owner.id;
  console.log("PASS owner/ordinary/anonymous/forged/expired/logged-out/revoked/unconfigured and Basic bypass");

  const support = await import("../packages/core/lib/db/support.ts");
  const payload = { kind: "inquiry", title: "비공개 문의 검증", body: "다른 회원에게 보이면 안 되는 본문" };
  await assert.rejects(() => support.createSupportTicket(null, payload), /로그인/);
  await assert.rejects(() => support.createSupportTicket(other.token, { ...payload, body: " " }), /내용/);
  const ticket = await support.createSupportTicket(other.token, payload);
  assert.equal((await support.listSupportTickets(owner.token)).length, 0);
  assert.equal(await support.getSupportTicket(owner.token, ticket), null);
  await assert.rejects(() => support.getSupportTicket(other.token, ticket, true), /관리자/);
  await assert.rejects(() => support.listSupportTickets(other.token, 1, true), /관리자/);
  await assert.rejects(() => support.replySupportTicket(other.token, ticket, "위조 답변"), /관리자/);
  assert.equal((await support.getSupportTicket(owner.token, ticket, true))?.body, payload.body);
  await support.replySupportTicket(owner.token, ticket, "관리자 응답");
  assert.equal((await support.getSupportTicket(other.token, ticket))?.reply, "관리자 응답");
  await assert.rejects(() => support.replySupportTicket(owner.token, ticket, "덮어쓰기"), /이미 답변/);
  const limited = await member("limit", "문의한도검증");
  for (let i = 0; i < 5; i++) await support.createSupportTicket(limited.token, payload);
  await assert.rejects(() => support.createSupportTicket(limited.token, payload), /5건/);
  const { withdrawMember } = await import("../packages/core/lib/db/member.ts");
  await withdrawMember(limited.token, { deleteContent: false });
  const [remaining] = await db()`SELECT count(*)::int AS n FROM support_ticket WHERE author_id=${limited.id}`;
  assert.equal(remaining.n, 0);
  const [rls] = await db()`SELECT relrowsecurity FROM pg_class WHERE relname='support_ticket'`;
  assert.equal(rls.relrowsecurity, true);
  console.log("PASS private ownership/admin checks, input validation, answer conflict, daily limit, withdrawal erasure, RLS");

  // Release the single PGlite socket before the Next process connects.
  await closeDb();
  const appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    cwd: join(root, "apps/web"), env: { ...process.env, NEXT_DIST_DIR: ".next-support-check", NEXT_TELEMETRY_DISABLED: "1", BOT_GUARD: "off", SITE_ORIGIN: base },
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
  const request = (path: string, token?: string, options: RequestInit = {}) => fetch(base + path, {
    ...options, redirect: "manual", headers: { ...(token ? { cookie: `${SESSION_COOKIE}=${token}` } : {}), ...options.headers }, signal: AbortSignal.timeout(120_000),
  });
  let r = await request("/admin/community", undefined, { headers: { accept: "text/html" } });
  assert.equal(r.status, 307); assert.match(r.headers.get("location")!, /\/login\?next=/);
  for (const path of ["/admin/community", "/admin/office/status", "/admin/ck/frame/test"]) {
    r = await request(path, other.token); assert.equal(r.status, 403, path);
    r = await request(path, undefined, { method: "POST", headers: { authorization: basic } }); assert.equal(r.status, 401, path);
  }
  r = await request("/admin/community", owner.token); assert.equal(r.status, 200); await r.text();
  r = await request("/me", owner.token); assert.equal(r.status, 200); assert.match(await r.text(), /최고 관리자/);
  r = await request("/me", other.token); assert.equal(r.status, 200); assert.doesNotMatch(await r.text(), /최고 관리자/);
  r = await request(`/support/${ticket}`, owner.token); assert.equal(r.status, 404);
  r = await request(`/support/${ticket}`); assert.equal(r.status, 307);
  r = await request(`/admin/support/${ticket}`, other.token); assert.equal(r.status, 403);
  browser = await chromium.launch({ headless: true });
  const userContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const adminContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await userContext.addCookies([{ name: SESSION_COOKIE, value: other.token, url: base }]);
  await adminContext.addCookies([{ name: SESSION_COOKIE, value: owner.token, url: base }]);
  const userPage = await userContext.newPage();
  await userPage.goto(base + "/support");
  await userPage.getByLabel("유형").selectOption("suggestion");
  await userPage.getByLabel("제목", { exact: true }).fill("화면 흐름 검증");
  await userPage.getByLabel("내용", { exact: true }).fill("<script>alert(1)</script> 개선 의견입니다.");
  await userPage.getByRole("button", { name: "비공개로 접수하기" }).click();
  await userPage.waitForURL(/\/support\/[0-9a-f-]+$/, { timeout: 60000 });
  await userPage.getByRole("heading", { name: "답변 대기" }).waitFor();
  const id = userPage.url().split("/").pop();
  const adminPage = await adminContext.newPage();
  await adminPage.goto(base + "/admin/support/" + id);
  await adminPage.getByLabel("답변", { exact: true }).fill("의견 확인했습니다. 감사합니다.");
  await adminPage.getByRole("button", { name: "답변 등록" }).click();
  await adminPage.getByRole("heading", { name: "운영자 답변" }).waitFor();
  await userPage.reload();
  await userPage.getByText("의견 확인했습니다. 감사합니다.", { exact: true }).waitFor();
  assert.ok(await userPage.getByText("<script>alert(1)</script> 개선 의견입니다.", { exact: true }).isVisible());
  await userPage.screenshot({ path: "/tmp/support-detail-desktop.png", fullPage: true });
  await userPage.setViewportSize({ width: 390, height: 844 });
  await userPage.goto(base + "/support");
  assert.equal(await userPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await userPage.screenshot({ path: "/tmp/support-mobile.png", fullPage: true });
  const anonPage = await browser.newPage();
  await anonPage.goto(base + "/support");
  assert.ok(await anonPage.getByRole("link", { name: "로그인하고 접수하기" }).isVisible());
  assert.equal(await anonPage.getByText("화면 흐름 검증", { exact: true }).count(), 0);
  console.log("PASS browser submission → private detail → admin answer → author confirmation, XSS text, mobile, anonymous prompt");

} finally {
  await browser?.close();
  if (app && app.exitCode === null) {
    const exited = new Promise<void>((resolve) => app!.once("exit", () => resolve()));
    app.kill("SIGTERM"); await exited;
  }
  await closeDb(); await server.stop(); await memory.close();
}
