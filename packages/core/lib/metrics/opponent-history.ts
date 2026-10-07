import type { OpponentGame } from "../db/public.ts";
import { withinRecordPeriod, type RecordPeriod } from "./record-period.ts";
import { isStandaloneSet } from "./set-label.ts";
import { isLandCategory, tallyGroups } from "./match-tally.ts";

export interface OpponentHistoryMatch {
  series: string; played_at: Date; event_name: string | null; sets: number; wins: number;
  best_of: number | null; allLane: boolean;
  /** 시리즈에 속하지 않은 단독 경기인가. 한 세트만 모은 시리즈와 원래 단판을 가른다. */
  standalone: boolean;
  /** 랜드 묶음 — 한 줄이지만 판마다 매치 하나로 센다(match-tally). */
  land: boolean;
}
export interface OpponentHistory {
  other_id: string; matches: OpponentHistoryMatch[];
  vs_matches: number; vs_match_wins: number; vs_match_draws: number;
  vs_sets: number; vs_set_wins: number; ally_matches: number; last_met: Date;
}

function summarizeOpponent(other_id: string, matches: OpponentHistoryMatch[]): OpponentHistory {
  const t = tallyGroups(matches);
  return {other_id,matches,last_met:matches[0].played_at,
    vs_matches:t.matches,vs_match_wins:t.wins,vs_match_draws:t.draws,
    vs_sets:matches.reduce((n,m)=>n+m.sets,0),vs_set_wins:matches.reduce((n,m)=>n+m.wins,0),ally_matches:0};
}

export function buildOpponentHistory(rows: readonly OpponentGame[], period: RecordPeriod, laneOnly: boolean): OpponentHistory[] {
  const people = new Map<string, Map<string, Map<string, OpponentGame>>>();
  for (const row of rows) {
    if (row.relation !== "opponent") continue;
    const series = people.get(row.other_id) ?? new Map<string, Map<string, OpponentGame>>();
    const sets = series.get(row.series_key) ?? new Map<string, OpponentGame>();
    sets.set(row.match_id, row);
    series.set(row.series_key, sets);
    people.set(row.other_id, series);
  }
  const result: OpponentHistory[] = [];
  for (const [other_id, series] of people) {
    const matches: OpponentHistoryMatch[] = [];
    for (const [key, unique] of series) {
      const sets = [...unique.values()].sort((a,b)=>+new Date(a.played_at)-+new Date(b.played_at));
      const played_at = new Date(sets[0].played_at);
      const allLane = sets.every((s)=>s.is_lane_matchup);
      if (!withinRecordPeriod(played_at, period) || (laneOnly && !allLane)) continue;
      matches.push({series:key,played_at,event_name:sets[0].event_name,sets:sets.length,
        wins:sets.filter((s)=>s.me_outcome==="win").length,best_of:sets[0].best_of,allLane,
        standalone:sets.length===1 && isStandaloneSet(sets[0].match_id, key),
        land:isLandCategory(sets[0].category)});
    }
    if (!matches.length) continue;
    matches.sort((a,b)=>+b.played_at-+a.played_at || a.series.localeCompare(b.series));
    result.push(summarizeOpponent(other_id, matches));
  }
  return result;
}
