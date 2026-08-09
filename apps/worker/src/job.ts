/**
 * 모든 엔진 실행을 `job_run` 에 남긴다.
 *
 * 이게 없으면 "어제 09시 랭크 스냅샷이 왜 비었나"에 답할 수 없다.
 * rank_snapshot 에 행이 없는 것과 잡이 안 돈 것은 완전히 다른 사고다.
 */

import { finishJob, startJob } from "@soop-lol/core/lib/db/ingest";

import type { WorkerContext } from "./context.ts";
import { errorMessage, log } from "./log.ts";

export interface EngineResult {
  processed: number;
  detail?: Record<string, unknown>;
}

export async function runJob<T extends EngineResult>(
  ctx: WorkerContext,
  job: string,
  fn: () => Promise<T>,
): Promise<T> {
  const id = await startJob(job);
  const callsBefore = ctx.riot.callCount;
  const startedAt = Date.now();

  try {
    const result = await fn();
    const apiCalls = ctx.riot.callCount - callsBefore;
    await finishJob(id, {
      state: "ok",
      processed: result.processed,
      apiCalls,
      detail: result.detail,
    });
    log.info(job, "완료", {
      processed: result.processed,
      api: apiCalls,
      ms: Date.now() - startedAt,
      ...result.detail,
    });
    return result;
  } catch (e) {
    await finishJob(id, {
      state: "failed",
      apiCalls: ctx.riot.callCount - callsBefore,
      error: errorMessage(e),
    });
    throw e;
  }
}
