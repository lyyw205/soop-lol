/**
 * 워커가 들고 다니는 것들. `RiotClient` 는 **프로세스에 하나**여야 한다 —
 * 레이트리밋 버킷이 클라이언트 안에 있어서, 엔진마다 새로 만들면
 * 각자 "나는 20 req/s 안 넘었다"고 믿으면서 합쳐서 60 req/s 를 쏜다.
 */

import { RiotApiError, RiotClient } from "@soop-lol/core/lib/riot/client";

import type { WorkerConfig } from "./config.ts";
import { log } from "./log.ts";

export interface WorkerContext {
  cfg: WorkerConfig;
  riot: RiotClient;
}

/**
 * @param overrides `fetchImpl` 만 바꿀 수 있다 — 검증 스크립트가 **API 키 없이**
 *   진짜 엔진을 돌려보기 위한 구멍이다 (scripts/verify-ingest.ts).
 *   레이트리밋·재시도·404 처리는 그대로 통과하므로 게이트웨이 원칙은 깨지지 않는다.
 */
export function createContext(
  cfg: WorkerConfig,
  overrides: { fetchImpl?: typeof fetch } = {},
): WorkerContext {
  const riot = new RiotClient({
    apiKey: cfg.riotApiKey,
    fetchImpl: overrides.fetchImpl,
    log: cfg.verbose
      ? (e) => log.info("riot", e.methodId, { status: e.status, ms: e.durationMs, try: e.attempt })
      : (e) => {
          // 평소엔 조용히. 429 와 5xx 만 남긴다 — 이게 리밋 튜닝의 유일한 단서다.
          if (e.status === 429) log.warn("riot", "429", { method: e.methodId, retryAfterMs: e.retryAfterMs });
          else if (e.status >= 500) log.warn("riot", `${e.status}`, { method: e.methodId });
        },
  });
  return { cfg, riot };
}

/**
 * 계속 돌면 안 되는 실패인가.
 *
 * 401/403 은 키가 죽은 것이다. Development 키는 24시간마다 만료된다 —
 * 이걸 계정별로 삼켜버리면 워커가 "0건 처리"를 조용히 반복하며 하루를 날린다.
 */
export function isFatal(e: unknown): boolean {
  return e instanceof RiotApiError && e.isAuthProblem;
}
