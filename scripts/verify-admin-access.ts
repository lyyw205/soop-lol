/** 최고 관리자 권한 검사 + 실제 HTTP 입구. 외부 DB 대신 폐기할 메모리 DB만 사용한다. */
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

  // Release the single PGlite socket before the Next process connects.
  await closeDb();
  const appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    cwd: join(root, "apps/web"), env: { ...process.env, NEXT_DIST_DIR: ".next-admin-access", NEXT_TELEMETRY_DISABLED: "1", BOT_GUARD: "off", SITE_ORIGIN: base },
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
  console.log("PASS HTTP admin page/API/POST gates, owner console, and member-only admin link");
} finally {
  if (app && app.exitCode === null) {
    const exited = new Promise<void>((resolve) => app!.once("exit", () => resolve()));
    app.kill("SIGTERM"); await exited;
  }
  await closeDb(); await server.stop(); await memory.close();
}
