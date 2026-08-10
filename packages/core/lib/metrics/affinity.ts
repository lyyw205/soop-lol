/**
 * 상성지수 — 표본이 작다는 사실을 정직하게 다루는 승률.
 *
 * 원칙 (docs/PLAN.md §11-3): 3승 0패를 "승률 100%"로 쓰면 그냥 거짓말이다.
 * 내전 몇 판짜리 표본은 노이즈이므로 **베이지안 축소**로 0.5 쪽으로 당기고,
 * **표본 수를 화면에서 절대 숨기지 않는다.**
 *
 * 이 계산은 TS 한 곳에만 둔다. SQL 은 승/패 카운트까지만 세고,
 * 지수 계산과 정렬은 여기서 한다 (한 스트리머의 상대는 많아야 수백 명이라 문제없다).
 */

/** 가상 경기 수. 4면 "4판을 5할로 이미 치렀다"고 보는 셈. */
export const SHRINKAGE_ALPHA = 4;
export const PRIOR_WIN_RATE = 0.5;

/** 이 아래면 화면에 '참고용' 뱃지를 단다. */
export const SMALL_SAMPLE_THRESHOLD = 5;

export interface HeadToHead {
  wins: number;
  losses: number;
  /**
   * 무승부. 2014~2017 회차 조별리그가 2세트제라 1:1 로 끝나는 경기가 있다.
   * 없는 회차가 대부분이라 선택 항목이다.
   *
   * ★ 승률에서 무승부는 **분모에서도 뺀다**. 1승 1무면 50% 가 아니라 100% 다 —
   *   무승부는 진 게 아니다. 대신 화면에는 `1승 1무` 로 무승부 수를 항상 같이 적는다.
   */
  draws?: number;
}

/** 승부가 난 경기 수. 승률의 분모다. */
export const games = (h: HeadToHead) => h.wins + h.losses;

/** 무승부까지 포함한 전체 경기 수. 표본 크기를 말할 때 쓴다. */
export const played = (h: HeadToHead) => h.wins + h.losses + (h.draws ?? 0);

/** 보정 없는 생 승률. 표시용으로만 쓰고 정렬에는 쓰지 않는다. */
export function rawWinRate(h: HeadToHead): number | null {
  const n = games(h);
  return n === 0 ? null : h.wins / n;
}

/**
 * 상성지수. 0~1. 정렬·랭킹은 **반드시 이 값**으로 한다.
 *   3승 0패  → 0.71  (생 승률 100% → 5/7 로 당겨진다)
 *   20승 5패 → 0.76  (생 승률 80%. 표본이 크면 생 승률에 수렴)
 */
export function affinity(h: HeadToHead, alpha = SHRINKAGE_ALPHA): number {
  return (h.wins + alpha * PRIOR_WIN_RATE) / (games(h) + alpha);
}

export function isSmallSample(h: HeadToHead): boolean {
  return played(h) < SMALL_SAMPLE_THRESHOLD;
}

export interface OpponentRecord<T = unknown> extends HeadToHead {
  opponent: T;
}

export interface RankedOpponent<T> extends OpponentRecord<T> {
  affinity: number;
  rawWinRate: number | null;
  games: number;
  smallSample: boolean;
}

function decorate<T>(r: OpponentRecord<T>): RankedOpponent<T> {
  return {
    ...r,
    affinity: affinity(r),
    rawWinRate: rawWinRate(r),
    games: games(r),
    smallSample: isSmallSample(r),
  };
}

export interface RivalryOptions {
  /** 천적/밥 후보로 올릴 최소 경기 수. 기본은 '참고용' 경계와 같다. */
  minGames?: number;
  limit?: number;
}

/**
 * 천적(가장 못 이기는 상대)과 밥(가장 잘 이기는 상대).
 * 표본이 모자란 상대는 애초에 후보에서 뺀다 — 1패뿐인 상대를 '천적'이라 부르면 안 된다.
 */
export function rivalries<T>(
  records: OpponentRecord<T>[],
  opts: RivalryOptions = {},
): { nemeses: RankedOpponent<T>[]; prey: RankedOpponent<T>[] } {
  const minGames = opts.minGames ?? SMALL_SAMPLE_THRESHOLD;
  const limit = opts.limit ?? 3;
  const eligible = records.map(decorate).filter((r) => r.games >= minGames);
  const ascending = [...eligible].sort((a, b) => a.affinity - b.affinity || b.games - a.games);
  return {
    nemeses: ascending.slice(0, limit),
    prey: [...ascending].reverse().slice(0, limit),
  };
}

/** 가장 자주 만난 상대. 표본 하한이 없다 — 이건 승률이 아니라 횟수라서 왜곡이 없다. */
export function mostFrequent<T>(records: OpponentRecord<T>[], limit = 5): RankedOpponent<T>[] {
  return records
    .map(decorate)
    .sort((a, b) => b.games - a.games)
    .slice(0, limit);
}

/** 화면 표기용. 표본이 작으면 그렇다고 말한다. */
export function formatRecord(h: HeadToHead): string {
  const total = played(h);
  if (total === 0) return "맞대결 없음";
  const d = h.draws ?? 0;
  const body = d > 0 ? `${h.wins}승 ${d}무 ${h.losses}패` : `${h.wins}승 ${h.losses}패`;
  const n = games(h);
  const base = n === 0 ? body : `${body} (${Math.round((h.wins / n) * 100)}%)`;
  return isSmallSample(h) ? `${base} · ${total}경기 참고용` : base;
}
