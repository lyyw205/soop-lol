import { appendFile } from "node:fs/promises";
import { NextResponse, type NextRequest } from "next/server";

import { checkBasicAuth } from "./lib/admin-auth";
import {
  BotGuard, challengePage, classifyUserAgent, clientIp, guardSecret, isInternalIp,
  PASS_COOKIE, TRAP_PATH, VERIFY_PATH, GUARD_LIMITS, type RequestKind, type Verdict,
} from "./lib/bot-guard";
import { checkAiBot } from "./lib/bot-guard-ai";
import { checkSearchBot } from "./lib/bot-guard-search";

/**
 * 요청 앞단 — 관리자 화면 보호(HTTP Basic) + 공개 화면 봇 차단(`lib/bot-guard.ts`).
 *
 * ★ 파일 이름이 `proxy.ts` 인 이유: Next 16 에서 `middleware` 규약이 `proxy` 로 바뀌었다.
 *   `middleware.ts` 로 두면 빌드가 deprecation 경고를 낸다. export 는 default 또는
 *   `proxy` 라는 이름이어야 한다. 런타임은 Node 고정이라 node:crypto·node:dns·node:fs 를 쓴다.
 *
 * 관리자 인증은 MVP 수준이다. 스트리머 계정 매핑을 다루는 화면이라 열어두면 안 되지만,
 * 세션·역할 관리를 지금 만들 이유도 없다. 공개 제보 폼이 생기는 시점에
 * 제대로 된 인증으로 갈아탄다.
 *
 * ★ 판정은 `lib/admin-auth.ts` 한 곳이다 — 서버 액션도 같은 판정(`requireAdmin`)을 다시 부른다.
 * ★ 서버 액션은 그 액션을 쓰는 화면 주소로 오는 POST 다 — matcher 가 화면 전체를 덮어야 액션도 센다.
 *
 * 봇 차단 운영 스위치(환경변수):
 *   BOT_GUARD=enforce(기본)|observe|off — observe 는 판정만 기록하고 전부 통과시킨다. 오차단이 의심되면 즉시 이걸로.
 *   BOT_GUARD_PROXY_TOKEN — Caddy 가 `X-Guard-Proxy` 로 붙이는 비밀값. 있으면 이 값이 없는 요청(서버 직접 접속)을 막는다.
 *     IP 를 X-Forwarded-For 에서 읽으므로, Caddy 를 건너뛴 요청은 IP 를 마음대로 바꿔 한도를 피할 수 있다.
 *   BOT_GUARD_LOG — 증거 기록 파일(JSON 한 줄씩). 없으면 콘솔로만.
 */
export const config = {
  // 정적 파일·이미지·robots·sitemap 은 세지 않는다. 그 밖은 전부(화면·RSC·서버 액션).
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap.*\\.xml|images/|fonts/|design/|design-lab/).*)"],
};

type Mode = "enforce" | "observe" | "off";
const MODE: Mode = (["observe", "off"] as const).find((m) => m === process.env.BOT_GUARD) ?? "enforce";
const PRODUCTION = process.env.NODE_ENV === "production";
const PROXY_TOKEN = process.env.BOT_GUARD_PROXY_TOKEN;
const LOG_FILE = process.env.BOT_GUARD_LOG;

const globalForGuard = globalThis as unknown as { __botGuard?: { guard: BotGuard; version: number } };
/** 판정 코드를 바꾸면 올린다 — 개발 서버가 고치기 전 객체를 계속 쓰지 않게. */
const GUARD_VERSION = 2;
if (globalForGuard.__botGuard?.version !== GUARD_VERSION) globalForGuard.__botGuard = { guard: new BotGuard(guardSecret()), version: GUARD_VERSION };
const guard = globalForGuard.__botGuard.guard;

if (PRODUCTION && MODE !== "off" && !PROXY_TOKEN) console.warn("[bot-guard] BOT_GUARD_PROXY_TOKEN 이 없다 — Caddy 를 건너뛴 요청의 IP 위조를 막지 못한다");

