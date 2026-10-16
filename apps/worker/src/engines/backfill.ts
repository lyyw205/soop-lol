/**
 * Engine C — 지명 수집의 과거 백필 (docs/CLASSIFICATION-REDESIGN-PLAN.md §4).
 *
 * ★ 대상은 지명 범위(collection_scope — 지명된 사람의 연결 계정 × 큐 × 기간)의 칸 하나씩이다. 옛 ingest_cursor(연결된 계정 전원)의 검증된 로직 —
 *   커서를 반드시 내리기, 끝(기간 시작·2년 보존 경계·빈 응답·전부 삭제된 구간) 감지, SKIP LOCKED — 는 그대로 쓰고
 *   키만 지명 단위로 바꿨다. Riot 에는 그 지명의 큐·기간만 묻는다(matchIds 의 queue·startTime·endTime).
 *
 * **시한부 작업이다.** match-v5 보존은 2년이고 실제로는 더 짧을 수 있다.
 * 지명을 정하면 즉시 긁어야 하고, 못 긁은 구간은 나중에 어떤 방법으로도 못 메운다.
 *
 * 우선순위는 가장 낮다. 그래서 한 번 호출에 **한 조각만** 한다 —
 * 09:00 랭크 스냅샷이나 라이브 폴링이 백필에 밀려 늦어지면 안 된다.
 */

import { claimBackfillScope, saveScopeProgress, type CollectionScope } from "@soop-lol/core/lib/db/collection";
import { filterUnknownMatchIds, matchCoverage } from "@soop-lol/core/lib/db/ingest";
import { toEpochSeconds } from "@soop-lol/core/lib/time";

import { isFatal, type WorkerContext } from "../context.ts";
import { ingestOne } from "../ingest-matches.ts";
import type { EngineResult } from "../job.ts";
import { errorMessage, log } from "../log.ts";

const SCOPE = "engineC";
const YEAR_MS = 365.25 * 24 * 60 * 60 * 1000;

export interface BackfillSliceResult extends EngineResult {
  /** 더 팔 지명이 없다. 스케줄러가 이걸 보고 백필을 쉰다. */
  exhausted: boolean;
}

export async function runBackfillSlice(ctx: WorkerContext, now = new Date()): Promise<BackfillSliceResult> {
  const target = await claimBackfillScope(undefined, now);
  if (!target) return { processed: 0, exhausted: true, detail: { note: "백필할 지명이 없다" } };

  // 아래 끝: 지명 기간의 시작과 Riot 보존 경계 중 늦은 쪽. 위 끝: 커서가 없으면 기간의 끝(열린 기간이면 지금).
  const retention = new Date(now.getTime() - ctx.cfg.backfillYears * YEAR_MS);
  const horizon = new Date(Math.max(target.starts_at.getTime(), retention.getTime()));
  const before = target.cursor_before
    ?? (target.ends_at && target.ends_at < now ? target.ends_at : now);
  const who = { target: target.label, queue: target.queue_id, order: target.slug };

  if (before <= horizon) {
    await saveScopeProgress({ id: target.id, state: "done", reachedEnd: true });
    log.info(SCOPE, "기간 시작(또는 2년 경계) 도달", who);
    return { processed: 0, exhausted: false, detail: { ...who, reachedEnd: true } };
  }

  try {
    return await slice(ctx, target, horizon, before);
  } catch (e) {
    if (isFatal(e)) {
      // 키가 죽었다. 이건 지명 문제가 아니므로 실패로 남기지 않는다.
      await saveScopeProgress({ id: target.id, state: "pending" });
      throw e;
    }
    await saveScopeProgress({ id: target.id, state: "error", error: errorMessage(e) });
    log.error(SCOPE, "백필 슬라이스 실패", { ...who, error: errorMessage(e) });
    return { processed: 0, exhausted: false, detail: { ...who, error: true } };
  }
}

async function slice(
  ctx: WorkerContext,
  target: CollectionScope,
  horizon: Date,
  before: Date,
): Promise<BackfillSliceResult> {
  const who = { target: target.label, queue: target.queue_id, order: target.slug };
  const ids = await ctx.riot.matchIds(target.puuid, {
    queue: target.queue_id,
    startTime: toEpochSeconds(horizon),
    endTime: toEpochSeconds(before),
    count: 100,
  });

  if (ids.length === 0) {
    await saveScopeProgress({ id: target.id, state: "done", reachedEnd: true });
    log.info(SCOPE, "백필 완료", who);
    return { processed: 0, exhausted: false, detail: { ...who, reachedEnd: true } };
  }

  const unknown = new Set(await filterUnknownMatchIds(ids));
  const known = await matchCoverage(ids.filter((id) => !unknown.has(id)), target.puuid);

  // ids 는 최신순이다. **순서대로** 훑으며 커서를 내린다 —
  // 중간을 건너뛰면 그 구간은 다시 볼 방법이 없다.
  let fetched = 0;
  let ingested = 0;
  let dead = 0;
  let details = 0;
  let oldestCovered: Date | null = null;
  let stopped = false;

  for (const id of ids) {
    const cached = known.get(id);
    if (cached && !cached.needs_detail) {
      // 이미 다 갖춘 매치. API 를 쓰지 않고 커서만 내린다.
      oldestCovered = cached.at;
      continue;
    }
    if (!cached && !unknown.has(id)) {
      // dead_match 로 이미 걸러진 id. 시각을 모르니 커서는 그대로 둔다.
      continue;
    }
    // 처음 보는 판, 또는 가진 판인데 이 지명 계정의 상세가 빠진 판(다른 지명으로 먼저 들어왔다) — 받아서 채운다.
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
    details += r.details;
    if (r.at) oldestCovered = r.at;
  }

  // 배치를 통째로 훑었는데 시각을 하나도 못 얻었다 = 이 구간이 전부 삭제된 경기다.
  // 커서를 못 내리므로 여기서 멈추지 않으면 같은 창을 영원히 다시 요청한다.
  if (!oldestCovered) {
    if (stopped) {
      await saveScopeProgress({ id: target.id, state: "pending" });
    } else {
      await saveScopeProgress({ id: target.id, state: "done", reachedEnd: true });
      log.warn(SCOPE, "구간 전체가 삭제된 경기라 백필을 종료한다", { ...who, ids: ids.length });
    }
    return { processed: ingested, exhausted: false, detail: { ...who, dead } };
  }

  await saveScopeProgress({
    id: target.id,
    // 1초 물러선다. 경계 매치를 다시 받아도 filterUnknownMatchIds·matchCoverage 가 걸러낸다.
    before: new Date(oldestCovered.getTime() - 1000),
    state: "pending",
  });

  log.info(SCOPE, "슬라이스", {
    ...who,
    ids: ids.length,
    new: ingested,
    details,
    dead,
    until: oldestCovered.toISOString().slice(0, 10),
  });

  return {
    processed: ingested,
    exhausted: false,
    detail: { ...who, ids: ids.length, dead, details },
  };
}
