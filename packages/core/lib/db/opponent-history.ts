import { db } from "./client.ts";
import { expandCategory, type MatchCategoryFilter } from "../metrics/category.ts";
import type { OpponentHistory, OpponentHistoryMatch } from "../metrics/opponent-history.ts";

export interface OpponentScope { category?: MatchCategoryFilter; from?: string; to?: string; laneOnly?: boolean }
/** 같은 묶음 집합을 요약과 펼친 목록에서 공유한다. 필터는 묶은 다음, 제한은 마지막이다. */
function opponentGroups(id: string, scope: OpponentScope, otherId?: string) {
  const sql = db();
  return sql`
    SELECT other_id, series_key AS series, min(played_at) AS played_at, min(event_name) AS event_name,
      count(*)::int AS sets, count(*) FILTER (WHERE me_win)::int AS wins,
      min(best_of)::int AS best_of, bool_and(is_lane_matchup) AS "allLane",
      bool_and(series_key = match_id) AS standalone, bool_or(category = 'land') AS land
    FROM (
      SELECT DISTINCT e.match_id, e.series_key, e.game_creation AS played_at, e.category, e.best_of,
        e.is_lane_matchup, ev.name AS event_name,
        CASE WHEN e.streamer_a_id = ${id}::uuid THEN e.streamer_b_id ELSE e.streamer_a_id END AS other_id,
        CASE WHEN e.streamer_a_id = ${id}::uuid THEN e.a_outcome ELSE e.b_outcome END = 'win' AS me_win
      FROM core_public.streamer_encounter e JOIN core_public.match m ON m.match_id = e.match_id
      LEFT JOIN core_public.event ev ON ev.event_id = m.event_id
      WHERE (e.streamer_a_id = ${id}::uuid OR e.streamer_b_id = ${id}::uuid) AND e.relation = 'opponent'
        AND (${otherId ?? null}::uuid IS NULL OR e.streamer_a_id = ${otherId ?? null}::uuid OR e.streamer_b_id = ${otherId ?? null}::uuid)
        AND (${expandCategory(scope.category)}::text[] IS NULL OR e.category = ANY(${expandCategory(scope.category)}::text[]))
    ) e GROUP BY other_id, series_key
    HAVING (${scope.from ?? null}::date IS NULL OR (min(played_at) AT TIME ZONE 'Asia/Seoul')::date >= ${scope.from ?? null}::date)
       AND (${scope.to ?? null}::date IS NULL OR (min(played_at) AT TIME ZONE 'Asia/Seoul')::date <= ${scope.to ?? null}::date)
       AND (NOT ${scope.laneOnly ?? false} OR bool_and(is_lane_matchup))`;
}
export async function listOpponentSummaries(id: string, scope: OpponentScope = {}): Promise<OpponentHistory[]> {
  const rows = await db()<Omit<OpponentHistory, "matches">[]>`
    SELECT other_id, max(played_at) AS last_met, 0 AS ally_matches,
      sum(CASE WHEN land THEN sets ELSE 1 END)::int AS vs_matches,
      sum(CASE WHEN land THEN wins ELSE (wins * 2 > sets)::int END)::int AS vs_match_wins,
      sum(CASE WHEN land THEN 0 ELSE (wins * 2 = sets)::int END)::int AS vs_match_draws,
      sum(sets)::int AS vs_sets, sum(wins)::int AS vs_set_wins
    FROM (${opponentGroups(id, scope)}) groups GROUP BY other_id`;
  return rows.map(row => ({...row, matches: []}));
}
export async function listOpponentHistoryMatches(id: string, otherId: string, scope: OpponentScope = {}) {
  const rows = await db()<OpponentHistoryMatch[]>`
    SELECT * FROM (${opponentGroups(id, scope, otherId)}) groups ORDER BY played_at DESC, series LIMIT 201`;
  return { matches: rows.slice(0,200), truncated: rows.length > 200 };
}
