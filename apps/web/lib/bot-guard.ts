import { createHash, createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

/**
 * 봇 차단 — **사람은 막지 않고, 기록을 긁어 가는 자동 수집만 막고 남긴다.** 판정은 이 파일 한 곳이다(`proxy.ts` 가 부른다).
 *
 * 원칙(2026-10-15, Codex 검토 반영):
 *  - 사람·검색엔진의 접근이 수집 차단보다 먼저다. 판정이 애매하면 통과시키고 기록한다.
 *  - 한 가지 신호(IP·UA·함정)만으로 오래 막지 않는다. 사람이 걸릴 수 있는 신호는 "확인 단계"로만 이어진다.
 *    확인 단계는 브라우저가 1초 안에 혼자 푸는 계산이다 — 사람 증명이 아니라 **스크립트를 못 돌리는 수집기를 거르고,
 *    수집 비용을 올리는** 장치다.
 *  - 공개 페이지를 완전히 못 가져가게 할 수는 없다(검색엔진이 읽는 페이지는 헤드리스 브라우저도 읽는다).
 *    대신 **한 주체가 하루에 순회할 수 있는 서로 다른 기록 수**를 묶는다. 사람은 하루 수십 쪽, 전체를 긁으려면 수천 쪽이다.
 *  - 막은 것·막을 뻔한 것은 전부 증거 기록으로 남긴다(`proxy.ts` 의 기록). 약관 5조·개인정보처리방침과 같이 간다.
 *
 * 확실한 것(사람이 절대 보내지 않는 요청)만 바로 403:
 *   빈 UA·HTTP 라이브러리·헤드리스 브라우저 UA, SEO 수집봇, 정체 불명 봇 UA, 역방향 DNS 로 가짜가 드러난 검색봇
 * 사람도 걸릴 수 있는 것은 확인 단계 또는 짧은 429:
 *   IP 의 속도·순회 초과(공유망 — 확인을 통과하면 각자 쿠키로 따로 센다), 낯선 UA, 함정을 밟은 IP
 * 통과 쿠키(=확인을 푼 브라우저 하나)의 순회 초과는 그날 429 — 사람이 하루에 수백 개의 다른 기록을 보지는 않는다.
 *
 * ★ 상태는 프로세스 메모리다. 배포는 EC2 한 대·`next start` 한 프로세스(PLAN §8)라 맞다.
 *   프로세스를 여럿 띄우면 한도가 프로세스 수만큼 늘어난다 — 그때 공유 저장소로 옮긴다. 재시작하면 카운트가 0 이 된다.
 */

type Limit = { burst: number; perMinute: number; perDay: number };

export const GUARD_LIMITS = {
  /** 쿠키 없는 IP 의 화면 요청. 넘으면 확인 단계(공유망 사람은 여기서 각자 쿠키를 받는다). */
  anon: { burst: 60, perMinute: 30, perDay: 3000 } satisfies Limit,
  /** 통과 쿠키 하나의 화면 요청. 속도만 묶는다 — 넘으면 몇 초짜리 429. 하루 총량은 서버 보호용으로 넉넉히. */
  pass: { burst: 90, perMinute: 45, perDay: 5000 } satisfies Limit,
  /** 링크 미리 받기. 화면의 링크마다 생겨 따로 센다(본 한도를 깎지 않는다). 확인 단계는 안 띄운다. */
  prefetch: { burst: 150, perMinute: 90, perDay: 6000 } satisfies Limit,
  /** 서버 액션(더 보기·일정 넘기기). 화면을 연 뒤에 생기므로 확인 단계 없이 429 만. */
  action: { burst: 30, perMinute: 20, perDay: 2000 } satisfies Limit,
  /** 역방향 DNS 로 확인된 검색봇 IP. 막지는 않고 DB 를 지킬 만큼만. 순회 한도 없음. */
  search: { burst: 120, perMinute: 600, perDay: Number.POSITIVE_INFINITY } satisfies Limit,
  /** 하루(KST)에 볼 수 있는 서로 다른 화면 수. 쿠키 없는 IP 는 넘으면 확인 단계, 쿠키는 넘으면 그날 429. */
  distinctAnon: 150,
  distinctPass: 600,
  /**
   * 미리 받기로 받은 서로 다른 주소 수. 사람은 화면마다 링크 수십 개가 미리 받아져 많지만, 이 헤더를 꾸며
   * 본 한도를 피하는 수집기도 여기서 묶인다(운영 빌드의 미리 받기 응답에 데이터가 얼마나 실리는지와 무관하게).
   */
  distinctPrefetch: 2000,
  /** 함정을 밟은 IP·쿠키를 "의심"으로 두는 시간. 의심 IP 는 쿠키 없이는 확인 단계를 거친다(막지는 않는다). */
  suspectMs: 24 * 3600_000,
  /** 작업증명 난이도(sha256 앞 0 비트). 16 → 평균 6만5천 번, 브라우저 0.5~1초. */
  challengeBits: 16,
  /** 한 IP 가 하루에 쿠키를 이만큼 넘게 받으면 난이도가 오른다(상한은 거절이 아니라 더 오래 걸리는 것). */
  mintFreePerIpDay: 20,
  challengeBitsMax: 20,
  challengeTtlMs: 5 * 60_000,
  passTtlMs: 7 * 24 * 3600_000,
} as const;

export type RequestKind = "page" | "rsc" | "prefetch" | "action";

export const PASS_COOKIE = "ss_pass";
/** 함정 주소. robots.txt 가 금지하고 사람에겐 보이지 않는 링크로만 닿는다. */
export const TRAP_PATH = "/data/export";
/** 확인 단계가 작업증명을 제출하는 주소. proxy 가 직접 받는다. */
export const VERIFY_PATH = "/__guard/verify";

// ---------------------------------------------------------------------------
// 요청 분류

/** 사람 브라우저가 보내지 않는 UA. */
const TOOL_UA = /curl|wget|python|httpx|aiohttp|scrapy|go-http-client|java\/|okhttp|libwww|lwp::|node-fetch|axios|undici|headlesschrome|phantomjs|puppeteer|playwright|selenium|webdriver|httpclient|postmanruntime|insomnia|colly|mechanize|guzzle|ruby|perl|php\//i;
/** 검색 유입이 없는 SEO·데이터 수집봇. robots.txt 에도 적지만 안 지키는 놈들이 있어 여기서도 막는다. */
const HARVEST_UA = /ahrefs|semrush|mj12bot|dotbot|blexbot|serpstat|dataforseo|megaindex|seekport|petalbot|bytespider|imagesift|barkrowler|zoominfo|sogou|mauibot|magpie-crawler/i;
/** 링크 공유 미리보기(카톡·디스코드 …). 마케팅 경로라 막지 않는다 — 일반 방문자 한도로 센다. */
const PREVIEW_UA = /kakaotalk-scrap|facebookexternalhit|twitterbot|slackbot|discordbot|telegrambot|whatsapp|linkedinbot|skypeuripreview|bluesky|mastodon/i;
/**
 * AI 봇 — **AI 검색·답변(GEO)은 열고, 학습용 수집은 막는다**(2026-10-15 운영자 결정).
 *  - 학습용: 기록을 통째로 가져가 모델에 넣는다 = 복제. robots.txt 로 금지하고, 무시하고 오면 403.
 *  - 검색·답변용: 사용자의 질문에 답하려고 페이지를 읽고 출처로 우리를 건다 = 검색 유입.
 *    공개 IP 목록이 있는 봇(OpenAI·Perplexity)은 목록으로 진짜를 확인해 검색봇 한도를 준다(`bot-guard-ai.ts`).
 *    목록에 없거나 목록이 없는 봇(Claude 등)은 막지 않고 일반 방문자 한도로 센다 — 이 UA 를 꾸며도 얻는 게 없다.
 * ★ Google-Extended·Applebot-Extended 는 UA 가 아니라 robots.txt 전용 이름이다(구글 검색·AI 개요는 Googlebot 이 읽는다).
 */
const AI_TRAINING_UA = /gptbot|claudebot|anthropic-ai|ccbot|meta-externalagent|cohere-training-data-crawler|amazonbot|diffbot|omgili|timpibot|img2dataset|ai2bot|pangubot/i;
export type AiAgent = "oai-searchbot" | "chatgpt-user" | "perplexitybot" | "perplexity-user" | "claude-searchbot" | "claude-user" | "other";
const AI_ASSIST: [RegExp, AiAgent][] = [
  [/oai-searchbot/i, "oai-searchbot"], [/chatgpt-user/i, "chatgpt-user"],
  [/perplexity-user/i, "perplexity-user"], [/perplexitybot/i, "perplexitybot"],
  [/claude-searchbot/i, "claude-searchbot"], [/claude-user/i, "claude-user"],
  [/duckassistbot|mistralai-user|youbot/i, "other"],
];
const GENERIC_BOT_UA = /bot\b|bot\/|crawler|spider|scraper|fetcher|archiver|\bscan/i;

export type SearchEngine = "google" | "bing" | "naver" | "daum" | "apple";
/** UA 의 자칭 → 역방향 DNS 가 끝나야 할 도메인. 비어 있으면 확인할 방법이 없는 엔진(가짜 판정 안 함). */
export const SEARCH_ENGINES: Record<SearchEngine, { ua: RegExp; hosts: readonly string[] }> = {
  // googleusercontent.com 은 넣지 않는다 — GCP 고객 VM 도 그 이름을 받는다.
  google: { ua: /googlebot|google-inspectiontool|googleother|storebot-google|adsbot-google|mediapartners-google|apis-google/i, hosts: [".googlebot.com", ".google.com"] },
  bing: { ua: /bingbot|bingpreview|adidxbot|msnbot/i, hosts: [".search.msn.com"] },
  // 네이버 안내: crawl.125-209-235-169.web.naver.com 처럼 .naver.com 으로 끝나고 정방향으로 같은 IP.
  naver: { ua: /yeti/i, hosts: [".naver.com"] },
  // 다음은 공식 확인 방법을 못 찾았다(2026-10-15). 가짜로 몰지 않고 일반 방문자 한도로 둔다 —
  // 한도를 넘으면 429 라 진짜 수집기는 속도를 줄여 다시 온다. 기록의 PTR 을 보고 채운다.
  // ★ 다음 앱(DaumApps) 안의 사람 브라우저와 섞이지 않게 "Daum/숫자" 만 본다.
  daum: { ua: /daumoa|\bdaum\/\d/i, hosts: [] },
  apple: { ua: /applebot(?!-extended)/i, hosts: [".applebot.apple.com"] },
};

export type UaClass =
  | { kind: "browser" }
  /** 브라우저 모양이 아닌데 정체도 모르는 UA — 막지 않고 확인 단계를 요구한다(드문 앱 내 브라우저일 수 있다). */
  | { kind: "odd" }
  | { kind: "tool" }
  | { kind: "harvest" }
  | { kind: "preview" }
  | { kind: "ai"; purpose: "training" }
  | { kind: "ai"; purpose: "assist"; agent: AiAgent }
  | { kind: "search"; engine: SearchEngine }
  | { kind: "bot" };

/** 순서가 판정이다 — 검색엔진·AI 봇 UA 에도 "bot" 이 들어 있으므로 일반 봇 규칙은 맨 끝. */
export function classifyUserAgent(ua: string | null | undefined): UaClass {
  const s = (ua ?? "").trim();
  if (!s) return { kind: "tool" };
  if (AI_TRAINING_UA.test(s)) return { kind: "ai", purpose: "training" };
  for (const [re, agent] of AI_ASSIST) if (re.test(s)) return { kind: "ai", purpose: "assist", agent };
  for (const [engine, spec] of Object.entries(SEARCH_ENGINES) as [SearchEngine, typeof SEARCH_ENGINES[SearchEngine]][]) {
    if (spec.ua.test(s)) return { kind: "search", engine };
  }
  if (HARVEST_UA.test(s)) return { kind: "harvest" };
  if (PREVIEW_UA.test(s)) return { kind: "preview" };
  if (TOOL_UA.test(s)) return { kind: "tool" };
  if (GENERIC_BOT_UA.test(s)) return { kind: "bot" };
  // 진짜 브라우저 UA 는 거의 언제나 "Mozilla/5.0 (" 로 시작한다.
  if (!/^Mozilla\/5\.0 \(/.test(s)) return { kind: "odd" };
  return { kind: "browser" };
}

/** IP 표기를 하나로. IPv6 는 압축·소문자 정규형(같은 주소를 다르게 써서 한도·DNS 확인이 갈리지 않게). 잘못된 값은 null. */
export function normalizeIp(raw: string | null | undefined): string | null {
  let ip = raw?.trim();
  if (!ip) return null;
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(ip)) ip = ip.slice(7);
  const v = isIP(ip);
  if (v === 4) return ip;
  if (v === 6) {
    try { return new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return null; }
  }
  return null;
}

/**
 * 손님 IP. 기본은 X-Forwarded-For 의 **맨 오른쪽** — 우리 앞의 Caddy 가 붙인 값이다. 왼쪽 값은 손님이 마음대로 넣는다.
 * ★ 이 값을 믿으려면 요청이 정말 Caddy 를 거쳐 왔어야 한다 — `proxy.ts` 가 BOT_GUARD_PROXY_TOKEN 으로 확인한다.
 * ★ CDN 을 앞에 두면 맨 오른쪽이 CDN 주소가 된다 — BOT_GUARD_IP_HEADER=cf-connecting-ip 로 바꾼다.
 */
export function clientIp(get: (name: string) => string | null, header = process.env.BOT_GUARD_IP_HEADER): string | null {
  return normalizeIp(header ? get(header.toLowerCase()) : get("x-forwarded-for")?.split(",").at(-1));
}

/** 자기 자신·내부망. **개발에서만** 예외로 쓴다 — 운영에서 내부 주소로 보이면 Caddy 를 안 거친 것이다. */
export function isInternalIp(ip: string): boolean {
  return ip === "::1" || /^127\./.test(ip) || /^10\./.test(ip)
    || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip) || /^f[cd][0-9a-f]{2}:/i.test(ip);
}

