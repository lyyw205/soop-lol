import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { inRanges, parseFeed } from "./bot-guard-ai.ts";
import { BotGuard, Buckets, classifyUserAgent, clientIp, GUARD_LIMITS, hasLeadingZeroBits, isInternalIp, normalizeIp, type GuardRequest } from "./bot-guard.ts";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const browser = classifyUserAgent(CHROME);
const T0 = Date.UTC(2026, 9, 15, 3); // KST 12:00

function solve(challenge: string, bits: number): string {
  for (let n = 0; ; n++) {
    if (hasLeadingZeroBits(createHash("sha256").update(`${challenge}:${n}`).digest(), bits)) return String(n);
  }
}
function passCookie(guard: BotGuard, ip: string): string {
  const { challenge, bits } = guard.issueChallenge(ip);
  const r = guard.redeem(ip, challenge, solve(challenge, bits));
  assert.ok(r.ok);
  return r.cookie;
}
const page = (ip: string, path = "/lol", extra: Partial<GuardRequest> = {}): GuardRequest => ({ ip, ua: browser, kind: "page", path, ...extra });

test("UA 분류: 브라우저·도구·검색봇·수집봇·미리보기·AI(학습/요청형)·낯선 UA", () => {
  assert.equal(browser.kind, "browser");
  assert.equal(classifyUserAgent("").kind, "tool");
  assert.equal(classifyUserAgent("curl/8.5.0").kind, "tool");
  assert.equal(classifyUserAgent("python-requests/2.32").kind, "tool");
  assert.equal(classifyUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0 Safari/537.36").kind, "tool");
  assert.deepEqual(classifyUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), { kind: "search", engine: "google" });
  assert.deepEqual(classifyUserAgent("Mozilla/5.0 (compatible; Yeti/1.1; +http://naver.me/spd)"), { kind: "search", engine: "naver" });
  assert.equal(classifyUserAgent("Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)").kind, "harvest");
  assert.deepEqual(classifyUserAgent("Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"), { kind: "ai", purpose: "training" });
  assert.deepEqual(classifyUserAgent("Mozilla/5.0 (compatible; ChatGPT-User/1.0; +https://openai.com/bot)"), { kind: "ai", purpose: "assist", agent: "chatgpt-user" });
  assert.deepEqual(classifyUserAgent("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot)"), { kind: "ai", purpose: "assist", agent: "oai-searchbot" });
  assert.deepEqual(classifyUserAgent("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)"), { kind: "ai", purpose: "assist", agent: "perplexitybot" });
  assert.deepEqual(classifyUserAgent("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"), { kind: "ai", purpose: "training" });
  assert.deepEqual(classifyUserAgent("CCBot/2.0 (https://commoncrawl.org/faq/)"), { kind: "ai", purpose: "training" });
  assert.equal(classifyUserAgent("facebookexternalhit/1.1;kakaotalk-scrap/1.0").kind, "preview");
  assert.equal(classifyUserAgent("Mozilla/5.0 (compatible; SomeRandomBot/1.0)").kind, "bot");
  // 브라우저 모양이 아닌 정체 불명 UA 는 막지 않고 확인 단계 대상.
  assert.equal(classifyUserAgent("SomeInAppBrowser/3.1").kind, "odd");
  // 다음 앱 안의 사람 브라우저는 다음 검색봇이 아니다.
  assert.equal(classifyUserAgent(`${CHROME} DaumApps/8.0`).kind, "browser");
});

test("IP: XFF 맨 오른쪽, IPv6 정규화, 잘못된 값은 null, 내부 주소 판정", () => {
  const headers = new Map([["x-forwarded-for", "6.6.6.6, 1.2.3.4"], ["cf-connecting-ip", "9.9.9.9"]]);
  const get = (name: string) => headers.get(name) ?? null;
  assert.equal(clientIp(get, ""), "1.2.3.4");
  assert.equal(clientIp(get, "CF-Connecting-IP"), "9.9.9.9");
  assert.equal(clientIp(() => "::ffff:5.6.7.8", ""), "5.6.7.8");
  assert.equal(clientIp(() => "not-an-ip", ""), null);
  assert.equal(clientIp(() => null, ""), null);
  assert.equal(normalizeIp("2001:4860:4801:0010:0000:0000:0000:0001"), "2001:4860:4801:10::1");
  assert.equal(normalizeIp("2001:4860:4801:10::1"), "2001:4860:4801:10::1");
  assert.equal(normalizeIp("[2001:DB8::1]"), "2001:db8::1");
  assert.ok(isInternalIp("127.0.0.1") && isInternalIp("172.18.0.3") && !isInternalIp("172.32.0.1") && !isInternalIp("1.2.3.4"));
});

