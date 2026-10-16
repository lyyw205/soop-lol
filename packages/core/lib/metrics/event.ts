import { placementRank } from "./placement.ts";

/** 행사 종류와 수상 판정. 수집 경로나 화면 탭 이름으로 행사 종류를 추측하지 않는다. */
export const TOURNAMENT_KIND = "tournament";
export const EVENT_KIND_LABEL: Record<string, string> = {
  ck: "CK", land: "랜드", tournament: "대회", showmatch: "이벤트전", scrim: "스크림", other: "기타",
};
export const eventKindLabel = (kind: string | null | undefined) => EVENT_KIND_LABEL[kind ?? ""] ?? "기타";
export const listedInTournaments = (kind: string) => kind === TOURNAMENT_KIND;
export interface EventPlacement { kind: string; placement_rank: number | null }
export const isTitle = (row: EventPlacement) => listedInTournaments(row.kind) && row.placement_rank === 1;
export const isRunnerUp = (row: EventPlacement) => listedInTournaments(row.kind) && row.placement_rank === 2;

export type TeamStage = "finals" | "qualifiers" | "unknown";
export const TEAM_STAGE_LABEL: Record<TeamStage, string> = { finals: "본선", qualifiers: "예선", unknown: "미확인" };
/** 순위가 없는 팀을 다른 팀의 순위만 보고 예선에 넣지 않는다. 충돌하는 근거도 미확인이다. */
export function classifyTeamStage({ rank, placement, inFinals = false, rounds = [] }: {
  rank: number | null; placement: string | null; inFinals?: boolean; rounds?: readonly string[];
}): TeamStage {
  const qualifier = rank === 99 || /예선.*탈락/.test(placement ?? "");
  const labelRank = placementRank(placement);
  // 숫자가 없는 명시 성적도 근거로 삼되, '탈락'만으로 예선이라고 추정하지 않는다.
  // 두 값을 합쳐 하나를 택하지 않아 숫자와 문구가 충돌하는 경우도 발견할 수 있다.
  const finalist = inFinals || rounds.some(round => !/예선/.test(round) && /결승|본선|\d+강/.test(round))
    || [rank, labelRank].some(value => value != null && value > 0 && value < 99) || /본선/.test(placement ?? "");
  if (qualifier && finalist) return "unknown";
  return qualifier ? "qualifiers" : finalist ? "finals" : "unknown";
}