export default async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/admin" || path.startsWith("/admin/")) return adminGate(request);
  if (MODE === "off") return NextResponse.next();
  const ua = request.headers.get("user-agent");

  // Caddy 를 거쳐 온 요청인가. 아니면 X-Forwarded-For 를 믿을 수 없다.
  if (PROXY_TOKEN && request.headers.get("x-guard-proxy") !== PROXY_TOKEN) {
    record({ action: "block", reason: "direct-origin" }, { ip: null, ua, request });
    return MODE === "enforce" ? plain(403, "Forbidden") : NextResponse.next();
  }
  const ip = clientIp((name) => request.headers.get(name));
  // IP 를 모르면(헤더 설정 실수) 막지 않는다 — 전부를 막는 것보다 낫다. 한 번 경고는 남긴다.
  if (!ip) { warnOnce("no-ip", "[bot-guard] 손님 IP 를 못 읽었다 — Caddy 의 X-Forwarded-For 를 확인"); return NextResponse.next(); }
  // 내부 주소 예외는 개발에서만. 운영에서 내부 주소로 보이면 그 자체가 설정 이상이다.
  if (!PRODUCTION && isInternalIp(ip)) return NextResponse.next();

  if (path === VERIFY_PATH) return redeem(request, ip, ua);

  const uaClass = classifyUserAgent(ua);
  // 검색봇은 역방향 DNS, AI 검색봇은 운영사 공개 IP 목록으로 진짜인지 본다. AI 학습봇은 확인할 것 없이 막는다.
  const search = uaClass.kind === "search" ? await checkSearchBot(ip, uaClass.engine)
    : uaClass.kind === "ai" && uaClass.purpose === "assist" ? { result: checkAiBot(ip, uaClass.agent), host: undefined }
    : undefined;
  const pass = request.cookies.get(PASS_COOKIE)?.value;

  if (path === TRAP_PATH || path.startsWith(`${TRAP_PATH}/`)) {
    // 확인된 검색봇은 robots.txt 를 지키므로 여기 올 일이 없다. 와도 표시하지 않는다.
    if (search?.result !== "verified") {
      if (MODE === "enforce") guard.trap(ip, pass);
      record({ action: "pass", note: "trap" }, { ip, ua, request, pass, ptr: search?.host });
    }
    return plain(404, "Not Found");
  }

  const kind = requestKind(request);
  const verdict = guard.decide({ ip, ua: uaClass, kind, path: pagePath(request), pass, searchCheck: search?.result });
  if (verdict.action !== "pass") record(verdict, { ip, ua, request, pass, kind, ptr: search?.host });
  if (MODE === "observe") return NextResponse.next();
  return respond(verdict, ip);
}

function adminGate(request: NextRequest) {
  const result = checkBasicAuth(request.headers.get("authorization"));
  if (result.ok) return NextResponse.next();
  return new NextResponse(result.message, {
    status: result.status,
    headers: result.status === 401
      ? { "WWW-Authenticate": 'Basic realm="soop-lol admin", charset="UTF-8"' }
      : undefined,
  });
}

/**
 * 요청 종류. 헤더는 요청자가 마음대로 붙일 수 있다 — 그래서 종류마다 **할인이 아니라 별도 한도**를 준다.
 * 미리 받기 헤더를 붙여도 본 한도가 싸지지 않고, 미리 받기 한도 안에서만 받는다.
 */
function requestKind(request: NextRequest): RequestKind {
  if (request.method === "POST" && request.headers.has("next-action")) return "action";
  if (request.headers.has("next-router-prefetch")) return "prefetch";
  if (request.headers.get("rsc") === "1") return "rsc";
  return "page";
}

/** 순회 수를 셀 주소 — Next 내부 캐시 키(_rsc)는 빼서 같은 화면을 한 번으로 센다. */
function pagePath(request: NextRequest): string {
  const params = new URLSearchParams(request.nextUrl.search);
  params.delete("_rsc");
  const q = params.toString();
  return q ? `${request.nextUrl.pathname}?${q}` : request.nextUrl.pathname;
}