test("버킷: 순간 한도를 넘으면 막히고 시간이 지나면 풀린다, 하루 한도는 KST 자정까지", () => {
  const buckets = new Buckets();
  const limit = { burst: 3, perMinute: 6, perDay: 5 };
  for (let i = 0; i < 3; i++) assert.equal(buckets.take("a", limit, 1, T0).ok, true);
  const burst = buckets.take("a", limit, 1, T0);
  assert.equal(!burst.ok && burst.reason, "burst");
  assert.equal(buckets.take("a", limit, 1, T0 + 10_000).ok, true);  // 10초 = 1개 회복
  assert.equal(buckets.take("a", limit, 1, T0 + 20_000).ok, true);  // 하루 5번째
  const day = buckets.take("a", limit, 1, T0 + 60_000);
  assert.equal(!day.ok && day.reason, "day");
  assert.equal(!day.ok && day.retryAfter, 12 * 3600 - 60);          // KST 자정까지
  assert.equal(buckets.take("a", limit, 1, T0 + 12 * 3600_000).ok, true);
});

test("잘못된 쿠키·확인 값은 예외 없이 무효 — 한글·긴 값·모양 틀림·위조", () => {
  const guard = new BotGuard(Buffer.alloc(32, 9), () => T0);
  const good = passCookie(guard, "1.1.1.1");
  for (const bad of ["", "가".repeat(40), "x".repeat(5000), good.replace(/\.[^.]+$/, ".가나다라마바사아자차카타파하가나다라마바사아"),
    good.slice(0, -1) + (good.endsWith("A") ? "B" : "A"), good.replace(".", ".."), "a.b.c"]) {
    assert.doesNotThrow(() => guard.passId(bad));
    assert.equal(guard.passId(bad), null, bad.slice(0, 20));
    assert.doesNotThrow(() => guard.decide(page("2.2.2.2", "/lol", { pass: bad })));
  }
  for (const [c, n] of [["가.나.다.라.마", "1"], ["x".repeat(500), "1"], ["", ""], ["a.b.c.d.e", "1e9"]]) {
    assert.doesNotThrow(() => guard.redeem("1.1.1.1", c!, n!));
    assert.equal(guard.redeem("1.1.1.1", c!, n!).ok, false);
  }
});

test("쿠키 없는 IP 가 한도를 넘으면 화면은 확인 단계, RSC·액션·미리 받기는 확인 화면 없이 429", () => {
  const guard = new BotGuard(Buffer.alloc(32, 1), () => T0);
  for (let i = 0; i < GUARD_LIMITS.anon.burst; i++) assert.equal(guard.decide(page("1.1.1.1", `/lol/s/a${i % 20}`)).action, "pass");
  assert.equal(guard.decide(page("1.1.1.1")).action, "challenge");
  assert.equal(guard.decide(page("1.1.1.1", "/lol", { kind: "rsc" })).action, "limit");
  // 액션·미리 받기는 본 한도와 따로 센다 — 화면 한도를 다 써도 액션은 된다.
  assert.equal(guard.decide(page("1.1.1.1", "/lol", { kind: "action" })).action, "pass");
  assert.equal(guard.decide(page("1.1.1.1", "/lol", { kind: "prefetch" })).action, "pass");
  assert.equal(guard.decide(page("2.2.2.2")).action, "pass");
});