/** 무거운 화면은 더 비싸게 센다(검색은 DB 를 넓게 훑는다). */
export function pathCost(path: string): number {
  return /\/search(\/|$)/.test(path) ? 3 : 1;
}

// ---------------------------------------------------------------------------
// 토큰 버킷 + 하루 한도

type Bucket = { tokens: number; at: number; day: number; used: number };

/** KST 날짜 번호. 하루 한도는 한국 자정에 풀린다. */
export function kstDay(now: number): number {
  return Math.floor((now + 9 * 3600_000) / 86_400_000);
}
const secondsToKstMidnight = (now: number) => Math.ceil(((kstDay(now) + 1) * 86_400_000 - 9 * 3600_000 - now) / 1000);

/** 오래 안 쓴 것부터 버리는 Map(삽입 순서 = 마지막 사용 순서). 버려진 키는 새로 시작해 한도가 느슨해지는 쪽으로만 틀린다. */
class Lru<V> {
  private readonly map = new Map<string, V>();
  private readonly max: number;
  constructor(max: number) { this.max = max; }
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) { this.map.delete(key); this.map.set(key, v); }
    return v;
  }
  set(key: string, v: V) {
    this.map.delete(key);
    this.map.set(key, v);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value!);
  }
  delete(key: string) { this.map.delete(key); }
}

