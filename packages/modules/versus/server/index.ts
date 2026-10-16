/**
 * 상대전적 모듈 — 서버.
 *
 * 계약 안에서만 움직인다:
 *   · 코어는 `@soop-lol/core/lib/contract` 로만 읽는다
 *   · 다른 모듈을 모른다
 *
 * ★ 상대전적을 다시 만들지 않는다
 *   "누가 같은 판에 있었나" 는 코어의 공개 내전 세트(core_public.versus_pair_set)이고, 세는 규칙은 코어의 tally 다.
 *   이 모듈은 그것을 읽어 그린다. 같은 것을 두 군데서 만들면 반드시 어긋난다.
 * ★ 롤업 표(mod_versus.pair)와 매시간 재계산(recompute)은 지웠다 — 아무도 읽지 않았고(2026-10 감사),
 *   숨김을 늦게 듣는 사본이었다. 공개 뷰를 질의 시점에 읽으므로 숨김이 바로 반영된다.
 */

import { listOpponentSummaries, sortOpponents, type OpponentSummary } from "@soop-lol/core/lib/contract";

/**
 * 한 사람의 "자주 만난 매치업" — **맞라인 세트**가 많은 상대 순. 협곡 · 전체 진행 방식 · 전체 기간.
 * ★ 상대전적 상세의 맞라인 보기(같은 기본 필터)와 같은 고르기·같은 세기다 — 사이드바 숫자와 상세 숫자가 같다.
 */
export async function topLaneOpponents(streamerId: string, limit = 3, excludeIds: string[] = []): Promise<OpponentSummary[]> {
  const rows = await listOpponentSummaries(streamerId, { map: "rift", laneOnly: true });
  return sortOpponents(rows.filter((r) => !excludeIds.includes(r.other_id)), "games").slice(0, limit);
}
