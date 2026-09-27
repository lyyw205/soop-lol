/** 목록·경기·로스터에서 같은 순서와 같은 빈칸 기준을 쓴다. */
export const ROSTER_PROGRESS_FIELDS = [
  { focus: "position", label: "포지션 입력", count: "position_count", cell: "team_position" },
  { focus: "identity", label: "참가자 연결", count: "linked_count", cell: "identity" },
  { focus: "champion", label: "챔피언 입력", count: "champion_count", cell: "champion_name" },
  { focus: "kda", label: "KDA 입력", count: "kda_count", cell: "kda" },
] as const;

export type RosterFocus = typeof ROSTER_PROGRESS_FIELDS[number]["focus"];
export const rosterFocus = (value: string | undefined) => ROSTER_PROGRESS_FIELDS.find(field => field.focus === value);