export class Buckets {
  private readonly map: Lru<Bucket>;
  constructor(max = 100_000) { this.map = new Lru(max); }

  /** 비용을 뺄 수 있으면 ok. 못 빼면 왜 막혔는지와 다시 올 때까지 초. */
  take(key: string, limit: Limit, cost: number, now: number): { ok: true } | { ok: false; reason: "burst" | "day"; retryAfter: number } {
    const day = kstDay(now);
    const b = this.map.get(key) ?? { tokens: limit.burst, at: now, day, used: 0 };
    if (b.day !== day) { b.day = day; b.used = 0; }
    b.tokens = Math.min(limit.burst, b.tokens + ((now - b.at) / 60_000) * limit.perMinute);
    b.at = now;
    this.map.set(key, b);
    if (b.used + cost > limit.perDay) return { ok: false, reason: "day", retryAfter: secondsToKstMidnight(now) };
    if (b.tokens < cost) return { ok: false, reason: "burst", retryAfter: Math.max(1, Math.ceil(((cost - b.tokens) / limit.perMinute) * 60)) };
    b.tokens -= cost;
    b.used += cost;
    return { ok: true };
  }
}

/**
 * 주체별 그날 본 서로 다른 화면 수. 같은 화면 새로고침은 한 번만 센다 — 자주 보는 사람과 전체를 순회하는 수집기를 가른다.
 * 한도를 넘은 뒤로는 더 담지 않아 메모리가 한도 × 주체 수를 넘지 않는다.
 */
