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
  /**
   * 대상 중 실패한 수(계정·카드 …). 하나라도 있으면 실행 기록은 `failed`, 프로세스 종료 코드는 3 이다.
   * ★ 예전엔 예외만 실패로 쳐서, 30계정 중 5계정이 429 로 실패해도 `ok`·종료 코드 0 이었다 — 타이머가 실패를 못 알렸다.
   *   처리한 건수(processed)와 상세(detail)는 그대로 남긴다. 상주 루프는 멈추지 않고 다음 잡으로 간다.
   */
  failed?: number;
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
    const failed = result.failed ?? 0;
    await finishJob(id, {
      state: failed > 0 ? "failed" : "ok",
      processed: result.processed,
      apiCalls,
      error: failed > 0 ? `부분 실패 ${failed}건 — detail 참고` : null,
      detail: result.detail,
    });
    if (failed > 0) {
      process.exitCode = 3;
      log.warn(job, `부분 실패 ${failed}건`, { processed: result.processed, ...result.detail });
      return result;
    }
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