test("미리 받기 헤더를 붙여도 본 한도가 싸지지 않는다 — 별도 한도 안에서만", () => {
  const guard = new BotGuard(Buffer.alloc(32, 5), () => T0);
  let passed = 0;
  for (let i = 0; i < 1000; i++) if (guard.decide(page("3.3.3.3", `/lol/s/${i}`, { kind: "prefetch" })).action === "pass") passed++;
  assert.equal(passed, GUARD_LIMITS.prefetch.burst);
  // 속도를 지켜도 서로 다른 주소는 하루 distinctPrefetch 까지.
  let now = T0, last = "pass";
  const slow = new BotGuard(Buffer.alloc(32, 8), () => now);
  for (let i = 0; i <= GUARD_LIMITS.distinctPrefetch && last === "pass"; i++) {
    now += 1000;
    last = slow.decide(page("3.3.3.4", `/lol/s/${i}`, { kind: "prefetch" })).action;
  }
  assert.equal(last, "limit");
});

test("공유 IP: IP 가 한도를 넘어도 확인을 푼 사람은 각자 쿠키로 계속 본다 — 쿠키 발급은 막지 않고 난이도만 오른다", () => {
  let now = T0;
  const guard = new BotGuard(Buffer.alloc(32, 2), () => now);
  for (let i = 0; i < GUARD_LIMITS.anon.burst + 5; i++) guard.decide(page("100.64.0.1", `/lol/s/${i}`));
  assert.equal(guard.decide(page("100.64.0.1")).action, "challenge");
  const bits: number[] = [];
  for (let person = 0; person < 60; person++) {
    const { challenge, bits: b } = guard.issueChallenge("100.64.0.1");
    bits.push(b);
    const r = guard.redeem("100.64.0.1", challenge, solve(challenge, b));
    assert.ok(r.ok, `사람 ${person + 1} 이 쿠키를 못 받았다`);
    assert.equal(guard.decide(page("100.64.0.1", "/lol", { pass: r.cookie })).action, "pass");
  }
  assert.equal(bits[0], GUARD_LIMITS.challengeBits);
  assert.ok(bits.at(-1)! > GUARD_LIMITS.challengeBits && bits.at(-1)! <= GUARD_LIMITS.challengeBitsMax);
});

test("순회: 같은 화면 새로고침은 한 번으로 세고, 서로 다른 기록을 한도 넘게 훑으면 그날 429", () => {
  let now = T0;
  const guard = new BotGuard(Buffer.alloc(32, 6), () => now);
  const cookie = passCookie(guard, "4.4.4.4");
  // 같은 화면 300번(속도 한도에 안 걸리게 2초 간격) — 막히지 않는다.
  for (let i = 0; i < 300; i++) { now += 2000; assert.equal(guard.decide(page("4.4.4.4", "/lol/s/same", { pass: cookie })).action, "pass"); }
  let last = guard.decide(page("4.4.4.4", "/lol/s/0", { pass: cookie }));
  for (let i = 1; i <= GUARD_LIMITS.distinctPass + 1 && last.action === "pass"; i++) {
    now += 2000;
    last = guard.decide(page("4.4.4.4", `/lol/versus/${i}`, { pass: cookie }));
  }
  assert.equal(last.action, "limit");
  assert.equal(last.action === "limit" && last.reason, "pass-traversal");
  // 다음 날은 풀린다.
  now = T0 + 24 * 3600_000;
  assert.equal(guard.decide(page("4.4.4.4", "/lol/versus/new", { pass: cookie })).action, "pass");
});

test("함정은 막지 않는다 — 그 쿠키는 무효, 그 IP 는 쿠키 없이 들어오면 확인 단계(사람은 다시 통과)", () => {
  let now = T0;
  const guard = new BotGuard(Buffer.alloc(32, 3), () => now);
  const cookie = passCookie(guard, "5.5.5.5");
  guard.trap("5.5.5.5", cookie);
  assert.equal(guard.decide(page("5.5.5.5", "/lol", { pass: cookie })).action, "challenge");
  assert.equal(guard.decide(page("5.5.5.5")).action, "challenge");
  // 확인을 다시 풀면 새 쿠키로 정상 이용.
  const fresh = passCookie(guard, "5.5.5.5");
  assert.equal(guard.decide(page("5.5.5.5", "/lol", { pass: fresh })).action, "pass");
  // 다른 IP 는 영향 없다. 하루 지나면 의심도 풀린다.
  assert.equal(guard.decide(page("6.6.6.6")).action, "pass");
  now += GUARD_LIMITS.suspectMs + 1;
  assert.equal(guard.decide(page("5.5.5.5")).action, "pass");
});