class Distinct {
  private readonly map = new Lru<{ day: number; seen: Set<number> }>(50_000);
  /** 이번 화면을 더한 뒤의 수. */
  add(key: string, path: string, cap: number, now: number): number {
    const day = kstDay(now);
    let e = this.map.get(key);
    if (!e || e.day !== day) { e = { day, seen: new Set() }; this.map.set(key, e); }
    if (e.seen.size <= cap) e.seen.add(createHash("sha1").update(path).digest().readUInt32BE(0));
    return e.seen.size;
  }
}

/** 만료 시각이 있는 집합(의심 목록·쓴 확인 문제). */
class Expiring {
  private readonly map = new Lru<number>(100_000);
  add(key: string, until: number) { this.map.set(key, until); }
  has(key: string, now: number): boolean {
    const until = this.map.get(key);
    if (until === undefined) return false;
    if (until > now) return true;
    this.map.delete(key);
    return false;
  }
}

// ---------------------------------------------------------------------------
// 판정

export type Verdict =
  | { action: "pass"; note?: string }
  | { action: "block"; reason: string }
  | { action: "limit"; reason: string; retryAfter: number }
  | { action: "challenge"; reason: string };

export type GuardRequest = {
  ip: string;
  ua: UaClass;
  kind: RequestKind;
  /** 주소(쿼리 포함). 순회 수를 셀 때 쓴다. */
  path: string;
  /** 통과 쿠키 원문(없으면 undefined). */
  pass?: string;
  /** 검색봇 자칭이면 역방향 DNS, AI 검색봇 자칭이면 공개 IP 목록 결과. unknown = 확인할 방법이 없거나 확인이 실패했다. */
  searchCheck?: "verified" | "fake" | "unknown";
};

