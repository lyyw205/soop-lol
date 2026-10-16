import { mirror, type FcoTopPair } from "@soop-lol/core/lib/contract/client";

/**
 * 검색한 사람을 왼쪽에 유지하고, 현재 보고 있는 상대는 추천에서 제외한다.
 * 뒤집을 때는 세트·시리즈 기록을 함께 거울로 돌린다(mirror) — 상대전적은 언제나 대칭이다.
 */
export function relatedPairs(pairs: FcoTopPair[], personId: string, opponentId: string): FcoTopPair[] {
  return pairs.filter((pair) => (pair.a_id === personId || pair.b_id === personId)
    && pair.a_id !== opponentId && pair.b_id !== opponentId)
    .map((pair) => pair.a_id === personId ? pair : {
      ...pair, a_id: pair.b_id, b_id: pair.a_id,
      record: { sets: mirror(pair.record.sets), series: mirror(pair.record.series) },
    });
}
