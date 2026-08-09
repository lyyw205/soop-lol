/**
 * 매치 하나를 가져와 적재하는 최소 단위. Engine B 와 C 가 공유한다.
 *
 * 루프는 공유하지 않는다 — B 는 "새 것 전부", C 는 "커서를 안전하게 내리면서 일부만"이라
 * 종료 조건이 다르다. 억지로 합치면 커서 로직이 두 엔진의 조건을 다 떠안는다.
 */

import { markDeadMatch, saveMatch } from "@soop-lol/core/lib/db/ingest";

import { isFatal, type WorkerContext } from "./context.ts";
import { errorMessage, log } from "./log.ts";

export interface IngestOneResult {
  state: "saved" | "duplicate" | "dead" | "error";
  /** 매치 생성 시각. 커서를 움직이는 근거. dead/error 면 null. */
  at: Date | null;
  encounters: number;
}

export async function ingestOne(ctx: WorkerContext, matchId: string): Promise<IngestOneResult> {
  try {
    const dto = await ctx.riot.match(matchId);
    if (!dto) {
      // 404 는 정상이다 — 2년이 지나 삭제된 경기. 다시 시도하지 않는다.
      await markDeadMatch(matchId);
      return { state: "dead", at: null, encounters: 0 };
    }
    const saved = await saveMatch(dto);
    return {
      state: saved.inserted ? "saved" : "duplicate",
      at: saved.game_creation,
      encounters: saved.encounters,
    };
  } catch (e) {
    if (isFatal(e)) throw e;
    log.error("ingest", "매치 적재 실패", { matchId, error: errorMessage(e) });
    return { state: "error", at: null, encounters: 0 };
  }
}
