/**
 * Engine B — 신규 매치 따라잡기 (docs/PLAN.md §5).
 *
 * spectator 를 **먼저** 본다. 이유는 낭비를 줄이기 위해서다:
 * 게임을 안 한 사람에게 10분마다 match-v5 를 찌르면 그 호출은 전부 버려진다.
 * "직전엔 게임 중이었는데 지금은 아닌" 계정만 조회하면 호출이 실제 경기 수에 비례한다.
 *
 * 게임 중 여부는 **메모리에만** 둔다. 워커를 재시작하면 전이를 한 번 놓치는데,
 * 그건 N틱마다 도는 전수 조사(sweep)가 메운다. 이걸 위해 테이블을 하나 더 만들
 * 이유는 없다 — 잃어도 되는 상태다.
 */

import {
  advanceMatchCursor,
  filterUnknownMatchIds,
  filterUnmappedPuuids,
  listIngestTargets,
  recordAccountCandidates,
  type IngestTarget,
} from "@soop-lol/core/lib/db/ingest";
import { toEpochSeconds } from "@soop-lol/core/lib/time";

import { isFatal, type WorkerContext } from "../context.ts";
import { ingestOne } from "../ingest-matches.ts";
import type { EngineResult } from "../job.ts";
import { errorMessage, log } from "../log.ts";

const SCOPE = "engineB";

export interface LiveState {
  inGame: Set<string>;
  tick: number;
}

export const createLiveState = (): LiveState => ({ inGame: new Set(), tick: 0 });

export async function runLiveEngine(
  ctx: WorkerContext,
  state: LiveState,
  now = new Date(),
): Promise<EngineResult> {
  const targets = await listIngestTargets();
  if (targets.length === 0) return { processed: 0, detail: { note: "수집 대상 계정이 없다" } };

  state.tick++;
  // 첫 틱과 N틱마다는 전수 조사. spectator 전이를 놓쳐도 여기서 따라잡힌다.
  // (N=1 이면 나머지가 항상 0 이라 조건이 영원히 거짓이 된다 — 그래서 따로 걸러낸다)
  const sweep = ctx.cfg.liveSweepEveryTicks <= 1 || state.tick % ctx.cfg.liveSweepEveryTicks === 1;

  const { inGame, candidates } = await scanLive(ctx, targets);
  const justFinished = targets.filter((t) => state.inGame.has(t.puuid) && !inGame.has(t.puuid));
  state.inGame = inGame;

  // 게임 중인 계정은 건너뛴다 — 아직 끝나지 않은 경기다.
  const toFetch = (sweep ? targets : justFinished).filter((t) => !inGame.has(t.puuid));

  let ingested = 0;
  let encounters = 0;
  for (const t of toFetch) {
    try {
      const r = await catchUp(ctx, t, now);
      ingested += r.ingested;
      encounters += r.encounters;
    } catch (e) {
      if (isFatal(e)) throw e;
      log.error(SCOPE, "따라잡기 실패", { streamer: t.display_name, error: errorMessage(e) });
    }
  }

  const candidatesSaved = await recordAccountCandidates(candidates);

  return {
    processed: ingested,
    detail: {
      tick: state.tick,
      sweep,
      accounts: targets.length,
      inGame: inGame.size,
      justFinished: justFinished.length,
      checked: toFetch.length,
      encounters,
      candidates: candidatesSaved,
    },
  };
}

/** spectator 한 바퀴. 게임 중인 계정과, 같은 로비에서 본 미매핑 puuid 를 모은다. */
async function scanLive(ctx: WorkerContext, targets: IngestTarget[]) {
  const inGame = new Set<string>();
  const lobby = new Map<string, { game_name: string | null; tag_line: string | null; seen_with: Set<string> }>();

  for (const t of targets) {
    let game;
    try {
      game = await ctx.riot.activeGameByPuuid(t.puuid);
    } catch (e) {
      if (isFatal(e)) throw e;
      log.warn(SCOPE, "spectator 실패", { streamer: t.display_name, error: errorMessage(e) });
      continue;
    }
    if (!game) continue;

    inGame.add(t.puuid);
    for (const p of game.participants ?? []) {
      if (p.puuid === t.puuid) continue;
      const [gameName, tagLine] = (p.riotId ?? "").split("#");
      const prev = lobby.get(p.puuid);
      if (prev) {
        prev.seen_with.add(t.streamer_id);
      } else {
        lobby.set(p.puuid, {
          game_name: gameName || null,
          tag_line: tagLine || null,
          seen_with: new Set([t.streamer_id]),
        });
      }
    }
  }

  // 이미 매핑된 계정(다른 스트리머 포함)은 후보가 아니다.
  const unmapped = new Set(await filterUnmappedPuuids([...lobby.keys()]));
  const candidates = [...lobby.entries()]
    .filter(([puuid]) => unmapped.has(puuid))
    .map(([puuid, v]) => ({
      puuid,
      game_name: v.game_name,
      tag_line: v.tag_line,
      seen_with: [...v.seen_with],
    }));

  return { inGame, candidates };
}

/** 커서 이후의 새 매치를 전부 적재한다. */
async function catchUp(ctx: WorkerContext, t: IngestTarget, now: Date) {
  // 커서가 없는 계정을 여기서 2년치 긁지 않는다 — 그건 Engine C 의 일이다.
  const since = t.last_match_synced_at ?? new Date(now.getTime() - ctx.cfg.liveLookbackMs);
  const ids = await ctx.riot.matchIds(t.puuid, { startTime: toEpochSeconds(since), count: 100 });
  const unknown = await filterUnknownMatchIds(ids);
  if (unknown.length === 0) return { ingested: 0, encounters: 0 };

  let ingested = 0;
  let encounters = 0;
  let newest: Date | null = null;

  // 최신순으로 온다. 오래된 것부터 넣어야 중간에 끊겨도 커서가 앞서가지 않는다.
  for (const id of [...unknown].reverse()) {
    const r = await ingestOne(ctx, id);
    if (r.state === "error") break;
    if (r.state === "saved") ingested++;
    encounters += r.encounters;
    if (r.at && (!newest || r.at > newest)) newest = r.at;
  }

  if (newest) await advanceMatchCursor(t.puuid, newest);
  if (ingested > 0) {
    log.info(SCOPE, t.display_name, { acct: t.game_name ?? t.puuid.slice(0, 8), new: ingested, enc: encounters });
  }
  return { ingested, encounters };
}
