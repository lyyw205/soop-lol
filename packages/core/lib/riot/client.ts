/**
 * RiotClient — Riot API 로 나가는 **유일한 관문**.
 *
 * docs/PLAN.md §11-4: 아무 데서나 fetch 하지 않는다.
 * 레이트리밋·재시도·404 처리·로깅이 전부 여기 한 곳에 있어야
 * "왜 429 를 맞았지"를 한 군데만 보고 답할 수 있다.
 */

import {
  DEFAULT_PLATFORM,
  DEFAULT_REGIONAL,
  hostFor,
  type PlatformRoute,
  type RegionalRoute,
  type RiotRoute,
} from "./regions.ts";
import { RateLimiter, sleep } from "./rate-limiter.ts";
import type {
  CurrentGameInfoDto,
  LeagueEntryDto,
  MatchDto,
  RiotAccountDto,
  SummonerDto,
} from "./types.ts";

export class RiotApiError extends Error {
  readonly status: number;
  readonly methodId: string;
  readonly url: string;
  readonly body: string;

  // ★ 파라미터 프로퍼티를 쓰지 않는다 — node 타입 스트리핑이 지원하지 않는다.
  constructor(status: number, methodId: string, url: string, body: string) {
    super(`Riot ${methodId} → ${status}: ${body.slice(0, 200)}`);
    this.name = "RiotApiError";
    this.status = status;
    this.methodId = methodId;
    this.url = url;
    this.body = body;
  }

  /** 키가 만료·무효다. Development 키는 24시간마다 죽는다. */
  get isAuthProblem() {
    return this.status === 401 || this.status === 403;
  }
}

export interface RiotLogEvent {
  methodId: string;
  url: string;
  status: number;
  durationMs: number;
  attempt: number;
  retryAfterMs?: number;
}

export interface RiotClientOptions {
  apiKey: string;
  platform?: PlatformRoute;
  regional?: RegionalRoute;
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  log?: (e: RiotLogEvent) => void;
  /** 5xx 재시도 횟수. 429 는 여기 포함되지 않는다(Retry-After 만큼 무조건 기다린다). */
  maxRetries?: number;
  /** 429 를 연속으로 몇 번까지 참을지. 무한 루프 방지용 안전핀. */
  maxRateLimitRetries?: number;
}

interface RequestOpts {
  route: RiotRoute;
  path: string;
  methodId: string;
  query?: Record<string, string | number | undefined>;
  /** 404 를 null 로 받을지. 매치 조회처럼 "없는 게 정상"인 곳에서만 true. */
  allow404?: boolean;
}

export class RiotClient {
  readonly platform: PlatformRoute;
  readonly regional: RegionalRoute;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly log?: (e: RiotLogEvent) => void;
  private readonly maxRetries: number;
  private readonly maxRateLimitRetries: number;

  /** job_run.api_calls 보고용. */
  callCount = 0;

  constructor(opts: RiotClientOptions) {
    if (!opts.apiKey) throw new Error("RIOT_API_KEY 가 비어 있다");
    this.apiKey = opts.apiKey;
    this.platform = opts.platform ?? DEFAULT_PLATFORM;
    this.regional = opts.regional ?? DEFAULT_REGIONAL;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.limiter = opts.limiter ?? new RateLimiter();
    this.log = opts.log;
    this.maxRetries = opts.maxRetries ?? 3;
    this.maxRateLimitRetries = opts.maxRateLimitRetries ?? 10;
  }

  private async request<T>(opts: RequestOpts): Promise<T | null> {
    const url = new URL(opts.path, hostFor(opts.route));
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const href = url.toString();

    let serverErrors = 0;
    let rateLimitHits = 0;
    let attempt = 0;

    for (;;) {
      attempt++;
      await this.limiter.acquire(opts.methodId);

      const startedAt = Date.now();
      let res: Response;
      try {
        res = await this.fetchImpl(href, {
          headers: { "X-Riot-Token": this.apiKey, Accept: "application/json" },
        });
      } catch (cause) {
        // 네트워크 장애. 5xx 와 같은 정책으로 재시도한다.
        if (++serverErrors > this.maxRetries) throw cause;
        await sleep(backoffMs(serverErrors));
        continue;
      }
      this.callCount++;
      const durationMs = Date.now() - startedAt;
      this.limiter.observe(opts.methodId, res.headers);

      if (res.ok) {
        this.log?.({ methodId: opts.methodId, url: href, status: res.status, durationMs, attempt });
        return (await res.json()) as T;
      }

      if (res.status === 429) {
        const retryAfterMs = this.limiter.penalize(opts.methodId, res.headers);
        this.log?.({
          methodId: opts.methodId, url: href, status: 429, durationMs, attempt, retryAfterMs,
        });
        if (++rateLimitHits > this.maxRateLimitRetries) {
          throw new RiotApiError(429, opts.methodId, href, "429 가 반복된다 — 리밋 설정을 확인할 것");
        }
        continue; // acquire 가 게이트를 보고 알아서 기다린다
      }

      const body = await res.text().catch(() => "");
      this.log?.({ methodId: opts.methodId, url: href, status: res.status, durationMs, attempt });

      // 404 는 이 도메인에서 정상 케이스다 — 2년 지난 매치는 사라진다.
      if (res.status === 404 && opts.allow404) return null;

      // 키 문제는 재시도해도 소용없다. 즉시 올린다.
      if (res.status === 401 || res.status === 403) {
        throw new RiotApiError(res.status, opts.methodId, href, body || "API 키가 만료됐거나 권한이 없다");
      }

      if (res.status >= 500) {
        if (++serverErrors > this.maxRetries) {
          throw new RiotApiError(res.status, opts.methodId, href, body);
        }
        await sleep(backoffMs(serverErrors));
        continue;
      }

      throw new RiotApiError(res.status, opts.methodId, href, body);
    }
  }

