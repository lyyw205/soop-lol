/**
 * 사용자 제보(0093) 실제 브라우저 흐름 — 외부 DB 는 쓰지 않는다(폐기 PGlite).
 *
 *   세트 보기의 제보하기 → 폼에서 킬 수정 → 바로 반영 + 상대전적의 "확인 전" → 다른 회원 +1 →
 *   내 정보 → 내 제보 → 관리 메뉴 → 운영자 확인 → "확인 전" 이 떨어지고 내 제보는 확인 완료 · 모바일 · 비로그인 안내
 * 규칙 자체(중복 네 겹·보류·되돌리기·집계 제외)는 verify:db 의 verify-submission-db 가 함수로 검사한다.
 */
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
const { db, closeDb } = await import("../packages/core/lib/db/client.ts");
const { loginWithIdentity, createSession, setNickname } = await import("../packages/core/lib/db/member.ts");
const { placeSetInTx } = await import("../packages/core/lib/db/classification.ts");
const { resolveChampion } = await import("../packages/core/lib/db/participant.ts");
const { lolEvent } = await import("./lib/verify-ck-fixtures.ts");
let app: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let appLog = "";
try {
  await applyAll((sql) => memory.exec(sql), root);
  const sql = db();
  async function member(subject: string, nickname: string) {
    const m = await loginWithIdentity("kakao", subject);
    if (m.kind !== "ok") throw new Error("unexpected blocked fixture");
    const session = await createSession(m.memberId);
    await setNickname(session.token, nickname, { agreed: true });
    return { id: m.memberId, token: session.token };
  }
  const owner = await member("owner", "제보운영");
  const writer = await member("writer", "제보작성");
  const other = await member("other", "제보동의");
  process.env.SUPER_ADMIN_MEMBER_ID = owner.id;

  // 두 스트리머가 맞붙은 1세트짜리 시리즈. A 가 이겼고 A 의 킬은 1 — 제보로 5 로 고친다.
  const mk = async (slug: string, name: string) => (await sql<{ id: string }[]>`INSERT INTO streamer (slug, display_name) VALUES (${slug}, ${name}) RETURNING id`)[0].id;
  const A = await mk("sbb-a", "제보에이"), B = await mk("sbb-b", "제보비");
  const ev = await lolEvent("sbb-ck", "ck", "제보 화면 CK");
  const matchId = "SBB:1";
  await sql.begin(async (tx) => {
    await tx`INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, map_id, collected_via, scope, game_creation, game_creation_precision, winning_team)
      VALUES (${matchId}, 'lol', 0, '0', 'CLASSIC', 11, 'vod', 'personal', ${new Date("2026-10-01T12:00:00Z")}, 'datetime', 100)`;
    await placeSetInTx(tx, { match_id: matchId, game_no: 1, actor: "admin", series: { id: "sbb-series", game_code: "lol", event_id: ev } });
    for (const [pid, team, streamer, champ] of [[1, 100, A, 1], [2, 200, B, 2]] as const) await tx`
      INSERT INTO match_participant (match_id, participant_id, team_id, side_no, streamer_id, champion_id, champion_name, team_position, individual_position, outcome, kills, deaths, assists)
      VALUES (${matchId}, ${pid}, ${team}, ${team === 100 ? 1 : 2}, ${streamer}::uuid, ${champ}, ${resolveChampion(champ, null).champion_name},
              'MIDDLE', 'MIDDLE', ${team === 100 ? "win" : "loss"}, 1, 1, 1)`;
  });
  // ★ Next 가 소켓을 쥔 뒤에도 읽을 수 있게 PGlite 를 직접 본다(소켓 연결은 하나뿐).
  const pending = async () => (await memory.query(`SELECT 1 FROM core_public.pending_match WHERE match_id = $1`, [matchId])).rows.length > 0;
  assert.equal(await pending(), false);

  // Next 가 붙기 전에 하나뿐인 PGlite 소켓을 놓는다.
  await closeDb();
  const appPort = await freePort();
  const base = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    cwd: join(root, "apps/web"), env: { ...process.env, NEXT_DIST_DIR: ".next-submission-check", NEXT_TELEMETRY_DISABLED: "1", BOT_GUARD: "off", SITE_ORIGIN: base },
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
  const contextFor = async (token?: string) => {
    const context = await browser!.newContext({ viewport: { width: 1280, height: 900 } });
    if (token) await context.addCookies([{ name: SESSION_COOKIE, value: token, url: base }]);
    return context.newPage();
  };
  const versus = `${base}/lol/versus?a=sbb-a&b=sbb-b`;
  const openSet = async (page: Awaited<ReturnType<typeof contextFor>>) => {
    await page.goto(versus, { timeout: 120_000 });
    await page.locator("button", { hasText: "제보 화면 CK" }).first().click();
    await page.locator(".match-details").waitFor();
  };

  // 비로그인 — 폼 대신 로그인 안내
  const anon = await contextFor();
  await anon.goto(`${base}/submit/match/${encodeURIComponent(matchId)}`, { timeout: 120_000 });
  assert.ok(await anon.getByRole("link", { name: "로그인하고 제보하기 →" }).isVisible());
  assert.equal(await anon.getByRole("button", { name: /제보 보내기|바꾼 칸이 없습니다/ }).count(), 0);
  await anon.goto(`${base}/submissions`);
  await anon.waitForURL(/\/login\?next=/);
  console.log("PASS anonymous: login prompt instead of form, /submissions redirects to login");

  // 작성자 — 세트 보기의 제보하기 → 1번 킬 1 → 5
  const user = await contextFor(writer.token);
  await openSet(user);
  assert.equal(await user.locator(".match-details .pending-badge").count(), 0);
  await user.getByRole("link", { name: "제보하기" }).click();
  await user.waitForURL(/\/submit\/match\//, { timeout: 120_000 });
  const send = user.getByRole("button", { name: /제보 보내기|바꾼 칸이 없습니다/ });
  assert.equal(await send.textContent(), "바꾼 칸이 없습니다");
  await user.getByLabel("1번 킬").fill("5");
  await user.getByLabel("메모(선택)").fill("<b>VOD 12:30</b> 결과창");
  await user.getByRole("button", { name: "제보 보내기" }).click();
  await user.getByRole("status").filter({ hasText: "반영했습니다" }).waitFor({ timeout: 60_000 });
  const [after] = (await memory.query<{ kills: number }>(`SELECT kills FROM match_participant WHERE match_id = $1 AND participant_id = 1`, [matchId])).rows;
  assert.equal(after.kills, 5);
  console.log("PASS set view → 제보하기 → form sends only the changed cell → applied immediately");

  // 공개 화면 — 시리즈 줄과 세트 보기에 확인 전
  await openSet(user);
  assert.ok(await user.locator(".match-details .pending-badge").isVisible());
  assert.ok(await user.locator(".match-details-pending-dot").first().isVisible());
  console.log("PASS public versus page shows 확인 전 on the series row and the set view");

  // 다른 회원 — 열린 제보가 보이고 +1
  const second = await contextFor(other.token);
  await second.goto(`${base}/submit/match/${encodeURIComponent(matchId)}`, { timeout: 120_000 });
  await second.getByRole("heading", { name: "이 경기에 이미 접수된 제보 1건" }).waitFor();
  assert.ok(await second.getByText("1번 자리 킬: 1 → 5").isVisible());
  await second.getByRole("button", { name: "같은 내용이에요(+1)" }).click();
  // +1 한 회원도 이 제보에 낀 사람이 된다 — 다시 그리면 버튼이 빠지고 숫자가 오른다(두 번 +1 못 함).
  await second.getByText("반영됨 · 확인 전 · 같은 내용 1").waitFor({ timeout: 60_000 });
  assert.equal(await second.getByRole("button", { name: "같은 내용이에요(+1)" }).count(), 0);
  console.log("PASS another member sees the open submission, adds +1 once (count shown, button gone)");

  // 작성자 — 내 정보 → 내 제보
  await user.goto(`${base}/me`);
  await user.getByRole("link", { name: "내 경기 제보 확인 →" }).click();
  await user.waitForURL(/\/submissions$/);
  await user.getByText(/반영됨 · 확인 전 · 같은 내용 1/).waitFor();
  assert.ok(await user.getByText("1번 자리 킬: 1 → 5").isVisible());
  await user.setViewportSize({ width: 390, height: 844 });
  assert.equal(await user.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await user.goto(`${base}/submit/match/${encodeURIComponent(matchId)}`);
  assert.equal(await user.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "submission form must not scroll sideways on mobile");
  await user.setViewportSize({ width: 1280, height: 900 });
  console.log("PASS /me link → my submissions with state and +1 count, mobile without horizontal scroll");

  // 운영자 — 관리 메뉴 → 대기열 → 처리 → 확인
  const admin = await contextFor(owner.token);
  await admin.goto(`${base}/admin`, { timeout: 120_000 });
  await admin.getByRole("link", { name: "회원 제보" }).first().click();
  await admin.waitForURL(/\/admin\/submissions$/);
  await admin.getByRole("link", { name: "처리 →" }).click();
  await admin.waitForURL(/\/admin\/submissions\/[0-9a-f-]+$/);
  assert.ok(await admin.getByText("메모: <b>VOD 12:30</b> 결과창").isVisible());
  await admin.getByLabel("확인 메모").fill("결과창 확인");
  await admin.getByRole("button", { name: "확인(표시 떼기)" }).click();
  await admin.getByText(/처리: .* 결과창 확인/).waitFor({ timeout: 60_000 });
  assert.equal(await pending(), false);
  const ordinary = await contextFor(other.token);
  const denied = await ordinary.goto(`${base}/admin/submissions`);
  assert.equal(denied?.status(), 403);
  console.log("PASS admin nav → queue → detail (note as text) → verify; ordinary member gets 403");

  // 확인 뒤 — 확인 전 표시가 사라지고 내 제보는 확인 완료
  await openSet(user);
  assert.equal(await user.locator(".match-details .pending-badge").count(), 0);
  assert.equal(await user.locator(".match-details-pending-dot").count(), 0);
  await user.goto(`${base}/submissions`);
  await user.getByText(/확인 완료/).waitFor();
  assert.ok(await user.getByText("운영자: 결과창 확인").isVisible());
  console.log("PASS after verification: 확인 전 gone from public view, my submissions shows 확인 완료 + admin note");
} catch (error) {
  if (appLog) console.error(appLog.slice(-4000));
  throw error;
} finally {
  await browser?.close();
  if (app && app.exitCode === null) {
    const exited = new Promise<void>((resolve) => app!.once("exit", () => resolve()));
    app.kill("SIGTERM"); await exited;
  }
  await closeDb(); await server.stop(); await memory.close();
}
