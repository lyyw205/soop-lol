/**
 * 커뮤니티를 실제 Next 서버 + 브라우저(Playwright)로 끝까지 확인한다. docs/COMMUNITY-PLAN.md §8 "브라우저"
 *
 *   node scripts/verify-community-browser.ts
 *
 * ★ 실제 DB 에 쓰지 않는다 — 개발용 메모리 DB(scripts/dev-db.ts, PGlite)를 새로 띄운다.
 * ★ 가짜는 로그인 제공자 하나뿐이다. 이 스크립트가 HTTP 로 OIDC 제공자를 흉내 내고(discovery·인가·토큰),
 *   Next 서버는 진짜 openid-client 로 거기에 붙는다(OAUTH_KAKAO_ISSUER — http 는 로컬 주소에만 허용된다).
 *   인가 화면은 사람이 승인했다고 치고 바로 돌려보낸다. 브라우저 컨텍스트마다 다른 사람(sub)이다.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";

import { chromium, type Page } from "playwright";

import { freePort } from "./lib/disposable-postgres.ts";

const root = join(import.meta.dirname, "..");
let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const logs = new Map<ChildProcess, string>();
function waitForOutput(child: ChildProcess, needle: string | RegExp, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(() => reject(new Error(`시간 초과: ${needle}\n${log.slice(-2000)}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      logs.set(child, (logs.get(child) ?? "") + chunk.toString());
      if (typeof needle === "string" ? log.includes(needle) : needle.test(log)) { clearTimeout(timer); resolve(); }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`먼저 끝났다(code ${code})\n${log.slice(-2000)}`)); });
  });
}

// ── 가짜 OIDC 제공자 ─────────────────────────────────────────────────
const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
async function startFakeProvider(clientId: string) {
  const port = await freePort();
  const issuer = `http://127.0.0.1:${port}`;
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const codes = new Map<string, { challenge: string; redirectUri: string; nonce: string; sub: string }>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/.well-known/openid-configuration") {
      return json(200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      });
    }
    if (url.pathname === "/authorize") {
      // 브라우저 컨텍스트마다 다른 사람 — 제공자 쪽 로그인 상태를 쿠키로 흉내 낸다.
      const cookie = /fake_sub=([\w-]+)/.exec(req.headers.cookie ?? "")?.[1];
      const sub = cookie ?? `u-${randomBytes(6).toString("hex")}`;
      const code = b64url(randomBytes(12));
      codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "", redirectUri: url.searchParams.get("redirect_uri") ?? "",
        nonce: url.searchParams.get("nonce") ?? "", sub,
      });
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString(), "set-cookie": `fake_sub=${sub}; Path=/; HttpOnly` });
      return res.end();
    }
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        const entry = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (!entry || form.get("client_id") !== clientId) return json(400, { error: "invalid_grant" });
        const challenge = b64url(createHash("sha256").update(form.get("code_verifier") ?? "").digest());
        if (challenge !== entry.challenge || form.get("redirect_uri") !== entry.redirectUri) return json(400, { error: "invalid_grant" });
        const now = Math.floor(Date.now() / 1000);
        const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "k1" }));
        const claims = b64url(JSON.stringify({ iss: issuer, aud: clientId, sub: entry.sub, nonce: entry.nonce, iat: now, exp: now + 300 }));
        const sig = b64url(createSign("RSA-SHA256").update(`${head}.${claims}`).sign(privateKey));
        json(200, { access_token: "fake", token_type: "Bearer", expires_in: 300, id_token: `${head}.${claims}.${sig}` });
      });
      return;
    }
    json(404, { error: "not_found" });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { issuer, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

// ── 준비 ─────────────────────────────────────────────────────────────
const dbPort = await freePort();
const appPort = await freePort();
const base = `http://127.0.0.1:${appPort}`;
const clientId = "verify-kakao";
const provider = await startFakeProvider(clientId);
const children: ChildProcess[] = [];
const ADMIN = { username: "verify_admin", password: "disposable-only" };
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let keepWarm: ReturnType<typeof setInterval> | undefined;

try {
  const devDb = spawn(process.execPath, ["scripts/dev-db.ts"], { cwd: root, env: { ...process.env, DEV_DB_PORT: String(dbPort) }, stdio: ["ignore", "pipe", "pipe"] });
  children.push(devDb);
  await waitForOutput(devDb, "임시 Postgres 준비됨", 180_000);

  const app = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(appPort)], {
    cwd: join(root, "apps/web"),
    env: {
      ...process.env,
      DATABASE_URL: `postgres://postgres@127.0.0.1:${dbPort}/postgres`, DATABASE_POOL_MAX: "1",
      KAKAO_CLIENT_ID: clientId, OAUTH_KAKAO_ISSUER: provider.issuer, GOOGLE_CLIENT_ID: "",
      ADMIN_USER: ADMIN.username, ADMIN_PASSWORD: ADMIN.password,
      NEXT_DIST_DIR: ".next-community-browser", NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(app);
  await waitForOutput(app, /Ready in|ready started|Local:/, 180_000);

  // ★ 이 흐름이 쓰는 경로를 브라우저보다 먼저 빌드하고, 검증 내내 내려가지 않게 30초마다 불러 둔다.
  //   개발 서버는 경로를 처음 받을 때(그리고 60초 넘게 안 쓴 경로를 내렸다 다시 받을 때 — onDemandEntries 기본값) 빌드하고,
  //   빌드가 끝나면 열린 화면을 Fast Refresh 로 다시 불러온다. 그게 로그인 화면 → /auth/kakao(·콜백) 이동과 겹치면
  //   이동이 끊겨 로그인 화면에 남는다(서버 기록에는 응답 없이 끊긴 200). 이렇게 두 번 실패했고, 열린 /login 이
  //   새 경로 빌드 때 스스로 다시 불러오는 것을 따로 띄워 확인했다(2026-10-09). 콜백은 ?error= 로 불러 오류 기록을 남기지 않는다.
  const warmPaths = ["/", "/community", "/login", "/me", "/auth/kakao", "/auth/kakao/callback?error=warm", "/lol/s/sample_a"];
  const adminAuth = `Basic ${Buffer.from(`${ADMIN.username}:${ADMIN.password}`).toString("base64")}`;
  const warm = async () => {
    for (const path of warmPaths) await fetch(`${base}${path}`, { redirect: "manual" }).then((r) => r.arrayBuffer()).catch(() => {});
    await fetch(`${base}/admin/community`, { headers: { authorization: adminAuth }, redirect: "manual" }).then((r) => r.arrayBuffer()).catch(() => {});
  };
  await warm();
  keepWarm = setInterval(() => void warm(), 30_000);

  browser = await chromium.launch();
  const newUser = async () => (await browser!.newContext({ viewport: { width: 1280, height: 1000 } })).newPage();
  const admin = await (await browser.newContext({ httpCredentials: ADMIN, viewport: { width: 1280, height: 1100 } })).newPage();
  const anon = await newUser();
  const go = async (page: Page, path: string) => page.goto(`${base}${path}`, { timeout: 180_000, waitUntil: "domcontentloaded" });
  /** 클라이언트 부품이 붙을 때까지 기다린다 — 그 전에 누르면 자바스크립트 없는 폼 제출(점진적 향상)로 가서 상태가 빠진다. */
  const settled = async (page: Page) => { await page.waitForLoadState("networkidle", { timeout: 120_000 }).catch(() => {}); };

  /** 로그인 → (처음이면) 가입 마무리. 끝나면 돌아갈 주소에 있다. */
  async function signUp(page: Page, nickname: string) {
    // 클라이언트 전환(/login)이 끝나기 전에 누르면, 뒤늦게 끝난 전환이 진행 중인 로그인 이동을 취소한다 — 화면이 자리 잡은 뒤에 누른다.
    await settled(page);
    if (process.env.VERIFY_DEBUG) page.on("response", (r) => { if (r.url().includes("/auth/") || r.url().includes("/authorize")) console.log("  [응답]", r.status(), r.url().slice(0, 90), r.headers()["location"]?.slice(0, 90) ?? "", (r.headers()["set-cookie"] ?? "").slice(0, 60)); });
    await page.getByRole("link", { name: "카카오로 로그인" }).click();
    await page.waitForURL(/\/me\?setup=1/, { timeout: 120_000, waitUntil: "commit" });
    await settled(page);
    await page.getByLabel(/닉네임/).fill(nickname);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "가입 마치기" }).click();
  }

  console.log("\n▸ 비로그인");
  const listRes = await go(anon, "/community");
  check("/community 가 열린다(200)", listRes?.status() === 200, String(listRes?.status()));
  check("머리말에 커뮤니티 메뉴·로그인 자리가 있다",
    await anon.locator(".arena-nav a", { hasText: "커뮤니티" }).count() === 1 && await anon.locator(".header-account", { hasText: "로그인" }).count() === 1);
  check("게임 칩(전체·LOL·FC·기타)이 있다", (await anon.locator('nav[aria-label="게임"] a').allInnerTexts()).join("·") === "전체·LOL·FC·기타");

  console.log("\n▸ 회원 1 — 로그인 → 가입 마무리 → 글쓰기");
  const u1 = await newUser();
  await go(u1, "/community?game=lol");
  await u1.getByRole("link", { name: "글쓰기" }).first().click();
  await u1.waitForURL(/\/login\?next=/, { timeout: 120_000, waitUntil: "commit" });
  await signUp(u1, "검증회원일");
  await u1.waitForURL(/\/community\?write=1/, { timeout: 120_000, waitUntil: "commit" });
  await settled(u1);
  check("가입을 마치면 원래 가려던 글쓰기로 돌아온다", u1.url().includes("write=1"), u1.url());
  check("롤 목록에서 들어온 글쓰기는 게임 기본값이 LOL", await u1.locator('select[name="game"]').inputValue() === "lol");
  await u1.locator('input[name="title"]').fill("브라우저 검증 글");
  await u1.locator('textarea[name="body"]').fill("본문입니다. https://example.com/x 링크 <script>alert(1)</script>");
  await u1.getByLabel("태그할 스트리머").fill("샘플 스트리머 A (sample_a)");
  await u1.getByRole("button", { name: "추가" }).click();
  await u1.locator(".cm-tags li", { hasText: "샘플 스트리머 A" }).waitFor({ timeout: 30_000 });
  await u1.getByRole("button", { name: "올리기" }).click();
  await u1.waitForURL(/\/community\/\d+$/, { timeout: 120_000, waitUntil: "commit" });
  const postPath = new URL(u1.url()).pathname;
  await settled(u1);
  check("올리면 글 상세로 간다", await u1.getByRole("heading", { level: 1, name: "브라우저 검증 글" }).count() === 1, postPath);
  const link = u1.locator(".cm-body a");
  check("본문의 http 주소는 링크가 되고 nofollow 가 붙는다",
    await link.getAttribute("href") === "https://example.com/x" && (await link.getAttribute("rel") ?? "").includes("nofollow"));
  check("★ 본문의 HTML 은 글자로 남는다(스크립트가 실행되지 않는다)",
    (await u1.locator(".cm-body").innerText()).includes("<script>alert(1)</script>") && await u1.locator(".cm-body script").count() === 0);
  check("태그한 스트리머가 보인다", await u1.locator(".cm-streamers", { hasText: "샘플 스트리머 A" }).count() === 1);
  await u1.getByLabel("댓글", { exact: true }).fill("첫 댓글");
  await u1.getByRole("button", { name: "댓글 달기" }).click();
  await u1.locator(".cm-comment", { hasText: "첫 댓글" }).waitFor({ timeout: 60_000 });
  check("댓글을 달면 바로 보인다", true);
  await go(u1, "/community?write=1");
  await settled(u1);
  await u1.locator('input[name="title"]').fill("기타 검증 글");
  await u1.locator('textarea[name="body"]').fill("게임과 무관한 글");
  await u1.getByRole("button", { name: "올리기" }).click();
  await u1.getByText(/1분에 1개/).waitFor({ timeout: 60_000 });
  check("★ 1분 안의 두 번째 글은 쓰기 한도에 걸리고, 입력값은 그대로 남는다",
    await u1.locator('input[name="title"]').inputValue() === "기타 검증 글");
  await u1.waitForTimeout(61_000);
  await u1.getByRole("button", { name: "올리기" }).click();
  await u1.waitForURL(/\/community\/\d+$/, { timeout: 120_000, waitUntil: "commit" });
  const etcPath = new URL(u1.url()).pathname;
  check("1분 뒤에는 같은 입력으로 올라간다", etcPath !== postPath, etcPath);

  console.log("\n▸ 분류");
  await go(anon, "/community?game=lol");
  const lolText = await anon.locator(".cm-list").innerText().catch(() => "");
  check("★ ?game=lol 목록에 기타 글이 섞이지 않는다", lolText.includes("브라우저 검증 글") && !lolText.includes("기타 검증 글"), lolText.slice(0, 200));
  await go(anon, "/community?game=etc");
  const etcText = await anon.locator(".cm-list").innerText().catch(() => "");
  check("?game=etc 는 기타 글만", etcText.includes("기타 검증 글") && !etcText.includes("브라우저 검증 글"));

  console.log("\n▸ 들어오는 길(프로필)");
  await go(anon, "/lol/s/sample_a");
  const talk = anon.getByRole("link", { name: /이 스트리머 이야기/ });
  check("롤 프로필에 '이 스트리머 이야기' 가 있다", await talk.count() === 1);
  await talk.click();
  await anon.waitForURL(/\/community\?/, { timeout: 120_000, waitUntil: "commit" });
  check("누르면 그 스트리머가 태그된 글 목록(게임 문맥 lol)으로 간다",
    anon.url().includes("s=sample_a") && anon.url().includes("game=lol")
      && await anon.getByRole("heading", { level: 1, name: "샘플 스트리머 A 이야기" }).count() === 1
      && (await anon.locator(".cm-list").innerText()).includes("브라우저 검증 글"), anon.url());

  console.log("\n▸ 회원 2 — 추천·신고·답글");
  const u2 = await newUser();
  await go(u2, `/login?next=${encodeURIComponent(postPath)}`);
  await signUp(u2, "검증회원이");
  await u2.waitForURL(new RegExp(`${postPath}$`), { timeout: 120_000, waitUntil: "commit" });
  await settled(u2);
  await u2.getByRole("button", { name: /^추천 0$/ }).click();
  await u2.getByRole("button", { name: /^추천 1$/ }).waitFor({ timeout: 60_000 });
  check("추천하면 1 이 되고 다시 누를 수 없다", await u2.getByRole("button", { name: /^추천 1$/ }).isDisabled());
  await u2.locator(".cm-article-actions .cm-report summary").click();
  await u2.locator(".cm-article-actions select[name=reason]").selectOption("defamation");
  await u2.locator(".cm-article-actions").getByRole("button", { name: "신고하기" }).click();
  await u2.getByText("신고했습니다. 운영자가 확인합니다.").waitFor({ timeout: 60_000 });
  check("신고를 받는다", true);
  await u2.locator(".cm-comment", { hasText: "첫 댓글" }).getByRole("button", { name: "답글" }).click();
  await u2.getByLabel("답글", { exact: true }).fill("답글입니다");
  await u2.getByRole("button", { name: "답글 달기" }).click();
  await u2.locator(".cm-reply", { hasText: "답글입니다" }).waitFor({ timeout: 60_000 });
  check("답글이 부모 댓글 아래 달린다", true);
  await u2.waitForTimeout(11_000); // 댓글 쓰기 한도(10초에 1개) — 바로 앞의 답글과 겹치지 않게
  await go(u2, etcPath);
  await settled(u2);
  await u2.getByLabel("댓글", { exact: true }).fill("탈퇴할 회원의 댓글");
  await u2.getByRole("button", { name: "댓글 달기" }).click();
  await u2.locator(".cm-comment", { hasText: "탈퇴할 회원의 댓글" }).waitFor({ timeout: 60_000 });

  console.log("\n▸ 운영자 — 숨김");
  await go(admin, "/admin/community");
  await settled(admin);
  const item = admin.locator("li", { hasText: "브라우저 검증 글" }).filter({ has: admin.locator('select[name="action"]') }).first();
  check("신고가 관리자 목록에 오고 명예훼손 표시가 붙는다", await item.count() === 1 && (await item.innerText()).includes("개인정보·명예훼손"));
  await item.locator('select[name="action"]').selectOption("hide");
  await item.locator('input[name="reason"]').fill("브라우저 검증 숨김");
  await item.getByRole("button", { name: "처리" }).click();
  // 처리하면 신고가 닫혀 그 항목(과 그 안의 결과 문구)이 목록에서 빠진다 — '최근 처리' 에 사유가 오르는 것으로 확인한다.
  await admin.locator("li", { hasText: "브라우저 검증 숨김" }).waitFor({ timeout: 60_000 });
  check("처리하면 신고 대기에서 빠지고 최근 처리에 사유가 남는다",
    await admin.locator("li", { hasText: "브라우저 검증 글" }).filter({ has: admin.locator('select[name="action"]') }).count() === 0);
  const hiddenRes = await go(anon, postPath);
  check("★ 숨긴 글은 공개 상세가 404", hiddenRes?.status() === 404, String(hiddenRes?.status()));
  await go(anon, "/community");
  check("숨긴 글은 목록에서도 빠진다", !(await anon.locator(".cm-list").innerText().catch(() => "")).includes("브라우저 검증 글"));
  const editRes = await go(u1, `${postPath}?edit=1`);
  check("★ 숨긴 글은 작성자도 고치기 화면을 열 수 없다(404)", editRes?.status() === 404, String(editRes?.status()));
  const badId = await go(anon, "/community/abc");
  check("숫자가 아닌 글 번호는 404(500 이 아니다)", badId?.status() === 404, String(badId?.status()));

  console.log("\n▸ 휴대폰 너비");
  await anon.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/community", etcPath]) {
    await go(anon, path);
    const overflow = await anon.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${path} — 가로 스크롤이 없다`, overflow <= 0, `넘침 ${overflow}px`);
  }

  console.log("\n▸ 로그아웃·탈퇴");
  await go(u1, "/me");
  await settled(u1);
  await u1.getByRole("button", { name: "로그아웃" }).click();
  await u1.waitForURL(`${base}/`, { timeout: 60_000, waitUntil: "commit" });
  check("로그아웃하면 머리말이 다시 '로그인'", await u1.locator(".header-account", { hasText: "로그인" }).count() === 1);
  await go(u2, "/me");
  await settled(u2);
  await u2.locator('input[name="confirm"]').fill("탈퇴");
  await u2.getByRole("button", { name: "탈퇴하기" }).click();
  await u2.waitForURL(`${base}/`, { timeout: 60_000, waitUntil: "commit" });
  await go(anon, etcPath);
  check("탈퇴한 회원의 댓글은 '탈퇴한 회원' 으로 남는다", (await anon.locator(".cm-comment", { hasText: "탈퇴할 회원의 댓글" }).innerText()).includes("탈퇴한 회원"));
  await go(u2, "/login");
  await u2.getByRole("link", { name: "카카오로 로그인" }).click();
  await u2.waitForURL(/\/login\?blocked=/, { timeout: 120_000, waitUntil: "commit" });
  check("★ 탈퇴한 소셜 계정으로 바로 다시 가입할 수 없다", (await u2.locator(".member-alert").innerText()).includes("탈퇴한 계정입니다"));
} catch (error) {
  failures++;
  console.error(" FAIL  진행 중 오류 —", error instanceof Error ? error.message : error);
  for (const [child, log] of logs) console.error(`--- 프로세스 ${child.pid} 로그 끝 ---\n${log.slice(-3000)}`);
} finally {
  clearInterval(keepWarm);
  await browser?.close();
  for (const child of children.reverse()) child.kill("SIGTERM");
  await provider.close();
}

console.log(failures === 0 ? "\n전부 통과.\n" : `\n${failures}건 실패.\n`);
process.exit(failures === 0 ? 0 : 1);