test("확인 문제: 재사용·다른 IP·만료는 거절", () => {
  let now = T0;
  const guard = new BotGuard(Buffer.alloc(32, 7), () => now);
  const { challenge, bits } = guard.issueChallenge("1.1.1.1");
  const nonce = solve(challenge, bits);
  assert.equal(guard.redeem("3.3.3.3", challenge, nonce).ok, false);
  assert.equal(guard.redeem("1.1.1.1", challenge, nonce).ok, true);
  assert.equal(guard.redeem("1.1.1.1", challenge, nonce).ok, false);
  const late = guard.issueChallenge("1.1.1.1");
  now += GUARD_LIMITS.challengeTtlMs + 1;
  assert.equal(guard.redeem("1.1.1.1", late.challenge, solve(late.challenge, late.bits)).ok, false);
});

test("검색봇: 가짜는 403, 확인된 것은 순회 한도 없음, 확인 못 한 것은 일반 한도(확인 화면 대신 429), 도구 UA 403, 낯선 UA 는 확인 단계", () => {
  const guard = new BotGuard(Buffer.alloc(32, 4), () => T0);
  const google = classifyUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)");
  assert.equal(guard.decide(page("7.7.7.7", "/lol", { ua: google, searchCheck: "fake" })).action, "block");
  for (let i = 0; i < GUARD_LIMITS.search.burst; i++) {
    assert.equal(guard.decide(page("66.249.66.1", `/lol/s/${i}`, { ua: google, searchCheck: "verified" })).action, "pass");
  }
  for (let i = 0; i < GUARD_LIMITS.anon.burst; i++) guard.decide(page("8.8.4.4", "/lol", { ua: google, searchCheck: "unknown" }));
  assert.equal(guard.decide(page("8.8.4.4", "/lol", { ua: google, searchCheck: "unknown" })).action, "limit");
  assert.equal(guard.decide(page("9.9.9.9", "/lol", { ua: classifyUserAgent("curl/8") })).action, "block");
  assert.equal(guard.decide(page("9.9.9.10", "/lol", { ua: classifyUserAgent("SomeInAppBrowser/3.1") })).action, "challenge");
});

test("AI: 학습봇은 403, 검색·답변봇은 목록으로 확인되면 검색봇 한도·아니면 일반 한도(막지 않음)", () => {
  const guard = new BotGuard(Buffer.alloc(32, 10), () => T0);
  const gpt = classifyUserAgent("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)");
  assert.deepEqual(guard.decide(page("20.0.0.1", "/lol", { ua: gpt })), { action: "block", reason: "ai-training" });
  const search = classifyUserAgent("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot)");
  for (let i = 0; i < GUARD_LIMITS.anon.burst + 20; i++) {
    assert.equal(guard.decide(page("20.0.0.2", `/lol/s/${i}`, { ua: search, searchCheck: "verified" })).action, "pass");
  }
  // 목록에 없는 IP 의 같은 UA: 막지 않고 일반 방문자처럼 — 넘으면 확인 화면 대신 429.
  assert.equal(guard.decide(page("20.0.0.3", "/lol", { ua: search, searchCheck: "unknown" })).action, "pass");
  for (let i = 0; i < GUARD_LIMITS.anon.burst; i++) guard.decide(page("20.0.0.3", `/lol/s/${i}`, { ua: search, searchCheck: "unknown" }));
  assert.equal(guard.decide(page("20.0.0.3", "/lol", { ua: search, searchCheck: "unknown" })).action, "limit");
});

test("AI 검색봇 공개 IP 목록 해석: IPv4·IPv6 범위, 잘못된 항목은 버린다", () => {
  const ranges = parseFeed({ prefixes: [{ ipv4Prefix: "104.210.140.128/28" }, { ipv6Prefix: "2a03:2880:f800::/48" }, { ipv4Prefix: "garbage" }, {}] });
  assert.equal(ranges.length, 2);
  assert.ok(inRanges("104.210.140.130", ranges));
  assert.ok(!inRanges("104.210.140.144", ranges));
  assert.ok(inRanges("2a03:2880:f800:1::5", ranges));
  assert.ok(!inRanges("2a03:2880:f801::5", ranges));
  assert.deepEqual(parseFeed({ nope: 1 }), []);
  assert.deepEqual(parseFeed(null), []);
});
