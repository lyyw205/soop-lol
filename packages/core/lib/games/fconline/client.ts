/**
 * FC온라인 Open API로 나가는 유일한 관문.
 *
 * RiotClient와 인스턴스를 공유하지 않는다. 공급자별 호출 한도와 429 gate가 독립적이라
 * 같은 limiter를 쓰면 한 공급자의 정지가 다른 게임까지 막는다.
 */

import { RateLimiter, sleep } from "../../riot/rate-limiter.ts";
import type {
  FcoMatchDetail,
  FcoOuidResponse,
  FcoUserBasic,
  NexonErrorBody,
} from "./types.ts";

const BASE_URL = "https://open.api.nexon.com";

export class NexonApiError extends Error {
  readonly status: number;
  readonly methodId: string;
  readonly url: string;
  readonly code: string | null;
  readonly body: string;

  constructor(status: number, methodId: string, url: string, code: string | null, body: string) {
    super(`NEXON ${methodId} → ${status}${code ? ` ${code}` : ""}: ${body.slice(0, 200)}`);
    this.name = "NexonApiError";
    this.status = status;
    this.methodId = methodId;
    this.url = url;
    this.code = code;
    this.body = body;
  }

  get isAuthProblem() {
    // 넥슨은 유효하지 않은 키를 HTTP 400 + OPENAPI00005로도 돌려준다.
    return this.status === 403 || this.code === "OPENAPI00005";
  }
}

export interface NexonLogEvent {
  methodId: string;
  url: string;
  status: number;
  durationMs: number;
  attempt: number;
  retryAfterMs?: number;
}

export interface NexonClientOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  log?: (event: NexonLogEvent) => void;
  maxRetries?: number;
  maxRateLimitRetries?: number;
}

interface RequestOptions {
  path: string;
  methodId: string;
  query: Record<string, string | number | undefined>;
  /** 닉네임 미존재처럼 호출자가 정상적으로 처리할 식별자 오류. */
  missingIsNull?: boolean;
}

export class NexonClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly log?: (event: NexonLogEvent) => void;
  private readonly maxRetries: number;
  private readonly maxRateLimitRetries: number;
  callCount = 0;

  constructor(options: NexonClientOptions) {
    if (!options.apiKey.trim()) throw new Error("NEXON_API_KEY 가 비어 있다");
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    // 개발 키의 공식 한도. 서비스 키 전환 전까지 이보다 빠르게 호출하지 않는다.
    this.limiter = options.limiter ?? new RateLimiter({ initialAppLimits: "5:1,1000:86400" });
    this.log = options.log;
    this.maxRetries = options.maxRetries ?? 3;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 5;
  }

  private async request<T>(options: RequestOptions): Promise<T | null> {
    const url = new URL(options.path, BASE_URL);
    for (const [key, value] of Object.entries(options.query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const href = url.toString();
    let serverErrors = 0;
    let rateLimitHits = 0;
    let attempt = 0;

    for (;;) {
      attempt++;
      await this.limiter.acquire(options.methodId);
      const startedAt = Date.now();
      let response: Response;
      try {
        response = await this.fetchImpl(href, {
          headers: { "x-nxopen-api-key": this.apiKey, Accept: "application/json" },
        });
      } catch (cause) {
        if (++serverErrors > this.maxRetries) throw cause;
        await sleep(backoffMs(serverErrors));
        continue;
      }

      this.callCount++;
      const durationMs = Date.now() - startedAt;
      if (response.ok) {
        this.log?.({ methodId: options.methodId, url: href, status: response.status, durationMs, attempt });
        return await response.json() as T;
      }

      if (response.status === 429) {
        const retryAfterMs = this.limiter.penalize(options.methodId, response.headers);
        this.log?.({ methodId: options.methodId, url: href, status: 429, durationMs, attempt, retryAfterMs });
        if (++rateLimitHits > this.maxRateLimitRetries) {
          throw new NexonApiError(429, options.methodId, href, "OPENAPI00007", "429가 반복된다");
        }
        continue;
      }

      const body = await response.text().catch(() => "");
      let error: NexonErrorBody = {};
      try { error = JSON.parse(body) as NexonErrorBody; } catch { /* 본문 원형을 오류에 남긴다. */ }
      const code = error.error?.name ?? null;
      this.log?.({ methodId: options.methodId, url: href, status: response.status, durationMs, attempt });

      if (options.missingIsNull && response.status === 400
        && (code === "OPENAPI00003" || code === "OPENAPI00004")) return null;

      if (response.status >= 500) {
        if (++serverErrors <= this.maxRetries) {
          await sleep(backoffMs(serverErrors));
          continue;
        }
      }
      throw new NexonApiError(response.status, options.methodId, href, code, body);
    }
  }

  async ouidByNickname(nickname: string): Promise<string | null> {
    const value = nickname.trim();
    if (!value) throw new Error("FC온라인 감독명이 비어 있다");
    const row = await this.request<FcoOuidResponse>({
      path: "/fconline/v1/id",
      methodId: "fconline.id",
      query: { nickname: value },
      missingIsNull: true,
    });
    return row?.ouid ?? null;
  }

  userBasic(ouid: string): Promise<FcoUserBasic | null> {
    return this.request<FcoUserBasic>({
      path: "/fconline/v1/user/basic",
      methodId: "fconline.user.basic",
      query: { ouid },
      missingIsNull: true,
    });
  }

  async matchIds(ouid: string, matchType: number, offset = 0, limit = 100): Promise<string[]> {
    return await this.request<string[]>({
      path: "/fconline/v1/user/match",
      methodId: "fconline.user.match",
      query: { ouid, matchtype: matchType, offset: Math.max(0, offset), limit: Math.min(100, Math.max(1, limit)) },
    }) ?? [];
  }

  matchDetail(matchId: string): Promise<FcoMatchDetail | null> {
    return this.request<FcoMatchDetail>({
      path: "/fconline/v1/match-detail",
      methodId: "fconline.match.detail",
      query: { matchid: matchId },
      // 오래된 경기나 생성 전 종료된 경기는 재조회 불가 종결 후보가 된다.
      missingIsNull: true,
    });
  }
}

function backoffMs(attempt: number): number {
  return Math.min(10_000, 250 * 2 ** Math.max(0, attempt - 1));
}
