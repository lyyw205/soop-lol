/**
 * 상대 전적 목록의 정렬.
 *
 * ★ 왜 SQL 이 아니라 여기인가
 *   승률 정렬은 **생 승률로 하면 안 된다**(§11-3). 1승 0패가 3승 1패를 이기고
 *   맨 위로 올라오면 그 목록은 거짓말이다. 베이지안 축소를 거쳐야 하는데,
 *   그 계산은 `affinity.ts` 한 곳에만 두기로 했다 — SQL 은 승·패를 세는 데까지만 하고
 *   지수와 정렬은 TS 에서 한다. 한 스트리머의 상대는 많아야 수백 명이라 부담이 없다.
 *
 *   그래서 정렬 셋 다 여기서 한다. 하나만 TS 로 빼면 "이 정렬은 어디 있더라" 가 된다.
 */

import { affinity, games, type HeadToHead } from "./affinity.ts";

export const OPPONENT_SORTS = [
  { key: "games", label: "판수순", hint: "많이 만난 순" },
  { key: "recent", label: "최신순", hint: "마지막으로 만난 순" },
  { key: "winrate", label: "승률순", hint: "맞붙었을 때 기준 · 표본이 작으면 5할로 당깁니다" },
] as const;

export type OpponentSort = (typeof OPPONENT_SORTS)[number]["key"];

export const DEFAULT_OPPONENT_SORT: OpponentSort = "games";

export function isOpponentSort(v: string | null | undefined): v is OpponentSort {
  return OPPONENT_SORTS.some((s) => s.key === v);
}

/** 정렬에 필요한 것만 본다 — `OpponentRow` 전체를 요구하면 테스트가 못 쓴다. */
export interface SortableOpponent {
  vs_matches: number;
  vs_match_wins: number;
  vs_match_draws: number;
  ally_matches: number;
  last_met: Date | string;
}

/** 맞붙었을 때의 전적. 승률 정렬은 이걸 쓴다 — 같은 팀 승률과 섞지 않는다. */
export function versusRecord(r: SortableOpponent): HeadToHead {
  return {
    wins: r.vs_match_wins,
    draws: r.vs_match_draws,
    losses: r.vs_matches - r.vs_match_wins - r.vs_match_draws,
  };
}

const time = (v: Date | string) => new Date(v).getTime();
const played = (r: SortableOpponent) => r.vs_matches + r.ally_matches;

/**
 * 정렬한 새 배열을 준다. 원본은 건드리지 않는다.
 *
 * 승률순에서 **맞붙은 적이 없는 상대는 맨 뒤**로 보낸다. 축소를 거치면 0판도
 * 0.5 가 나오는데, 그걸 그대로 두면 '한 번도 안 붙은 사람' 이 5할 상대들 사이에
 * 섞여 앉는다. 없는 걸 중간값으로 보여주는 셈이라 뒤로 뺀다.
 */
export function sortOpponents<T extends SortableOpponent>(rows: T[], sort: OpponentSort): T[] {
  const out = [...rows];
  if (sort === "recent") {
    out.sort((a, b) => time(b.last_met) - time(a.last_met) || played(b) - played(a));
  } else if (sort === "winrate") {
    out.sort((a, b) => {
      if ((a.vs_matches === 0) !== (b.vs_matches === 0)) return a.vs_matches === 0 ? 1 : -1;
      const ra = versusRecord(a);
      const rb = versusRecord(b);
      return (
        affinity(rb) - affinity(ra) ||
        games(rb) - games(ra) ||
        time(b.last_met) - time(a.last_met)
      );
    });
  } else {
    out.sort((a, b) => played(b) - played(a) || time(b.last_met) - time(a.last_met));
  }
  return out;
}
