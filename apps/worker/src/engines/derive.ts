/**
 * Engine D — 파생 재계산 (docs/PLAN.md §5).
 *
 * ★ 이 엔진의 존재 이유: **신규 스트리머를 등록하면 과거 매치의 조우가 비어 있다.**
 *   그 사람이 이미 우리 DB 에 있는 경기에 열 번 나왔어도, 등록 전에는 그냥
 *   `match_participant` 의 익명 puuid 였다. 재파생을 빼먹으면 "만난 적 없음"으로 보인다.
 *
 * Riot API 를 **한 번도 부르지 않는다**. 전부 우리 DB 안의 재계산이라
 * 레이트리밋과 무관하게 아무 때나 돌려도 된다.
 */

import {
  findMatchesNeedingEncounters,
  pruneOrphanEncounters,
  recomputeChampionStats,
  rederiveEncounters,
} from "@soop-lol/core/lib/db/ingest";

import type { WorkerContext } from "../context.ts";
import type { EngineResult } from "../job.ts";
import { log } from "../log.ts";

const SCOPE = "engineD";

export async function runDeriveEngine(
  _ctx: WorkerContext,
  opts: { batch?: number; maxRounds?: number; championStats?: boolean } = {},
): Promise<EngineResult> {
  const batch = opts.batch ?? 500;
  const maxRounds = opts.maxRounds ?? 20;

  // 매핑이 풀린 조우부터 지운다. 남겨두면 없는 전적이 화면에 뜬다.
  const pruned = await pruneOrphanEncounters();
  if (pruned > 0) log.info(SCOPE, "근거를 잃은 조우 삭제", { rows: pruned });

  let matches = 0;
  let encounters = 0;
  for (let round = 0; round < maxRounds; round++) {
    const ids = await findMatchesNeedingEncounters(batch);
    if (ids.length === 0) break;
    encounters += await rederiveEncounters(ids);
    matches += ids.length;
    if (ids.length < batch) break;
  }

  let championStats: number | undefined;
  if (opts.championStats) {
    championStats = await recomputeChampionStats();
  }

  return {
    processed: matches,
    detail: { pruned, encounters, championStats },
  };
}
