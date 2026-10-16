/**
 * **진행 방식(event.format)** — 경기 분류의 단일 출처(docs/CLASSIFICATION-REDESIGN-PLAN.md §3.2).
 *
 * 분류는 두 가지뿐이다: 맵(롤 협곡/칼바람 — match.map)과 이 진행 방식. 진행 방식은 **행사에만** 있고,
 * 판은 세트 → 시리즈 → 행사 한 길로 그것을 찾는다. 수집 경로(API·영상·수기·토너먼트 코드)는 분류를 정하지 않는다.
 *
 * ★ concept 은 사람이 고르는 값이다 — 모를 때 떨어지는 칸이 아니다. 모르면 unclassified.
 *   옛 "기타(other)"가 쓰레기통이 된 원인이 둘을 섞은 것이었다.
 * ★ DB 의 CHECK(event_format_by_game)와 같은 목록이다. scripts/verify-skeleton.ts 가 둘을 대조한다.
 */

export const GAMES = ["lol", "fconline"] as const;
export type GameCode = (typeof GAMES)[number];

export const FORMATS = ["ck", "land", "tournament", "scrim", "solo_bet", "concept", "friendly", "unclassified"] as const;
export type Format = (typeof FORMATS)[number];

/** 게임별 허용값 = 화면 칩 순서("전체" 다음부터). 마지막은 언제나 미분류("분류 전"). */
export const FORMATS_BY_GAME: Record<GameCode, readonly Format[]> = {
  lol: ["ck", "tournament", "concept", "scrim", "land", "solo_bet", "unclassified"],
  fconline: ["tournament", "ck", "concept", "friendly", "unclassified"],
};

const LABEL: Record<Format, string> = {
  ck: "CK", land: "랜드", tournament: "대회", scrim: "스크림", solo_bet: "솔랭내기",
  concept: "컨셉", friendly: "친선", unclassified: "분류 전",
};

/** 필터 칩 이름. 미분류도 칩은 있다("분류 전") — "전체" 가 칩들의 합이 되려면 빠지는 값이 없어야 한다. */
export const formatChipLabel = (f: Format) => LABEL[f];

/** 경기·행사 한 줄에 붙이는 라벨. 미분류는 라벨을 붙이지 않는다 — 확인된 것만 이름을 단다. */
export const formatLabel = (f: Format): string | null => (f === "unclassified" ? null : LABEL[f]);

export const isFormat = (v: string): v is Format => (FORMATS as readonly string[]).includes(v);

export function allowedFormat(game: GameCode, f: Format): boolean {
  return FORMATS_BY_GAME[game].includes(f);
}
