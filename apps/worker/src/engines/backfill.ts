/**
 * Engine C — 과거 백필 (docs/PLAN.md §5).
 *
 * **시한부 작업이다.** match-v5 보존은 2년이고 실제로는 더 짧을 수 있다.
 * 명단이 정해지면 즉시 긁어야 하고, 못 긁은 구간은 나중에 어떤 방법으로도 못 메운다.
 *
 * 우선순위는 가장 낮다. 그래서 한 번 호출에 **한 조각만** 한다 —
 * 09:00 랭크 스냅샷이나 라이브 폴링이 백필에 밀려 늦어지면 안 된다.
 */

import {
  claimBackfillTarget,
  filterUnknownMatchIds,
  matchCreationTimes,
  saveBackfillProgress,
} from "@soop-lol/core/lib/db/ingest";
import { toEpochSeconds } from "@soop-lol/core/lib/time";

import { isFatal, type WorkerContext } from "../context.ts";
import { ingestOne } from "../ingest-matches.ts";
import type { EngineResult } from "../job.ts";
import { errorMessage, log } from "../log.ts";

const SCOPE = "engineC";
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

export interface BackfillSliceResult extends EngineResult {
  /** 더 팔 계정이 없다. 스케줄러가 이걸 보고 백필을 쉰다. */
  exhausted: boolean;
}

export async function runBackfillSlice(ctx: WorkerContext, now = new Date()): Promise<BackfillSliceResult> {
  const target = await claimBackfillTarget();
  if (!target) return { processed: 0, exhausted: true, detail: { note: "백필 대기열이 비었다" } };

  const horizon = new Date(now.getTime() - ctx.cfg.backfillYears * YEAR_MS);
  const before = target.backfill_before ?? now;

  if (before <= horizon) {
    await saveBackfillProgress({ puuid: target.puuid, state: "done", reachedEnd: true });
    log.info(SCOPE, "2년 경계 도달", { puuid: target.puuid.slice(0, 8) });
    return { processed: 0, exhausted: false, detail: { puuid: target.puuid.slice(0, 8), reachedEnd: true } };
  }

  try {
    return await slice(ctx, target.puuid, horizon, before);
  } catch (e) {
    if (isFatal(e)) {
      // 키가 죽었다. 이건 계정 문제가 아니므로 error_count 를 올리지 않는다.
      await saveBackfillProgress({ puuid: target.puuid, state: "pending" });
      throw e;
    }
    await saveBackfillProgress({ puuid: target.puuid, state: "error", error: errorMessage(e) });
    log.error(SCOPE, "백필 슬라이스 실패", { puuid: target.puuid.slice(0, 8), error: errorMessage(e) });
    return { processed: 0, exhausted: false, detail: { puuid: target.puuid.slice(0, 8), error: true } };
  }
}

async function slice(
  ctx: WorkerContext,
  puuid: string,
  horizon: Date,
  before: Date,
): Promise<BackfillSliceResult> {
  const ids = await ctx.riot.matchIds(puuid, {
    startTime: toEpochSeconds(horizon),
    endTime: toEpochSeconds(before),
    count: 100,
  });

  if (ids.length === 0) {
    await saveBackfillProgress({ puuid, state: "done", reachedEnd: true });
    log.info(SCOPE, "백필 완료", { puuid: puuid.slice(0, 8) });
    return { processed: 0, exhausted: false, detail: { puuid: puuid.slice(0, 8), reachedEnd: true } };
  }

  const unknown = new Set(await filterUnknownMatchIds(ids));
  const known = await matchCreationTimes(ids.filter((id) => !unknown.has(id)));

  // ids 는 최신순이다. **순서대로** 훑으며 커서를 내린다 —
  // 중간을 건너뛰면 그 구간은 다시 볼 방법이 없다.
  let fetched = 0;
  let ingested = 0;
  let dead = 0;
  let encounters = 0;
  let oldestCovered: Date | null = null;
  let stopped = false;

  for (const id of ids) {
    const cached = known.get(id);
    if (cached) {
      // 이미 가진 매치. API 를 쓰지 않고 커서만 내린다.
      oldestCovered = cached;
      continue;
    }
    if (!unknown.has(id)) {
      // dead_match 로 이미 걸러진 id. 시각을 모르니 커서는 그대로 둔다.
      continue;
    }
    if (fetched >= ctx.cfg.backfillBatch) {
      stopped = true;
      break;
    }

    const r = await ingestOne(ctx, id);
    fetched++;
    if (r.state === "error") {
      stopped = true;
      break;
    }
    if (r.state === "saved") ingested++;
    if (r.state === "dead") dead++;
    encounters += r.encounters;
    if (r.at) oldestCovered = r.at;
  }

  // 배치를 통째로 훑었는데 시각을 하나도 못 얻었다 = 이 구간이 전부 삭제된 경기다.
  // 커서를 못 내리므로 여기서 멈추지 않으면 같은 창을 영원히 다시 요청한다.
  if (!oldestCovered) {
    if (stopped) {
      await saveBackfillProgress({ puuid, state: "pending", ingested });
    } else {
      await saveBackfillProgress({ puuid, state: "done", reachedEnd: true, ingested });
      log.warn(SCOPE, "구간 전체가 삭제된 경기라 백필을 종료한다", { puuid: puuid.slice(0, 8), ids: ids.length });
    }
    return { processed: ingested, exhausted: false, detail: { puuid: puuid.slice(0, 8), dead } };
  }

  await saveBackfillProgress({
    puuid,
    // 1초 물러선다. 경계 매치를 다시 받아도 filterUnknownMatchIds 가 걸러낸다.
    before: new Date(oldestCovered.getTime() - 1000),
    ingested,
    state: "pending",
  });

  log.info(SCOPE, "슬라이스", {
    puuid: puuid.slice(0, 8),
    ids: ids.length,
    new: ingested,
    dead,
    enc: encounters,
    until: oldestCovered.toISOString().slice(0, 10),
  });

  return {
    processed: ingested,
    exhausted: false,
    detail: { puuid: puuid.slice(0, 8), ids: ids.length, dead, encounters },
  };
}