  // ── account-v1 (regional) ──────────────────────────────────────────

  /** Riot ID(`닉네임#태그`) → puuid. 계정 등록 시 딱 한 번. */
  accountByRiotId(gameName: string, tagLine: string): Promise<RiotAccountDto | null> {
    return this.request<RiotAccountDto>({
      route: this.regional,
      path: `/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`,
      methodId: "account-v1.byRiotId",
      allow404: true,
    });
  }

  /** puuid → 최신 Riot ID. 닉네임은 바뀌므로 하루 1회 갱신한다. */
  accountByPuuid(puuid: string): Promise<RiotAccountDto | null> {
    return this.request<RiotAccountDto>({
      route: this.regional,
      path: `/riot/account/v1/accounts/by-puuid/${puuid}`,
      methodId: "account-v1.byPuuid",
      allow404: true,
    });
  }

  // ── summoner-v4 / league-v4 (platform) ─────────────────────────────

  summonerByPuuid(puuid: string): Promise<SummonerDto | null> {
    return this.request<SummonerDto>({
      route: this.platform,
      path: `/lol/summoner/v4/summoners/by-puuid/${puuid}`,
      methodId: "summoner-v4.byPuuid",
      allow404: true,
    });
  }

  /**
   * 랭크 조회.
   * ★ Riot 이 summonerId 기반에서 puuid 기반으로 옮기는 중이다.
   *   by-puuid 가 404/403 이면 by-summoner 로 폴백한다 — 실제 키로 어느 쪽이 사는지 확인 후
   *   폴백을 지울 것. (docs/PLAN.md §4)
   */
  async leagueEntriesByPuuid(puuid: string, summonerId?: string): Promise<LeagueEntryDto[]> {
    const byPuuid = await this.request<LeagueEntryDto[]>({
      route: this.platform,
      path: `/lol/league/v4/entries/by-puuid/${puuid}`,
      methodId: "league-v4.byPuuid",
      allow404: true,
    });
    if (byPuuid) return byPuuid;
    if (!summonerId) return [];
    const bySummoner = await this.request<LeagueEntryDto[]>({
      route: this.platform,
      path: `/lol/league/v4/entries/by-summoner/${summonerId}`,
      methodId: "league-v4.bySummoner",
      allow404: true,
    });
    return bySummoner ?? [];
  }

  // ── match-v5 (regional) ────────────────────────────────────────────

  /**
   * 매치 ID 목록.
   * ★ 커스텀 게임은 여기 **절대 안 나온다** (docs/RESEARCH.md §3-1).
   * ★ 2년 지나 삭제된 경기의 ID 가 섞여 나올 수 있다 → 상세 조회에서 404 는 정상.
   */
  async matchIds(
    puuid: string,
    params: {
      startTime?: number; // 초 단위 epoch. ms 아님.
      endTime?: number;
      queue?: number;
      type?: "ranked" | "normal" | "tourney" | "tutorial";
      start?: number;
      count?: number; // 최대 100
    } = {},
  ): Promise<string[]> {
    const ids = await this.request<string[]>({
      route: this.regional,
      path: `/lol/match/v5/matches/by-puuid/${puuid}/ids`,
      methodId: "match-v5.matchIds",
      query: {
        startTime: params.startTime,
        endTime: params.endTime,
        queue: params.queue,
        type: params.type,
        start: params.start ?? 0,
        count: Math.min(params.count ?? 100, 100),
      },
      allow404: true,
    });
    return ids ?? [];
  }

  /** 매치 상세. null 이면 2년 경과로 삭제된 것 — dead_match 에 기록하고 재시도하지 않는다. */
  match(matchId: string): Promise<MatchDto | null> {
    return this.request<MatchDto>({
      route: this.regional,
      path: `/lol/match/v5/matches/${matchId}`,
      methodId: "match-v5.match",
      allow404: true,
    });
  }

  /** 타임라인은 경기당 1~5MB다. **조우 경기에만** 부른다 (docs/PLAN.md §5 Engine D). */
  matchTimeline(matchId: string): Promise<unknown | null> {
    return this.request<unknown>({
      route: this.regional,
      path: `/lol/match/v5/matches/${matchId}/timeline`,
      methodId: "match-v5.timeline",
      allow404: true,
    });
  }

  // ── spectator-v5 (platform) ────────────────────────────────────────

  /**
   * 진행 중인 게임. null 이면 게임 중이 아니다(404 가 정상).
   * 같은 로비의 다른 puuid 가 곧 계정 후보다 (docs/RESEARCH.md §2 2단).
   */
  activeGameByPuuid(puuid: string): Promise<CurrentGameInfoDto | null> {
    return this.request<CurrentGameInfoDto>({
      route: this.platform,
      path: `/lol/spectator/v5/active-games/by-summoner/${puuid}`,
      methodId: "spectator-v5.activeGame",
      allow404: true,
    });
  }
}

function backoffMs(attempt: number): number {
  // 1s, 2s, 4s … 상한 30s. 지터를 섞어 동시 재시도가 겹치지 않게 한다.
  const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  return base + Math.floor(Math.random() * 250);
}
