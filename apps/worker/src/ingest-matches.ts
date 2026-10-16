/**
 * 매치 하나를 가져와 적재하는 최소 단위. Engine B 와 C 가 공유한다.
 *
 * 루프는 공유하지 않는다 — B 는 "새 것 전부", C 는 "커서를 안전하게 내리면서 일부만"이라
 * 종료 조건이 다르다. 억지로 합치면 커서 로직이 두 엔진의 조건을 다 떠안는다.
 *
 * ★ 무엇을 저장할지는 여기서 정하지 않는다 — saveMatch 가 지명(collection_target)을 다시 확인한다.
 *   지명 밖 판이면 아무것도 쓰지 않고 `skipped` 다(시각은 돌려준다 — 그 판까지는 본 것이라 커서는 지나가도 된다).
 */

import { markDeadMatch, saveMatch } from "@soop-lol/core/lib/db/ingest";

import { isFatal, type WorkerContext } from "./context.ts";
import { errorMessage, log } from "./log.ts";

export interface IngestOneResult {
  state: "saved" | "duplicate" | "skipped" | "dead" | "error";
  /** 매치 생성 시각. 커서를 움직이는 근거. dead/error 면 null. */
  at: Date | null;
  /** 새로 넣은 지명 계정 상세 행 수. */
  details: number;
}

export async function ingestOne(ctx: WorkerContext, matchId: string): Promise<IngestOneResult> {
  try {
    const dto = await ctx.riot.match(matchId);
    if (!dto) {
      // 404 는 정상이다 — 2년이 지나 삭제된 경기. 다시 시도하지 않는다.
      await markDeadMatch(matchId);
      return { state: "dead", at: null, details: 0 };
    }
    const saved = await saveMatch(dto);
    const state = saved.state === "saved" ? "saved" : saved.state === "duplicate" ? "duplicate" : "skipped";
    if (state === "skipped") log.warn("ingest", "지명 범위 밖 판 — 저장하지 않는다", { matchId, queue: dto.info.queueId });
    return { state, at: saved.game_creation, details: saved.details };
  } catch (e) {
    if (isFatal(e)) throw e;
    log.error("ingest", "매치 적재 실패", { matchId, error: errorMessage(e) });
    return { state: "error", at: null, details: 0 };
  }
}
