/**
 * FC 공식 홈페이지 응답 파서 — 구단주 검색·구단가치 툴팁·스쿼드·카드 시세 그래프.
 *
 * 전부 순수 함수다. 응답은 사람용 화면의 내부 요청이라 형식이 예고 없이 바뀐다.
 * **알아보지 못한 응답은 추측하지 않고 `ClubParseError` 로 던진다** — 화면 개편 날 엉뚱한 값이
 * 조용히 쌓이거나 전원이 "없음" 으로 바뀌는 것보다 실패가 낫다. 실제 응답 표본: `fixtures/`.
 * 출처와 실측: docs/FCO-CLUB-VALUE-PLAN.md §1.
 */

export class ClubParseError extends Error {
  readonly what: string;
  constructor(what: string, detail: string) {
    super(`FC 홈페이지 ${what} 응답을 알아보지 못했다: ${detail}`);
    this.name = "ClubParseError";
    this.what = what;
  }
}

/** "12,222,552,300" → 12222552300. 빈 문자열·숫자가 아닌 값은 null. */
export function parseWon(text: string | null | undefined): number | null {
  const digits = (text ?? "").replace(/,/g, "").trim();
  if (!/^\d+$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isSafeInteger(n) ? n : null;
}

const decodeEntities = (s: string) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// ── 구단주 검색 ─────────────────────────────────────────────────────

export type ProfileLookup =
  | { kind: "found"; sn: number; characterId: string; nickname: string | null }
  | { kind: "missing" };

/**
 * `GET /profile/common/PopProfile?strCharacterName=…` 를 리다이렉트까지 따라간 결과.
 * 있으면 `/profile/squad/popup/{회원번호}` 프로필 화면이고, 그 안의 스쿼드 초기화 호출에
 * 회원번호와 캐릭터ID(스쿼드 요청에 필요, ouid 와 다른 값)가 같이 박혀 있다.
 * 없으면 200 + `alert('구단주 정보가 존재하지 않습니다.')`.
 */
export function parseProfile(html: string, finalUrl: string): ProfileLookup {
  if (html.includes("구단주 정보가 존재하지 않습니다")) return { kind: "missing" };
  const call = /SetSquadInfo\("\d", "\d", "(\d+)", "([0-9a-f]{16,64})"\)/.exec(html);
  if (!call) throw new ClubParseError("구단주 검색", `스쿼드 초기화 호출이 없다 (${finalUrl})`);
  const sn = Number(call[1]);
  const urlSn = /\/profile\/squad\/popup\/(\d+)/i.exec(finalUrl)?.[1];
  if (urlSn && Number(urlSn) !== sn) {
    throw new ClubParseError("구단주 검색", `주소의 회원번호 ${urlSn} 와 화면의 ${call[1]} 이 다르다`);
  }
  const name = /<span class="coach">([^<]*)<\/span>\s*님의 프로필/.exec(html)?.[1];
  return { kind: "found", sn, characterId: call[2], nickname: name ? decodeEntities(name).trim() : null };
}

// ── 공식 구단가치 툴팁 ───────────────────────────────────────────────

/** `POST /Profile/Common/ToolTip/{회원번호}` — 감독명과 공식 구단가치. */
export function parseTooltip(html: string): { nickname: string; clubValue: number } {
  const name = /<span class="name"[^>]*>([^<]*)<\/span>/.exec(html)?.[1];
  const value = parseWon(/<div class="value" alt="([\d,]+)"/.exec(html)?.[1]);
  if (name === undefined || value === null) {
    throw new ClubParseError("구단가치 툴팁", name === undefined ? "감독명 칸이 없다" : "구단가치 칸이 없다");
  }
  return { nickname: decodeEntities(name).trim(), clubValue: value };
}

// ── 스쿼드 ───────────────────────────────────────────────────────────

export interface SquadPlayer {
  idx: number;
  role: string;
  isStarter: boolean;
  spid: number;
  /** 강화 단계. 넥슨이 비워 주므로 현재가가 강화별 현재가 몇 번째와 같은지로 구한다. 애매하면 null. */
  grade: number | null;
  /** 현재가. 넥슨이 비워 주면 null. */
  price: number | null;
  name: string;
  season: string | null;
  ovr: number | null;
}

export interface Squad {
  /** 넥슨이 준 선발 합(현재가). */
  totalPrice: number;
  coachId: string | null;
  players: SquadPlayer[];
}

interface RawSquadPlayer {
  role?: unknown; spid?: unknown; price?: unknown; eachPrice?: unknown;
  name?: unknown; season?: unknown; ovr?: unknown;
}

/**
 * 강화 단계 = 현재가가 강화 0~13 현재가 목록(`eachPrice`, `|` 구분)의 몇 번째와 같은가.
 * 경기 상세의 spGrade 와 18/18 일치했다(2026-10-02). 같은 값이 둘 이상이면 고르지 않는다.
 */
export function gradeFromEachPrice(price: string, eachPrice: string): number | null {
  const steps = eachPrice.split("|").map((s) => s.trim());
  const hits = steps.flatMap((step, i) => step === price.trim() ? [i] : []);
  return hits.length === 1 && hits[0] <= 13 ? hits[0] : null;
}

/** `GET /datacenter/SquadGetUserInfo?…` JSON. 캐릭터ID가 틀리면 빈 본문이 온다 — 그것도 실패다. */
export function parseSquad(body: string): Squad {
  let raw: { totalPrice?: unknown; coach?: unknown; players?: unknown };
  try { raw = JSON.parse(body); } catch {
    throw new ClubParseError("스쿼드", body.trim() ? "JSON 이 아니다" : "빈 응답 (캐릭터ID 불일치?)");
  }
  if (typeof raw.totalPrice !== "number" || !Array.isArray(raw.players)) {
    throw new ClubParseError("스쿼드", "totalPrice·players 가 없다");
  }
  const players = (raw.players as RawSquadPlayer[]).map((p, idx): SquadPlayer => {
    const spid = Number(p.spid);
    if (!Number.isSafeInteger(spid) || spid <= 0 || typeof p.role !== "string" || typeof p.name !== "string") {
      throw new ClubParseError("스쿼드", `${idx}번 선수의 spid·role·name 이 이상하다`);
    }
    const price = typeof p.price === "string" ? p.price : "";
    return {
      idx,
      role: p.role,
      // 선발은 자리 이름이 소문자(gk·lcb …), 교체는 대문자(GK·CF …) — 실측.
      isStarter: p.role === p.role.toLowerCase(),
      spid,
      grade: typeof p.eachPrice === "string" && price ? gradeFromEachPrice(price, p.eachPrice) : null,
      price: parseWon(price),
      name: p.name,
      season: typeof p.season === "string" && p.season ? p.season : null,
      ovr: typeof p.ovr === "number" ? p.ovr : null,
    };
  });
  return { totalPrice: raw.totalPrice, coachId: typeof raw.coach === "string" && raw.coach ? raw.coach : null, players };
}

// ── 카드 시세 그래프 ─────────────────────────────────────────────────

export interface PricePoint { day: string; price: number }

/**
 * `POST /datacenter/PlayerPriceGraph` (spid, n1strong) — 현재가와 일별 시세(최대 365일).
 *
 * 날짜는 `"10.02"` 처럼 **연도가 없다.** 마지막 점부터 거꾸로 붙인다: 마지막 점은 조회한 날(KST)
 * 이전의 가장 가까운 그 월·일, 앞 점은 뒤 점보다 앞서는 가장 가까운 그 월·일. 점이 하루 간격이
 * 아니어도 이 규칙은 맞다. 366개를 넘거나 같은 날이 두 번 나오면 실패로 둔다.
 */
export function parsePriceGraph(html: string, fetchedDayKst: string): { current: number | null; points: PricePoint[] } {
  const current = parseWon(/현재가<\/span>\s*<strong alt="([\d,]+)"/.exec(html)?.[1]);
  const block = /var json1 = \{([\s\S]*?)\}/.exec(html)?.[1];
  if (!block) throw new ClubParseError("시세 그래프", "json1 이 없다");
  const list = (key: string) => {
    const inner = new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`).exec(block)?.[1];
    if (inner === undefined) throw new ClubParseError("시세 그래프", `${key} 배열이 없다`);
    return [...inner.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  };
  const times = list("time");
  const values = list("value");
  if (times.length !== values.length) throw new ClubParseError("시세 그래프", `날짜 ${times.length}개 · 값 ${values.length}개`);
  if (times.length > 366) throw new ClubParseError("시세 그래프", `점이 ${times.length}개 — 1년보다 길다`);

  const [fy, fm, fd] = fetchedDayKst.split("-").map(Number);
  let bound = Date.UTC(fy, fm - 1, fd);   // 이 날 이하에서 가장 가까운 월·일을 찾는다
  const points: PricePoint[] = [];
  for (let i = times.length - 1; i >= 0; i--) {
    const md = /^(\d{1,2})\.(\d{2})$/.exec(times[i]);
    const price = parseWon(values[i]);
    if (!md || price === null) throw new ClubParseError("시세 그래프", `${i}번 점 "${times[i]}"/"${values[i]}"`);
    const month = Number(md[1]), day = Number(md[2]);
    // 2.29 는 윤년까지 거슬러 간다. 4년 안에 없으면 없는 날짜다.
    let t = NaN;
    for (let year = new Date(bound).getUTCFullYear(), stop = year - 4; year >= stop; year--) {
      const candidate = Date.UTC(year, month - 1, day);
      if (new Date(candidate).getUTCMonth() === month - 1 && candidate <= bound) { t = candidate; break; }
    }
    if (Number.isNaN(t)) throw new ClubParseError("시세 그래프", `없는 날짜 "${times[i]}"`);
    points.push({ day: new Date(t).toISOString().slice(0, 10), price });
    bound = t - 86_400_000;
  }
  points.reverse();
  // 일별 그래프다 — 처음과 끝이 1년을 넘으면 날짜를 잘못 붙인 것이다(예: 평년에 2.29 가 나왔다).
  if (points.length && Date.parse(points.at(-1)!.day) - Date.parse(points[0].day) > 366 * 86_400_000) {
    throw new ClubParseError("시세 그래프", `${points[0].day}~${points.at(-1)!.day} — 1년보다 길다`);
  }
  return { current, points };
}
