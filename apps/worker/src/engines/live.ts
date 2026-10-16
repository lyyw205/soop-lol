/**
 * Engine B — 지명 수집의 신규 판 따라잡기 (docs/CLASSIFICATION-REDESIGN-PLAN.md §4).
 *
 * ★ 대상은 지명 범위(collection_scope — 지명된 사람의 연결 계정 × 큐 × 기간)뿐이다. 연결된 계정 전원을 순회하지 않는다 — 옛 구조는 그래서
 *   하루 2.7만 판을 쌓았다. 지명 밖의 판은 Riot 에 묻지도 않고(matchIds 의 queue·startTime·endTime),
 *   혹시 섞여 와도 saveMatch 가 저장하지 않는다.
 *
 * spectator 를 **먼저** 본다. 이유는 낭비를 줄이기 위해서다:
 * 게임을 안 한 사람에게 10분마다 match-v5 를 찌르면 그 호출은 전부 버려진다.
 * "직전엔 게임 중이었는데 지금은 아닌" 계정만 조회하면 호출이 실제 경기 수에 비례한다.
 *
 * 게임 중 여부는 **메모리에만** 둔다. 워커를 재시작하면 전이를 한 번 놓치는데,
 * 그건 N틱마다 도는 전수 조사(sweep)가 메운다. 잃어도 되는 상태다.
 */

import { listLiveScopes, newestCoveredAt, type CollectionScope } from "@soop-lol/core/lib/db/collection";
import {
  filterUnknownMatchIds,
  filterUnmappedPuuids,
  noteAccountMatchSynced,
  recordAccountCandidates,
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
  const targets = await listLiveScopes(now, ctx.cfg.liveLookbackMs);
  if (targets.length === 0) return { processed: 0, detail: { note: "지명 수집 대상이 없다" } };

  state.tick++;
  // 첫 틱과 N틱마다는 전수 조사. spectator 전이를 놓쳐도 여기서 따라잡힌다.
  // (N=1 이면 나머지가 항상 0 이라 조건이 영원히 거짓이 된다 — 그래서 따로 걸러낸다)
  const sweep = ctx.cfg.liveSweepEveryTicks <= 1 || state.tick % ctx.cfg.liveSweepEveryTicks === 1;

  // 한 계정에 지명이 여럿(큐·기간별)일 수 있다 — spectator 는 계정마다 한 번.
  const accounts = new Map<string, CollectionScope>();
  for (const t of targets) if (!accounts.has(t.puuid)) accounts.set(t.puuid, t);

  const { inGame, candidates } = await scanLive(ctx, [...accounts.values()]);
  const justFinished = new Set([...accounts.keys()].filter((p) => state.inGame.has(p) && !inGame.has(p)));
  state.inGame = inGame;

  // 게임 중인 계정은 건너뛴다 — 아직 끝나지 않은 경기다.
  const toFetch = targets.filter((t) => (sweep || justFinished.has(t.puuid)) && !inGame.has(t.puuid));

  let ingested = 0;
  let details = 0;
  for (const t of toFetch) {
    try {
      const r = await catchUp(ctx, t, now);
      ingested += r.ingested;
      details += r.details;
    } catch (e) {
      if (isFatal(e)) throw e;
      log.error(SCOPE, "따라잡기 실패", { target: t.label, queue: t.queue_id, error: errorMessage(e) });
    }
  }

  const candidatesSaved = await recordAccountCandidates(candidates);

  return {
    processed: ingested,
    detail: {
      tick: state.tick,
      sweep,
      targets: targets.length,
      accounts: accounts.size,
      inGame: inGame.size,
      justFinished: justFinished.size,
      checked: toFetch.length,
      details,
      candidates: candidatesSaved,
    },
  };
}

/** spectator 한 바퀴. 게임 중인 지명 계정과, 같은 로비에서 본 미매핑 puuid 를 모은다. */
async function scanLive(ctx: WorkerContext, accounts: CollectionScope[]) {
  const inGame = new Set<string>();
  const lobby = new Map<string, { game_name: string | null; tag_line: string | null; seen_with: Set<string> }>();

  for (const t of accounts) {
    let game;
    try {
      game = await ctx.riot.activeGameByPuuid(t.puuid);
    } catch (e) {
      if (isFatal(e)) throw e;
      log.warn(SCOPE, "spectator 실패", { target: t.label, error: errorMessage(e) });
      continue;
    }
    if (!game) continue;

    inGame.add(t.puuid);
    // 후보의 근거는 "누구와 같이 있었나" 다 — 스트리머에 안 붙은 지명 계정의 로비는 근거가 없어 쌓지 않는다.
    if (!t.streamer_id) continue;
    for (const p of game.participants ?? []) {
      // ★ spectator-v5 는 puuid 가 비어 있는 참가자를 섞어서 준다 (봇, 또는 Riot 이
      //   가려서 내려주는 계정). 이걸 그대로 키로 쓰면 후보 테이블의 NOT NULL 에서 터진다.
      //   실제로 첫 실전 수집이 여기서 죽었다 — 조용히 넘어갈 값이 아니라 걸러낼 값이다.
      if (!p.puuid) continue;
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

/** 이 지명으로 가진 가장 최근 판 이후의 새 판을 전부 적재한다. */
async function catchUp(ctx: WorkerContext, t: CollectionScope, now: Date) {
  // 이 지명으로 아직 가진 판이 없으면 최근 며칠만 본다 — 그 이전은 Engine C(백필)의 일이다.
  const covered = await newestCoveredAt(t);
  const lookback = new Date(now.getTime() - ctx.cfg.liveLookbackMs);
  const since = new Date(Math.max(t.starts_at.getTime(), (covered ?? lookback).getTime()));
  const ids = await ctx.riot.matchIds(t.puuid, {
    queue: t.queue_id,
    startTime: toEpochSeconds(since),
    endTime: t.ends_at ? toEpochSeconds(t.ends_at) : undefined,
    count: 100,
  });
  const unknown = await filterUnknownMatchIds(ids);
  if (unknown.length === 0) return { ingested: 0, details: 0 };

  let ingested = 0;
  let details = 0;
  let newest: Date | null = null;

  // 최신순으로 온다. 오래된 것부터 넣어야 중간에 끊겨도 시작점(가장 최근에 가진 판)이 앞서가지 않는다.
  for (const id of [...unknown].reverse()) {
    const r = await ingestOne(ctx, id);
    if (r.state === "error") break;
    if (r.state === "saved") ingested++;
    details += r.details;
    if (r.state !== "skipped" && r.at && (!newest || r.at > newest)) newest = r.at;
  }

  if (newest) await noteAccountMatchSynced(t.puuid, newest);
  if (ingested > 0) {
    log.info(SCOPE, t.label, { queue: t.queue_id, order: t.slug, new: ingested, details });
  }
  return { ingested, details };
}