const plain = (status: number, body: string, headers: Record<string, string> = {}) =>
  new NextResponse(body, { status, headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8", ...headers } });

function respond(verdict: Verdict, ip: string): NextResponse {
  switch (verdict.action) {
    case "pass":
      return NextResponse.next();
    case "block":
      return plain(403, "접근이 차단되었습니다. 자동화된 수집은 이용약관으로 금지되어 있습니다. 잘못 막혔다면 문의해 주세요.");
    case "limit":
      return plain(429, "요청이 너무 많습니다. 잠시 뒤 다시 시도해 주세요.", { "Retry-After": String(verdict.retryAfter) });
    case "challenge": {
      // 429 로 보낸다 — 사람 브라우저는 화면의 스크립트가 통과시키고, 수집기·검색봇은 속도를 줄인다.
      const { challenge, bits } = guard.issueChallenge(ip);
      return new NextResponse(challengePage(challenge, bits), {
        status: 429, headers: { "Cache-Control": "no-store", "Content-Type": "text/html; charset=utf-8", "Retry-After": "5" },
      });
    }
  }
}

function redeem(request: NextRequest, ip: string, ua: string | null): NextResponse {
  const q = request.nextUrl.searchParams;
  const result = guard.redeem(ip, q.get("c") ?? "", q.get("n") ?? "");
  if (!result.ok) {
    record({ action: "block", reason: `redeem-${result.reason}` }, { ip, ua, request });
    return new NextResponse(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  // 한 IP 가 쿠키를 많이 받아 가는 것은 막지 않고(공유망) 기록만 한다 — 난이도는 bot-guard 가 올린다.
  if (result.mints > GUARD_LIMITS.mintFreePerIpDay) record({ action: "pass", note: `mint-${result.mints}` }, { ip, ua, request });
  const response = new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  response.cookies.set(PASS_COOKIE, result.cookie, {
    httpOnly: true, sameSite: "lax", path: "/",
    secure: PRODUCTION,
    maxAge: Math.floor(GUARD_LIMITS.passTtlMs / 1000),
  });
  return response;
}

/**
 * 증거 기록 — 막은 것·막을 뻔한 것(observe)·함정·쿠키 다량 발급. JSON 한 줄씩.
 * 같은 IP·사유는 분당 30줄까지만 쓰고, 넘친 수는 다음 줄의 suppressed 에 합친다 — 몰려와도 디스크가 안 넘치고 횟수는 남는다.
 * ★ 이 기록은 "누가 언제 무엇을 얼마나 요청했나"의 운영 기록이다. 그 자체로 복제를 입증하지는 않는다.
 * ★ IP·UA 를 담으므로 개인정보처리방침의 '접속 기록' 항목·보관 기간과 같이 간다.
 */
const logWindow = new Map<string, { minute: number; n: number; suppressed: number }>();
function record(verdict: Verdict, ctx: { ip: string | null; ua: string | null; request: NextRequest; pass?: string; kind?: RequestKind; ptr?: string }) {
  const reason = verdict.action === "pass" ? verdict.note ?? "pass" : verdict.reason;
  const key = `${reason}|${ctx.ip}`, minute = Math.floor(Date.now() / 60_000);
  let w = logWindow.get(key);
  if (!w || w.minute !== minute) { w = { minute, n: 0, suppressed: w?.suppressed ?? 0 }; logWindow.set(key, w); }
  if (logWindow.size > 20_000) logWindow.delete(logWindow.keys().next().value!);
  if (++w.n > 30) { w.suppressed++; return; }
  const line = JSON.stringify({
    ts: new Date().toISOString(), mode: MODE, action: verdict.action, reason,
    ip: ctx.ip, ptr: ctx.ptr, pass: guard.passId(ctx.pass)?.slice(0, 8), kind: ctx.kind,
    method: ctx.request.method, path: ctx.request.nextUrl.pathname + ctx.request.nextUrl.search,
    ua: (ctx.ua ?? "").slice(0, 300), referer: ctx.request.headers.get("referer")?.slice(0, 300),
    suppressed: w.suppressed || undefined,
  });
  w.suppressed = 0;
  if (LOG_FILE) appendFile(LOG_FILE, line + "\n").catch((error) => warnOnce("log-file", `[bot-guard] 기록 파일 쓰기 실패: ${error}`));
  else console.warn(`[bot-guard] ${line}`);
}

const warned = new Set<string>();
function warnOnce(key: string, message: string) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}
