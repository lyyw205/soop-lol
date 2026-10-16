/**
 * 모든 엔진 실행을 `job_run` 에 남긴다.
 *
 * 이게 없으면 "어제 09시 랭크 스냅샷이 왜 비었나"에 답할 수 없다.
 * rank_snapshot 에 행이 없는 것과 잡이 안 돈 것은 완전히 다른 사고다.
 */

import { db } from "@soop-lol/core/lib/db/client";
import { finishJob, startJob } from "@soop-lol/core/lib/db/ingest";
import { assertDbWritable, noteWriteBlocked } from "@soop-lol/core/lib/db/write-block";
import { writeResult, writeStop } from "@soop-lol/core/lib/ops/run-files";

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

/**
 * DB 를 크게 늘리는 잡 — 시작 전에 운영 DB 점검(잠금·한도 95%·쓰기 실패 기록)을 통과해야 한다.
 * ★ 2026-10-01 공개 큐 2.7만 판 적재가 Free 한도를 넘겨 DB 가 읽기 전용이 됐다. 백필은 조각마다 여기를 지나므로
 *   조각 사이 재점검이 된다. 작은 정기 수집(랭크·FC)은 막지 않는다 — 놓친 날은 다시 못 구하고 쓰는 양이 작다.
 *   대신 그 잡들도 쓰기가 막혀 실패하면 표시를 남겨 조사 세션이 멈추게 한다(아래 catch).
 */
const DB_GATED_JOBS = new Set(["engine_b_live", "engine_c_backfill"]);

/** 실행 기록·점검 — 테스트가 바꿔 끼운다(시작 기록부터 쓰기가 막히는 경로를 재현하려고). */
export interface JobDeps {
  startJob: typeof startJob;
  finishJob: typeof finishJob;
  assertDbWritable: (label: string) => ReturnType<typeof assertDbWritable>;
  noteWriteBlocked: typeof noteWriteBlocked;
  /** 감싸는 실행기(scripts/ops/run-job.ts)의 실행 폴더. 있으면 job_run 은 실행기가 쓰고, 여기서는 결과·멈춘 이유 파일만 남긴다. */
  runDir?: string;
}
const defaultDeps: JobDeps = { startJob, finishJob, assertDbWritable: (label) => assertDbWritable(db(), label), noteWriteBlocked, runDir: process.env.OPS_RUN_DIR || undefined };

export async function runJob<T extends EngineResult>(
  ctx: WorkerContext,
  job: string,
  fn: () => Promise<T>,
  deps: JobDeps = defaultDeps,
): Promise<T> {
  const { startJob, finishJob, noteWriteBlocked } = deps;
  if (deps.runDir) return runWrapped(ctx, job, fn, deps, deps.runDir);
  if (DB_GATED_JOBS.has(job)) {
    const j = await deps.assertDbWritable(job);
    if (j.verdict === "warn") log.warn(job, "운영 DB 점검 경고", { reasons: j.reasons.join(" ; ") });
  }
  // ★ 시작 기록도 쓰기다 — 읽기 전용이면 여기서 먼저 실패한다. 표시를 남겨야 조사 세션이 멈춘다(2026-10-12 검토).
  let id: Awaited<ReturnType<typeof startJob>>;
  try {
    id = await startJob(job);
  } catch (e) {
    noteWriteBlocked(e, `worker ${job}`);
    throw e;
  }
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
    // 쓰기가 막힌 실패면 실행 기록도 못 쓴다 — 원래 오류를 가리지 않게 기록 없이 올려 보낸다.
    if (noteWriteBlocked(e, `worker ${job}`)) throw e;
    await finishJob(id, {
      state: "failed",
      apiCalls: ctx.riot.callCount - callsBefore,
      error: errorMessage(e),
    });
    throw e;
  }
}

/**
 * 감싸기 아래의 실행 — 실행 기록(job_run 한 행)의 주인은 감싸는 실행기다. 여기서 행을 또 만들면 한 실행에 두 행이 생기고
 * 최종 상태가 둘이 된다(재설계 계획 §5.2-4). 엔진 결과는 result.json, 멈춘 이유는 stop.json 으로 넘긴다.
 * 종료 코드는 지금과 같다 — 부분 실패 3, 예외는 위로 던진다(main 이 정한다).
 */
async function runWrapped<T extends EngineResult>(ctx: WorkerContext, job: string, fn: () => Promise<T>, deps: JobDeps, dir: string): Promise<T> {
  const callsBefore = ctx.riot.callCount;
  const startedAt = Date.now();
  if (DB_GATED_JOBS.has(job)) {
    try {
      const j = await deps.assertDbWritable(job);
      if (j.verdict === "warn") log.warn(job, "운영 DB 점검 경고", { reasons: j.reasons.join(" ; ") });
    } catch (e) { writeStop("blocked_external", `운영 DB 점검 — ${errorMessage(e)}`, dir); throw e; }
  }
  try {
    const result = await fn();
    const apiCalls = ctx.riot.callCount - callsBefore;
    const failed = result.failed ?? 0;
    writeResult({ engine: job, processed: result.processed, api_calls: apiCalls, error: failed > 0 ? `부분 실패 ${failed}건 — detail 참고` : null, detail: result.detail }, dir);
    if (failed > 0) {
      writeStop("error", `부분 실패 ${failed}건 · 처리 ${result.processed}건`, dir);
      process.exitCode = 3;
      log.warn(job, `부분 실패 ${failed}건`, { processed: result.processed, ...result.detail });
      return result;
    }
    writeStop("completed", `${result.processed}건 처리`, dir);
    log.info(job, "완료", { processed: result.processed, api: apiCalls, ms: Date.now() - startedAt, ...result.detail });
    return result;
  } catch (e) {
    const blocked = deps.noteWriteBlocked(e, `worker ${job}`);
    writeResult({ engine: job, api_calls: ctx.riot.callCount - callsBefore, error: errorMessage(e) }, dir);
    writeStop(blocked ? "blocked_external" : "error", blocked ? `운영 DB 쓰기 차단 — ${errorMessage(e)}` : errorMessage(e), dir);
    throw e;
  }
}
