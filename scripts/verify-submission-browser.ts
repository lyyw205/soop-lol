/**
 * 사용자 제보(0093) 실제 브라우저 흐름 — 외부 DB 는 쓰지 않는다(폐기 PGlite).
 *
 *   세트 보기의 제보하기 → 폼에서 킬 수정 → 바로 반영 + 상대전적의 "확인 전" → 다른 회원 +1 →
 *   내 정보 → 내 제보 → 관리 메뉴 → 운영자 확인 → "확인 전" 이 떨어지고 내 제보는 확인 완료 · 모바일 · 비로그인 안내
 * 편성표 제보(0094): 일정 상세의 제보하기 → 취소 제보(편성표는 그대로) · 빠진 일정 알리기 → 운영자 대기열 →
 *   편성표 편집에서 반영(미리 채운 폼 저장) → 편성표 반영 + 제보 확인 완료
 * VOD 단서(0098): 내 제보 → 단서 보내기 → 숨김 + 판독 요청 · 직접 입력(0099): 내 제보 → 경기 등록 → 바로 공개·"검증 전" · 운영 대기열.
 * 규칙 자체(중복 네 겹·보류·되돌리기·집계 제외·판독 검증)는 verify:db 가 함수로 검사한다.
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
const { saveScheduleEntry } = await import("../packages/core/lib/db/schedule.ts");
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
  // 편성표 — 공개 일정 하나(참가자 A). 회원이 취소를 제보한다.
  const kst = (v: string) => new Date(`${v}:00+09:00`);
  const sched = await saveScheduleEntry({
    game_code: "lol", title: "제보 화면 편성", planned_format: "ck", sponsor: null, description: null, admin_note: null,
    status: "scheduled", event_id: null, visibility: "public",
    slots: [{ label: null, on_date: "2026-11-20", starts_at: kst("2026-11-20T20:00"), ends_at: null, channel_id: null }],
    participants: [{ streamer_id: A, role: "host", team: null }],
    sources: [{ url: "https://ch.sooplive.co.kr/sbb/post/1", title: "공지", posted_at: null }],
  });
  const one = async <T,>(q: string, args: unknown[] = []) => (await memory.query<T>(q, args)).rows[0];
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
    // 개발 서버는 처음 여는 화면을 그때 컴파일한다(수십 초) — 이동 대기는 넉넉히.
    context.setDefaultNavigationTimeout(120_000); context.setDefaultTimeout(60_000);
    if (token) await context.addCookies([{ name: SESSION_COOKIE, value: token, url: base }]);
    return context.newPage();
  };
  // 링크 따라가기 — 링크가 있고 어디를 가리키는지 확인한 뒤 그 주소로 연다. 개발 서버는 처음 여는 화면을 컴파일하는 동안
  // 클라이언트 이동이 걸리지 않을 때가 있어(운영 빌드에는 없는 단계) 클릭 대신 주소로 간다.
  // 개발 서버는 새 화면을 컴파일하면서 열린 탭들을 다시 불러온다 — 그 순간의 이동은 ERR_ABORTED 로 끊긴다(운영 빌드에는 없다). 끊기면 다시 간다.
  const go = async (page: Awaited<ReturnType<typeof contextFor>>, url: string) => {
    for (let tries = 1; ; tries++) {
      try { return await page.goto(url, { timeout: 120_000 }); } catch (e) {
        if (tries >= 3 || !String((e as Error).message).includes("ERR_ABORTED")) throw e;
        await page.waitForTimeout(1000);
      }
    }
  };
  const follow = async (page: Awaited<ReturnType<typeof contextFor>>, name: string, expected: RegExp) => {
    const href = await page.getByRole("link", { name }).first().getAttribute("href");
    assert.ok(href && expected.test(href), `${name} → ${href}`);
    await go(page, new URL(href!, base).toString());
  };
  const versus = `${base}/lol/versus?a=sbb-a&b=sbb-b`;
  const openSet = async (page: Awaited<ReturnType<typeof contextFor>>) => {
    await page.goto(versus, { timeout: 120_000 });
    await page.locator("button", { hasText: "제보 화면 CK" }).first().click();
    await page.locator(".match-details").waitFor();
  };

  // 비로그인 — 폼 대신 로그인 안내
  const anon = await contextFor();
  await go(anon, `${base}/submit/match/${encodeURIComponent(matchId)}`);
  assert.ok(await anon.getByRole("link", { name: "로그인하고 제보하기 →" }).isVisible());
  assert.equal(await anon.getByRole("button", { name: /제보 보내기|바꾼 칸이 없습니다/ }).count(), 0);
  await go(anon, `${base}/submissions`);
  await anon.waitForURL(/\/login\?next=/);
  console.log("PASS anonymous: login prompt instead of form, /submissions redirects to login");

  // 작성자 — 세트 보기의 제보하기 → 1번 킬 1 → 5
  const user = await contextFor(writer.token);
  await openSet(user);
  assert.equal(await user.locator(".match-details .pending-badge").count(), 0);
  await follow(user, "제보하기", /^\/submit\/match\//);
  const send = user.getByRole("button", { name: /제보 보내기|바꾼 칸이 없습니다/ });
  assert.equal(await send.textContent(), "바꾼 칸이 없습니다");
  await user.getByLabel("1번 킬").fill("5");
  await user.getByLabel("메모(선택)").fill("<b>VOD 12:30</b> 결과창");
  await user.getByRole("button", { name: "제보 보내기" }).click();
  await user.getByRole("status").filter({ hasText: "운영자가 확인한 뒤 경기 기록에 반영됩니다" }).waitFor({ timeout: 60_000 });
  const kills = async () => (await memory.query<{ kills: number }>(`SELECT kills FROM match_participant WHERE match_id = $1 AND participant_id = 1`, [matchId])).rows[0].kills;
  assert.equal(await kills(), 1, "correction must wait for the operator (2026-10-18)");
  console.log("PASS set view → 제보하기 → form sends only the changed cell → held for the operator, value unchanged");

  // 공개 화면 — 운영자 확인 전에는 아무 표시 없이 그대로(사용자 결정 10/18)
  await openSet(user);
  assert.equal(await user.locator(".match-details .pending-badge").count(), 0);
  assert.equal(await user.locator(".match-details-pending-dot").count(), 0);
  console.log("PASS public versus page unchanged while the correction waits (no badge)");

  // 다른 회원 — 열린 제보가 보이고 +1
  const second = await contextFor(other.token);
  await go(second, `${base}/submit/match/${encodeURIComponent(matchId)}`);
  await second.getByRole("heading", { name: "이 경기에 이미 접수된 제보 1건" }).waitFor();
  assert.ok(await second.getByText("1번 자리 킬: 1 → 5").isVisible());
  await second.getByRole("button", { name: "같은 내용이에요(+1)" }).click();
  // +1 한 회원도 이 제보에 낀 사람이 된다 — 다시 그리면 버튼이 빠지고 숫자가 오른다(두 번 +1 못 함).
  await second.getByText("운영자 확인 대기 · 같은 내용 1").waitFor({ timeout: 60_000 });
  assert.equal(await second.getByRole("button", { name: "같은 내용이에요(+1)" }).count(), 0);
  console.log("PASS another member sees the open submission, adds +1 once (count shown, button gone)");

  // 작성자 — 내 정보 → 내 제보
  await go(user, `${base}/me`);
  await follow(user, "내 경기 제보 확인 →", /^\/submissions$/);
  await user.getByText(/운영자 확인 대기 · 같은 내용 1/).waitFor();
  assert.ok(await user.getByText("1번 자리 킬: 1 → 5").isVisible());
  await user.setViewportSize({ width: 390, height: 844 });
  assert.equal(await user.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await go(user, `${base}/submit/match/${encodeURIComponent(matchId)}`);
  assert.equal(await user.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "submission form must not scroll sideways on mobile");
  await user.setViewportSize({ width: 1280, height: 900 });
  console.log("PASS /me link → my submissions with state and +1 count, mobile without horizontal scroll");

  // 운영자 — 관리 메뉴 → 대기열 → 처리 → 확인
  const admin = await contextFor(owner.token);
  await go(admin, `${base}/admin`);
  await follow(admin, "회원 제보", /^\/admin\/submissions$/);
  await follow(admin, "처리 →", /^\/admin\/submissions\/[0-9a-f-]+$/);
  assert.ok(await admin.getByText("메모: <b>VOD 12:30</b> 결과창").isVisible());
  await admin.getByLabel("확인 메모").fill("결과창 확인");
  await admin.getByRole("button", { name: "확인하고 반영" }).click();
  await admin.getByText(/처리: .* 결과창 확인/).waitFor({ timeout: 60_000 });
  assert.equal(await kills(), 5, "operator verify applies the correction");
  assert.equal(await pending(), false);
  const ordinary = await contextFor(other.token);
  const denied = await go(ordinary, `${base}/admin/submissions`);
  assert.equal(denied?.status(), 403);
  console.log("PASS admin nav → queue → detail (note as text) → 확인하고 반영 applies the value; ordinary member gets 403");

  // 확인 뒤 — 값이 바뀌고(표시 없이 바로 집계) 내 제보는 확인 완료
  await openSet(user);
  assert.equal(await user.locator(".match-details .pending-badge").count(), 0);
  await go(user, `${base}/submissions`);
  await user.getByText(/확인 완료/).waitFor();
  assert.ok(await user.getByText("운영자: 결과창 확인").isVisible());
  console.log("PASS after verification: value applied without a badge, my submissions shows 확인 완료 + admin note");

  // ── 편성표 제보 — 바로 반영 + 확인 전(사용자 결정 10/18) ───────────────────────────
  await go(user, `${base}/schedule/${sched.id}`);
  await follow(user, "제보하기 →", /^\/submit\/schedule\/[0-9a-f-]+$/);
  assert.equal(await user.getByLabel("제목").inputValue(), "제보 화면 편성");
  assert.equal(await user.getByRole("button", { name: /제보 보내기|바꾼 칸이 없습니다/ }).textContent(), "바꾼 칸이 없습니다");
  await user.getByLabel("상태").selectOption("cancelled");
  await user.getByLabel("메모(선택)").fill("방송 공지에서 취소");
  await user.getByRole("button", { name: "제보 보내기" }).click();
  await user.getByRole("status").filter({ hasText: "편성표에 반영했습니다" }).waitFor({ timeout: 60_000 });
  assert.equal((await one<{ status: string }>(`SELECT status FROM schedule_entry WHERE id = $1`, [sched.id])).status, "cancelled", "schedule report applies at once");
  await go(user, `${base}/schedule/${sched.id}`);
  await user.locator(".sched-pending").first().waitFor();
  console.log("PASS schedule detail → 제보하기 → cancel report applied at once, schedule shows 확인 전");

  // 다른 회원이 같은 일정에 또 제보하면(확인 전 제보가 있다) 운영자 대기 — 편성표 편집에서 반영하는 길
  await go(second, `${base}/submit/schedule/${sched.id}`);
  await second.getByLabel("제목").fill("제보 화면 편성(결승)");
  await second.getByRole("button", { name: "제보 보내기" }).click();
  await second.getByRole("status").filter({ hasText: "운영자가 함께 확인" }).waitFor({ timeout: 60_000 });
  assert.equal((await one<{ title: string }>(`SELECT title FROM schedule_entry WHERE id = $1`, [sched.id])).title, "제보 화면 편성");
  console.log("PASS a second report on the same entry waits for the operator (contested), schedule unchanged");

  await go(user, `${base}/schedule`);
  await follow(user, "빠진 일정 알리기 →", /^\/submit\/schedule\/new$/);
  await user.getByLabel("제목").fill("제보로 알린 대회");
  await user.getByLabel("날짜").fill("2026-11-25");
  await user.getByLabel("시작 시각(선택)").fill("19:30");
  await user.getByLabel("참가자(선택)").fill("제보에이, 모르는이름");
  await user.getByLabel("근거 링크").fill("https://ch.sooplive.co.kr/sbb/post/2");
  await user.setViewportSize({ width: 390, height: 844 });
  assert.equal(await user.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "schedule report form must not scroll sideways on mobile");
  await user.setViewportSize({ width: 1280, height: 900 });
  await user.getByRole("button", { name: "제보 보내기" }).click();
  await user.getByRole("status").filter({ hasText: "편성표에 반영했습니다" }).waitFor({ timeout: 60_000 });
  const reports = (await memory.query<{ id: string; schedule_entry_id: string | null; state: string }>(
    `SELECT id, schedule_entry_id, state FROM submission WHERE kind = 'schedule_report' ORDER BY created_at`)).rows;
  assert.deepEqual(reports.map((r) => r.state), ["applied", "held", "applied"]);
  const entry = await one<{ title: string; starts: string; people: number; src: number; visibility: string }>(`SELECT e.title, e.visibility, to_char(s.starts_at AT TIME ZONE 'Asia/Seoul', 'YYYY-MM-DD HH24:MI') AS starts,
      (SELECT count(*)::int FROM schedule_participant p WHERE p.entry_id = e.id) AS people,
      (SELECT count(*)::int FROM schedule_source x WHERE x.entry_id = e.id AND x.url = 'https://ch.sooplive.co.kr/sbb/post/2') AS src
     FROM schedule_entry e JOIN schedule_slot s ON s.entry_id = e.id WHERE e.id = $1`, [reports[2].schedule_entry_id]);
  assert.deepEqual(entry, { title: "제보로 알린 대회", visibility: "public", starts: "2026-11-25 19:30", people: 1, src: 1 });
  console.log("PASS schedule board → 빠진 일정 알리기 → new entry public at once (date·time·matched participant·evidence source), mobile without horizontal scroll");

  // 운영자 — 대기열 → 바로 반영된 취소는 확인(표시 떼기) · 보류는 편성표 편집에서 반영 · 새 일정은 반려(숨김)
  await go(admin, `${base}/admin/submissions`);
  assert.ok(await admin.getByText("제보 화면 편성").first().isVisible());
  await go(admin, `${base}/admin/submissions/${reports[0].id}`);
  await admin.getByRole("button", { name: "확인(표시 떼기)" }).click();
  await admin.getByText(/처리: /).waitFor({ timeout: 60_000 });
  assert.equal((await one<{ state: string }>(`SELECT state FROM submission WHERE id = $1`, [reports[0].id])).state, "verified");
  await go(admin, `${base}/admin/submissions/${reports[1].id}`);
  await follow(admin, "편성표 편집에서 반영 →", /^\/admin\/schedule\/[0-9a-f-]+\?submission=/);
  await admin.getByText("회원 제보로 미리 채웠습니다").waitFor();
  await admin.getByRole("button", { name: "저장" }).click();
  await admin.waitForURL(/saved=1/, { timeout: 60_000 });
  assert.equal((await one<{ title: string }>(`SELECT title FROM schedule_entry WHERE id = $1`, [sched.id])).title, "제보 화면 편성(결승)");
  assert.equal((await one<{ state: string }>(`SELECT state FROM submission WHERE id = $1`, [reports[1].id])).state, "verified");
  await go(admin, `${base}/admin/submissions/${reports[2].id}`);
  admin.once("dialog", (d) => d.accept());
  await admin.getByRole("button", { name: "반려(되돌리기)" }).click();
  await admin.getByText(/처리: /).waitFor({ timeout: 60_000 });
  assert.equal((await one<{ visibility: string }>(`SELECT visibility FROM schedule_entry WHERE id = $1`, [reports[2].schedule_entry_id])).visibility, "hidden");
  await go(user, `${base}/schedule/${sched.id}`);
  assert.equal(await user.locator(".sched-pending").count(), 0);
  console.log("PASS admin: 확인 drops 확인 전 · held report → 편성표 편집에서 반영 (prefilled save) · reject hides the reported new entry");

  // ── VOD 단서(0098) · 빠진 경기 직접 입력(0099) ─────────────────────────────────
  await go(user, `${base}/submissions`);
  await follow(user, "내전이 있는 VOD 알리기 →", /^\/submit\/vod$/);
  await user.getByLabel("SOOP VOD 링크").fill("https://vod.sooplive.com/player/209748301");
  await user.getByLabel("시작 시점(선택)").fill("1:20:00");
  await user.getByRole("button", { name: "단서 보내기" }).click();
  await user.getByRole("status").filter({ hasText: "VOD 판독 대기열 맨 앞" }).waitFor({ timeout: 60_000 });
  const hintReq = await one<{ n: number }>(`SELECT count(*)::int AS n FROM vod_request WHERE title_no = 209748301 AND reason = 'submission' AND state = 'queued'`);
  assert.equal(hintReq.n, 1);
  await go(user, `${base}/submissions`);
  await user.getByText(/VOD 판독 대기/).first().waitFor();
  console.log("PASS my submissions → VOD 단서 알리기 → hidden hint + queued VOD request, my submissions shows VOD 판독 대기");

  await follow(user, "빠진 경기 직접 등록하기 →", /^\/submit\/addition$/);
  await user.getByLabel("날짜").fill("2026-10-20");
  await user.getByLabel("첫 세트 시작(어림)").fill("20:00");
  await user.getByLabel("A팀 1번").selectOption({ label: "제보에이" });
  await user.getByLabel("B팀 1번").selectOption({ label: "제보비" });
  await user.getByLabel("승리 팀").selectOption("a");
  await user.setViewportSize({ width: 390, height: 844 });
  assert.equal(await user.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "addition form must not scroll sideways on mobile");
  await user.setViewportSize({ width: 1280, height: 900 });
  await user.getByRole("button", { name: "경기 등록" }).click();
  await user.getByRole("status").filter({ hasText: "검증 전" }).waitFor({ timeout: 60_000 });
  const added = await one<{ id: string; rule_id: string }>(`SELECT id, rule_id FROM submission WHERE kind = 'match_addition'`);
  assert.equal(added.rule_id, "addition_unverifiable");   // 링크도 그날 단서 행도 없다 — 검증 전 + 운영자
  await go(user, versus);
  await user.locator(".pending-badge").first().waitFor();
  assert.equal(await user.locator(".pending-badge").first().textContent(), "검증 전");
  await go(admin, `${base}/admin/submissions`);
  assert.ok(await admin.getByText("빠진 경기 등록").first().isVisible());
  assert.ok(await admin.getByText("VOD 단서").first().isVisible());
  console.log("PASS my submissions → 빠진 경기 직접 등록 → public at once with 검증 전 on versus page, admin queue lists addition + hint, mobile without horizontal scroll");
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
