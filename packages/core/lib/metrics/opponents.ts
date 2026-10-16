/**
 * 상대 전적 목록의 정렬.
 *
 * ★ 왜 SQL 이 아니라 여기인가
 *   승률 정렬은 **생 승률로 하면 안 된다**(§11-3). 1승 0패가 3승 1패를 이기고
 *   맨 위로 올라오면 그 목록은 거짓말이다. 베이지안 축소를 거쳐야 하는데,
 *   그 계산은 `affinity.ts` 한 곳에만 두기로 했다 — SQL 은 승·패를 세는 데까지만 하고
 *   지수와 정렬은 TS 에서 한다. 한 스트리머의 상대는 많아야 수백 명이라 부담이 없다.
 *
 *   그래서 모든 정렬을 여기서 한다. 하나만 TS 로 빼면 "이 정렬은 어디 있더라" 가 된다.
 */

import { affinity, games, headToHead, type HeadToHead } from "./affinity.ts";
import { total, type Tally } from "./tally.ts";

export const OPPONENT_SORTS = [
  { key: "games", label: "판수순", hint: "많이 만난 순" },
  { key: "recent", label: "최신순", hint: "마지막으로 만난 순" },
  { key: "winrate", label: "승률 높은순", hint: "맞붙었을 때 기준 · 표본이 작으면 5할로 당깁니다" },
  { key: "winrate_asc", label: "승률 낮은순", hint: "맞붙었을 때 기준 · 표본이 작으면 5할로 당깁니다" },
] as const;

export type OpponentSort = (typeof OPPONENT_SORTS)[number]["key"];

export const DEFAULT_OPPONENT_SORT: OpponentSort = "games";

export function isOpponentSort(v: string | null | undefined): v is OpponentSort {
  return OPPONENT_SORTS.some((s) => s.key === v);
}

/** 정렬에 필요한 것만 본다 — 세트·시리즈 집계(tally 결과)와 마지막으로 만난 날. */
export interface SortableOpponent {
  record: Tally;
  last_met: Date | string;
}

/**
 * 승률 정렬의 재료 = **시리즈** 전적. 미상은 승률의 분모에서 뺀다(진 것도 이긴 것도 아니다).
 * ★ 세트로 정렬하지 않는다 — 다전제 한 번이 단판 세 번처럼 무게를 갖게 된다.
 */
export function versusRecord(r: SortableOpponent): HeadToHead {
  return headToHead(r.record.series);
}

const time = (v: Date | string) => new Date(v).getTime();
/** 판수순의 판 = 세트. 표에 보이는 "N세트" 와 같은 수로 줄을 세운다. */
const played = (r: SortableOpponent) => total(r.record.sets);

/**
 * 정렬한 새 배열을 준다. 원본은 건드리지 않는다.
 *
 * 승률순에서 **승부가 난 시리즈가 없는 상대는 맨 뒤**로 보낸다. 축소를 거치면 0판도
 * 0.5 가 나오는데, 그걸 그대로 두면 '승부를 가린 적 없는 사람' 이 5할 상대들 사이에
 * 섞여 앉는다. 없는 걸 중간값으로 보여주는 셈이라 뒤로 뺀다.
 */
export function sortOpponents<T extends SortableOpponent>(rows: T[], sort: OpponentSort): T[] {
  const out = [...rows];
  if (sort === "recent") {
    out.sort((a, b) => time(b.last_met) - time(a.last_met) || played(b) - played(a));
  } else if (sort === "winrate" || sort === "winrate_asc") {
    out.sort((a, b) => {
      const ra = versusRecord(a);
      const rb = versusRecord(b);
      if ((games(ra) === 0) !== (games(rb) === 0)) return games(ra) === 0 ? 1 : -1;
      return (
        (sort === "winrate_asc" ? affinity(ra) - affinity(rb) : affinity(rb) - affinity(ra)) ||
        games(rb) - games(ra) ||
        time(b.last_met) - time(a.last_met)
      );
    });
  } else {
    out.sort((a, b) => played(b) - played(a) || time(b.last_met) - time(a.last_met));
  }
  return out;
}