const b64url = (buf: Buffer) => buf.toString("base64url");
/** 통과 쿠키 모양: id(16) . 발급시각(36진) . 서명(22). 이 모양이 아니면 비교하지 않고 무효. */
const PASS_SHAPE = /^[A-Za-z0-9_-]{16}\.[0-9a-z]{6,10}\.[A-Za-z0-9_-]{22}$/;
const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{10}\.[0-9a-z]{6,10}\.[A-Za-z0-9_-]{12}\.[0-9]{2}\.[A-Za-z0-9_-]{22}$/;

/** 길이가 같은 ASCII 두 문자열의 상수시간 비교. 모양 검사를 통과한 값만 들어온다. */
function sameAscii(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export class BotGuard {
  private readonly buckets = { anon: new Buckets(), pass: new Buckets(), prefetch: new Buckets(), action: new Buckets(), search: new Buckets(10_000), mint: new Buckets() };
  private readonly distinct = new Distinct();
  private readonly suspect = new Expiring();
  private readonly usedChallenges = new Expiring();
  private readonly secret: Buffer;
  private readonly now: () => number;
  constructor(secret: Buffer, now: () => number = Date.now) { this.secret = secret; this.now = now; }

  private sign(...parts: string[]): string {
    return b64url(createHmac("sha256", this.secret).update(parts.join("|")).digest()).slice(0, 22);
  }
  private ipTag(ip: string): string {
    return this.sign("ip", ip).slice(0, 10);
  }

  /** 통과 쿠키를 검사해 쿠키 id 를 돌려준다. 모양이 틀리거나 위조·만료면 null — 예외를 던지지 않는다. */
  passId(cookie: string | undefined): string | null {
    if (!cookie || cookie.length > 64 || !PASS_SHAPE.test(cookie)) return null;
    const [id, issued, sig] = cookie.split(".") as [string, string, string];
    if (!sameAscii(sig, this.sign("pass", id, issued))) return null;
    const age = this.now() - parseInt(issued, 36);
    if (!(age >= -60_000 && age <= GUARD_LIMITS.passTtlMs)) return null;
    return id;
  }

  decide(req: GuardRequest): Verdict {
    const now = this.now();
    const { ua, kind } = req;
    // 1) 사람이 보내지 않는 요청 — 바로 막는다.
    if (ua.kind === "tool") return { action: "block", reason: "tool-ua" };
    if (ua.kind === "harvest") return { action: "block", reason: "harvest-ua" };
    if (ua.kind === "bot") return { action: "block", reason: "unknown-bot" };
    if (ua.kind === "ai" && ua.purpose === "training") return { action: "block", reason: "ai-training" };
    if (ua.kind === "search" && req.searchCheck === "fake") return { action: "block", reason: `fake-${ua.engine}` };

    // 2) 확인된 검색봇·AI 검색봇 — 서버 보호용 속도만.
    if ((ua.kind === "search" || ua.kind === "ai") && req.searchCheck === "verified") {
      const r = this.buckets.search.take(req.ip, GUARD_LIMITS.search, 1, now);
      return r.ok ? { action: "pass" } : { action: "limit", reason: "search-rate", retryAfter: r.retryAfter };
    }

    const id = this.passId(req.pass);
    const holder = id && !this.suspect.has(`pass:${id}`, now) ? id : null;
    const who = holder ? `pass:${holder}` : `ip:${req.ip}`;

    // 3) 미리 받기·서버 액션 — 따로 센다. 화면이 아니라 확인 단계는 띄우지 않는다(띄워도 앱이 못 보여 준다).
    if (kind === "prefetch" || kind === "action") {
      const r = this.buckets[kind].take(who, GUARD_LIMITS[kind], 1, now);
      if (!r.ok) return { action: "limit", reason: `${kind}-${r.reason}`, retryAfter: r.retryAfter };
      if (kind === "prefetch" && this.distinct.add(`prefetch|${who}`, req.path, GUARD_LIMITS.distinctPrefetch, now) > GUARD_LIMITS.distinctPrefetch) {
        return { action: "limit", reason: "prefetch-traversal", retryAfter: secondsToKstMidnight(now) };
      }
      return { action: "pass" };
    }

    // 4) 화면(첫 진입 HTML 또는 앱 안 이동 RSC).
    //    ★ RSC 에는 확인 화면 HTML 을 주지 않는다 — 429 를 받으면 Next 가 그 주소로 전체 이동을 하고,
    //      그 화면 요청이 확인 단계를 띄운 뒤 같은 주소(필터 포함)로 돌아온다.
    const gate = (reason: string): Verdict =>
      kind === "page" && ua.kind !== "preview" && ua.kind !== "ai" && ua.kind !== "search"
        ? { action: "challenge", reason }
        : { action: "limit", reason, retryAfter: 60 };
    const cost = pathCost(req.path);

    if (holder) {
      const r = this.buckets.pass.take(holder, GUARD_LIMITS.pass, cost, now);
      if (!r.ok) return { action: "limit", reason: `pass-${r.reason}`, retryAfter: r.retryAfter };
      const seen = this.distinct.add(who, req.path, GUARD_LIMITS.distinctPass, now);
      if (seen > GUARD_LIMITS.distinctPass) return { action: "limit", reason: "pass-traversal", retryAfter: secondsToKstMidnight(now) };
      return { action: "pass" };
    }
    // 쿠키 없음: 낯선 UA·의심 IP 는 먼저 확인 단계. 사람은 혼자 통과한다.
    if (ua.kind === "odd") return gate("odd-ua");
    if (this.suspect.has(`ip:${req.ip}`, now)) return gate("suspect-ip");
    if (id) return gate("suspect-pass");
    const r = this.buckets.anon.take(who, GUARD_LIMITS.anon, cost, now);
    if (!r.ok) return gate(`ip-${r.reason}`);
    const seen = this.distinct.add(who, req.path, GUARD_LIMITS.distinctAnon, now);
    if (seen > GUARD_LIMITS.distinctAnon) return gate("ip-traversal");
    return { action: "pass" };
  }

  /**
   * 함정을 밟았다. **막지 않는다** — 그 IP 와 쿠키를 하루 "의심"으로 둔다.
   * 의심 쿠키는 무효가 되고, 의심 IP 는 쿠키 없이 들어올 때 확인 단계를 거친다. 사람은 혼자 통과하고
   * 스크립트를 못 돌리는 수집기는 거기서 멈춘다. 증거는 proxy 의 기록에 남는다.
   */
  trap(ip: string, pass: string | undefined): void {
    const until = this.now() + GUARD_LIMITS.suspectMs;
    this.suspect.add(`ip:${ip}`, until);
    const id = this.passId(pass);
    if (id) this.suspect.add(`pass:${id}`, until);
  }

  /** 이 IP 가 오늘 받아 간 쿠키 수에 따른 난이도. 많이 받을수록 오래 걸린다(거절하지 않는다). */
  private bitsFor(ip: string): number {
    const used = this.mintCount(ip);
    const extra = Math.max(0, Math.floor((used - GUARD_LIMITS.mintFreePerIpDay) / 10) + (used >= GUARD_LIMITS.mintFreePerIpDay ? 1 : 0));
    return Math.min(GUARD_LIMITS.challengeBitsMax, GUARD_LIMITS.challengeBits + extra);
  }
  private readonly mints = new Lru<{ day: number; n: number }>(100_000);
  mintCount(ip: string): number {
    const e = this.mints.get(ip);
    return e && e.day === kstDay(this.now()) ? e.n : 0;
  }

  /** 확인 단계 문제. IP 에 묶고 서명한다 — 서버는 아무것도 저장하지 않는다. */
  issueChallenge(ip: string): { challenge: string; bits: number } {
    const ts = this.now().toString(36);
    const rand = b64url(randomBytes(9));
    const bits = String(this.bitsFor(ip)).padStart(2, "0");
    return { challenge: `${this.ipTag(ip)}.${ts}.${rand}.${bits}.${this.sign("ch", ip, ts, rand, bits)}`, bits: Number(bits) };
  }

  /** 작업증명을 확인하고 통과 쿠키 값을 만든다. 잘못된 입력은 예외 없이 거절한다. */
  redeem(ip: string, challenge: string, nonce: string): { ok: true; cookie: string; mints: number } | { ok: false; reason: string } {
    const now = this.now();
    if (challenge.length > 100 || !CHALLENGE_SHAPE.test(challenge) || !/^\d{1,12}$/.test(nonce)) return { ok: false, reason: "format" };
    const [tag, ts, rand, bits, sig] = challenge.split(".") as [string, string, string, string, string];
    if (!sameAscii(tag, this.ipTag(ip)) || !sameAscii(sig, this.sign("ch", ip, ts, rand, bits))) return { ok: false, reason: "signature" };
    const age = now - parseInt(ts, 36);
    if (!(age >= -60_000 && age <= GUARD_LIMITS.challengeTtlMs)) return { ok: false, reason: "expired" };
    if (this.usedChallenges.has(rand, now)) return { ok: false, reason: "replay" };
    if (!hasLeadingZeroBits(createHash("sha256").update(`${challenge}:${nonce}`).digest(), Number(bits))) return { ok: false, reason: "work" };
    this.usedChallenges.add(rand, now + GUARD_LIMITS.challengeTtlMs);
    const day = kstDay(now), prev = this.mints.get(ip);
    const n = (prev && prev.day === day ? prev.n : 0) + 1;
    this.mints.set(ip, { day, n });
    const id = b64url(randomBytes(12));
    const issued = now.toString(36);
    return { ok: true, cookie: `${id}.${issued}.${this.sign("pass", id, issued)}`, mints: n };
  }
}

export function hasLeadingZeroBits(digest: Uint8Array, bits: number): boolean {
  let i = 0;
  for (; bits >= 8; bits -= 8, i++) if (digest[i] !== 0) return false;
  return bits === 0 || (digest[i]! >> (8 - bits)) === 0;
}

/**
 * 비밀키. 운영은 BOT_GUARD_SECRET 을 둔다 — 없으면 시작할 때마다 새로 만들어서
 * 재시작하면 통과 쿠키가 전부 무효가 된다(사람은 확인을 한 번 더 할 뿐이라 막지는 않는다).
 */
export function guardSecret(): Buffer {
  const configured = process.env.BOT_GUARD_SECRET;
  if (configured && configured.length >= 32) return Buffer.from(configured);
  if (process.env.NODE_ENV === "production") console.warn("[bot-guard] BOT_GUARD_SECRET 이 없거나 짧다 — 재시작마다 통과 쿠키가 무효가 된다");
  return randomBytes(32);
}

/** 확인 단계 화면. 자바스크립트로 작업증명을 풀고 쿠키를 받은 뒤 같은 주소를 다시 연다. 실패하면 다시 시도 버튼. */
export function challengePage(challenge: string, bits: number): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>잠시 확인 중</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#0b0d12;color:#d6dae3;font:15px/1.6 system-ui,sans-serif}main{max-width:28rem;padding:24px;text-align:center}small{color:#8a93a6}button{margin-top:12px;padding:6px 14px;border-radius:6px;border:1px solid #39404f;background:#171b24;color:inherit;font:inherit;cursor:pointer}</style>
</head><body><main><p id="m">기록을 불러오기 전에 잠깐 확인하고 있습니다…</p>
<noscript><p>자바스크립트를 켜야 기록을 볼 수 있습니다.</p></noscript>
<small>같은 곳에서 요청이 많을 때 거치는 단계입니다. 보통 1~2초면 끝나고 다시 묻지 않습니다.</small>
<div><button id="r" hidden onclick="location.reload()">다시 시도</button></div></main>
<script>(async()=>{const c=${JSON.stringify(challenge)},bits=${bits},e=new TextEncoder();
const ok=d=>{let b=bits,i=0;for(;b>=8;b-=8,i++)if(d[i]!==0)return false;return b===0||(d[i]>>(8-b))===0};
const fail=()=>{document.getElementById("m").textContent="확인을 끝내지 못했습니다. 다시 시도해 주세요.";document.getElementById("r").hidden=false};
try{for(let n=0;;n++){const d=new Uint8Array(await crypto.subtle.digest("SHA-256",e.encode(c+":"+n)));
if(ok(d)){const r=await fetch(${JSON.stringify(VERIFY_PATH)}+"?c="+encodeURIComponent(c)+"&n="+n,{credentials:"same-origin",cache:"no-store"});
if(r.ok)location.reload();else fail();return}}}catch(_){fail()}})();</script>
</body></html>`;
}
