/**
 * 맞라인 판정과 라인전 지표.
 *
 * 원칙 (docs/PLAN.md §11-10): 포지션 추론값을 맹신하지 않는다.
 * 틀린 맞라인 전적은 없느니만 못하다 — 애매하면 **판정하지 않는다**.
 */

import { POSITIONS, type ParticipantDto, type Position } from "../riot/types.ts";

const POSITION_SET = new Set<string>(POSITIONS);

/**
 * 참가자의 포지션을 확정한다. 확정할 수 없으면 null.
 *
 * Riot 은 `teamPosition` 과 `individualPosition` 두 개를 준다. 둘 다 추론값이고,
 * 스왑 라인·특이 조합에서 어긋난다. **어긋나면 포기한다.**
 * (`teamPosition` 만 믿으면 탑↔미드 스왑에서 존재하지 않는 맞라인이 만들어진다)
 */
export function resolvePosition(p: Pick<ParticipantDto, "teamPosition" | "individualPosition">): Position | null {
  const team = (p.teamPosition ?? "").toUpperCase();
  const individual = (p.individualPosition ?? "").toUpperCase();
  if (!POSITION_SET.has(team)) return null;
  // individualPosition 이 비어 있는 경기(구버전 데이터)는 teamPosition 만으로 인정한다.
  if (individual && individual !== team) return null;
  return team as Position;
}

/** 반대 팀 + 같은 포지션 + 양쪽 다 포지션이 확정될 때만 true. */
export function isLaneMatchup(
  a: Pick<ParticipantDto, "teamId" | "teamPosition" | "individualPosition">,
  b: Pick<ParticipantDto, "teamId" | "teamPosition" | "individualPosition">,
): boolean {
  if (a.teamId === b.teamId) return false;
  const pa = resolvePosition(a);
  const pb = resolvePosition(b);
  return pa !== null && pa === pb;
}

/** 총 CS. Riot 은 미니언과 정글몹을 따로 준다. */
export function totalCs(p: ParticipantDto): number {
  return (p.totalMinionsKilled ?? 0) + (p.neutralMinionsKilled ?? 0);
}

/**
 * `challenges` 에서 라인전 지표를 방어적으로 꺼낸다.
 * Riot 이 키를 자주 바꾸므로 없으면 그냥 undefined 다 — 화면에서 '-' 로 표시한다.
 */
export interface LaneStats {
  soloKills?: number;
  csAt10?: number;
  maxLevelLeadOverOpponent?: number;
  killParticipation?: number;
  teamDamagePercentage?: number;
}

export function laneStats(p: ParticipantDto): LaneStats {
  const c = p.challenges ?? {};
  return {
    soloKills: num(c.soloKills),
    csAt10: num(c.laneMinionsFirst10Minutes),
    maxLevelLeadOverOpponent: num(c.maxLevelLeadLaneOpponent),
    killParticipation: num(c.killParticipation),
    teamDamagePercentage: num(c.teamDamagePercentage),
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function kda(kills: number, deaths: number, assists: number): number {
  return deaths === 0 ? kills + assists : (kills + assists) / deaths;
}

export function formatKda(kills: number, deaths: number, assists: number): string {
  return `${kills}/${deaths}/${assists}`;
}
