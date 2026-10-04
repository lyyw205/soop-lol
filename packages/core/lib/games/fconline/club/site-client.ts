/**
 * FC 공식 홈페이지(fconline.nexon.com)로 나가는 유일한 관문 — 구단주 검색·구단가치·스쿼드·카드 시세.
 *
 * 넥슨 Open API 에 이 데이터가 없어 사람용 화면의 내부 요청을 쓴다(docs/FCO-CLUB-VALUE-PLAN.md §1).
 * 그래서 Open API 의 NexonClient 와 limiter 를 섞지 않고, 화면을 여는 사람보다 빠르지 않게
 * **초당 1회**로 묶는다. 이 파일 밖에서 fconline.nexon.com 을 fetch 하지 않는다(코딩 원칙 4).
 */

import { RateLimiter, sleep } from "../../../riot/rate-limiter.ts";
import { parsePriceGraph, parseProfile, parseSquad, parseTooltip, type ProfileLookup, type Squad } from "./parse.ts";

import { parseSeasonGrades } from "./grades.ts";
import { parseRating } from "./rating.ts";
import { parseValueRanking } from "./value-ranking.ts";
import { parseTeamColors, parseSquadTeamColors } from "./team-colors.ts";

const BASE_URL = "https://fconline.nexon.com";
const USER_AGENT = "Mozilla/5.0 (compatible; soop-lol/1.0)";

export class FcoSiteError extends Error {
  readonly status: number;
  readonly url: string;
  constructor(status: number, url: string, detail: string) {
    super(`FC 홈페이지 ${status} ${url}: ${detail.slice(0, 160)}`);
    this.name = "FcoSiteError";
    this.status = status;
    this.url = url;
  }
}

export interface FcoSiteClientOptions {
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  maxRetries?: number;
}

export class FcoSiteClient {
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  callCount = 0;

  constructor(options: FcoSiteClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.limiter = options.limiter ?? new RateLimiter({ initialAppLimits: "1:1" });
    this.maxRetries = options.maxRetries ?? 2;
  }

  private async request(path: string, init: { method?: "GET" | "POST"; form?: Record<string, string | number> } = {}) {
    const url = new URL(path, BASE_URL).toString();
    const body = init.form
      ? new URLSearchParams(Object.entries(init.form).map(([k, v]): [string, string] => [k, String(v)])).toString()
      : undefined;
    for (let attempt = 1; ; attempt++) {
      await this.limiter.acquire("fco.site");
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: init.method ?? "GET",
          headers: {
            "User-Agent": USER_AGENT,
            "X-Requested-With": "XMLHttpRequest",
            ...(body ? { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" } : {}),
          },
          body,
          redirect: "follow",
        });
      } catch (cause) {
        if (attempt > this.maxRetries) throw cause;
        await sleep(1000 * attempt);
        continue;
      }
      this.callCount++;
      const text = await response.text();
      if (response.ok) return { text, finalUrl: response.url || url };
      if (response.status >= 500 && attempt <= this.maxRetries) {
        await sleep(1000 * attempt);
        continue;
      }
      throw new FcoSiteError(response.status, url, text);
    }
  }

  /** 감독명 → 회원번호·캐릭터ID (구단주 검색을 프로필 화면까지 따라간다). 대소문자를 무시하니 호출자가 감독명을 대조한다. */
  async profile(nickname: string): Promise<ProfileLookup> {
    const r = await this.request(`/profile/common/PopProfile?${new URLSearchParams({ strCharacterName: nickname })}`);
    return parseProfile(r.text, r.finalUrl);
  }

  /** 회원번호 → 감독명·공식 구단가치. */
  async tooltip(sn: number) {
    const r = await this.request(`/Profile/Common/ToolTip/${sn}`, { method: "POST", form: { rd: Math.random() } });
    return parseTooltip(r.text);
  }

  /** 스쿼드 한 칸. teamType 1 대표팀·0 클럽팀, slot 1~3 = A/B/C. */
  async squad(sn: number, characterId: string, teamType: 0 | 1, slot: 1 | 2 | 3): Promise<Squad> {
    const q = new URLSearchParams({
      strTeamType: String(teamType), n1Type: String(slot), n8NexonSN: String(sn), strCharacterID: characterId,
    });
    return parseSquad((await this.request(`/datacenter/SquadGetUserInfo?${q}`)).text);
  }

  /** One public daily TOP 50 response for all accounts. Use its returned date. */
  async valueRanking() {
    return parseValueRanking((await this.request("/datacenter/dailyrank")).text);
  }

  /** Read the exact default squad selected in the public profile, not an arbitrary A slot. */
  async profileTeamColors(nickname: string, sn: number) {
    const r = await this.request(`/profile/common/PopProfile?${new URLSearchParams({ strCharacterName: nickname })}`);
    const profile = parseProfile(r.text, r.finalUrl);
    if (profile.kind !== "found" || profile.sn !== sn || profile.nickname !== nickname) {
      throw new Error("프로필 팀컬러: 구단주명·회원번호 불일치");
    }
    const selected = /SetSquadInfo\("([01])", "([123])",/.exec(r.text);
    if (!selected) throw new Error("프로필 팀컬러: 기본 스쿼드를 확인할 수 없다");
    const q = new URLSearchParams({ strTeamType: selected[1], n1Type: selected[2], n8NexonSN: String(sn), strCharacterID: profile.characterId });
    const body = (await this.request(`/datacenter/SquadGetUserInfo?${q}`)).text;
    return { colors: parseSquadTeamColors(body), sourceAt: new Date().toISOString(),
      source: "profile-squad" as const, slot: `${selected[1] === "1" ? "대표팀" : "클럽팀"} ${["A", "B", "C"][Number(selected[2]) - 1]}` };
  }

  /** Profile's current and immediately previous season peak divisions, always 1v1. */
  async seasonGrades(nickname: string, sn: number) {
    const identity = await this.tooltip(sn);
    if (identity.nickname !== nickname) throw new Error("공식경기 등급: 구단주명·회원번호 불일치");
    const r = await this.request(`/Profile/Stat/TeamInfo/${sn}?n1Type=50`);
    return { ...parseSeasonGrades(r.text), checkedAt: new Date().toISOString() };
  }

  /** Current official 1v1 ELO; the source refreshes hourly. */
  async rating(nickname: string, sn: number) {
    const q = new URLSearchParams({ rt: "1vs1", n4seasonno: "0", strCharacterName: nickname });
    return parseRating((await this.request(`/datacenter/rank_inner?${q}`)).text, nickname, sn);
  }

  /** Latest official 1v1 country/club chemistry; matched by nickname AND member number. */
  async teamColors(nickname: string, sn: number) {
    const q = new URLSearchParams({ rt: "1vs1", n4seasonno: "0", strCharacterName: nickname });
    return parseTeamColors((await this.request(`/datacenter/rank_inner?${q}`)).text, nickname, sn);
  }

  /** 카드×강화 시세 — 현재가와 일별 값(최대 365일). fetchedDayKst 는 연도 없는 날짜를 붙이는 기준일. */
  async priceGraph(spid: number, grade: number, fetchedDayKst: string) {
    const r = await this.request("/datacenter/PlayerPriceGraph", { method: "POST", form: { spid, n1strong: grade } });
    return parsePriceGraph(r.text, fetchedDayKst);
  }
}
