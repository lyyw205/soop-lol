import type { PublicRosterEntry } from "@soop-lol/core/lib/contract";

export interface MatchDetailSet {
  matchId: string;
  label: string;
  players: PublicRosterEntry[];
  /** 확인 전(회원 제보가 바꾸고 운영자가 아직 안 본 판, 0093) — 표시만 한다. 점수에서 빼는 일은 core(tally·counted)가 이미 했다. */
  pending?: boolean;
}

const POSITIONS = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
export function teamPlayers(players: readonly PublicRosterEntry[], teamId: number): PublicRosterEntry[] {
  const rank = (position: string | null) => {
    const index = POSITIONS.indexOf(position ?? "");
    return index < 0 ? POSITIONS.length : index;
  };
  // ⚠ display_name 은 **없을 수 있다**(미확인 자리, 0022). 그때는 읽은 인게임명으로 정렬한다.
  const label = (p: PublicRosterEntry) => p.display_name ?? p.observed_name ?? "";
  return players.filter((p)=>p.team_id===teamId).sort((a,b)=>
    rank(a.team_position)-rank(b.team_position) || label(a).localeCompare(label(b),"ko"));
}

export function participantKda(player: Pick<PublicRosterEntry,"kills"|"deaths"|"assists">): string {
  return [player.kills,player.deaths,player.assists].map((n)=>n ?? "—").join(" / ");
}

/** 교정 가능한 이름·챔피언 대신 DB의 자리 PK를 그대로 사용한다. */
export function participantKey(player: Pick<PublicRosterEntry, "match_id" | "participant_id">): string {
  return JSON.stringify([player.match_id, player.participant_id]);
}
