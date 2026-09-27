/** 개인 기록. 조우 수가 아니라 공개 참가 기록을 경기별로 한 번씩 센다. */
import { db } from "./client.ts";
import { expandCategory, type MatchCategory, type MatchCategoryFilter } from "../metrics/category.ts";

export interface PersonalMatch {
  series_key: string;
  category: MatchCategory;
  event_name: string | null;
  played_at: Date;
  sets: number;
  set_wins: number;
  best_of: number | null;
  match_ids: string[];
  /** match_ids 와 같은 순서의 세트 번호. 순서를 모르는 시리즈에선 정렬용일 뿐이다. */
  set_nos: (number | null)[];
  /** 세트 순서를 출처에서 확인했나 — 세트 이름은 setLabel 이 정한다. */
  set_order_known: boolean;
}
export interface PersonalCategoryRecord {
  category: MatchCategory;
  matches: number;
  wins: number;
  draws: number;
  losses: number;
  sets: number;
  set_wins: number;
}
export interface PersonalScope {
  category?: MatchCategoryFilter;
  year?: number;
  /**
   * KST 달력 날짜(`YYYY-MM-DD`). **다전제의 첫 경기**를 기준으로 자른다 —
   * 자정을 넘긴 3세트를 중간에서 잘라 "2세트짜리 경기" 로 만들지 않기 위해서다.
   * 상대 전적의 `withinRecordPeriod` 와 같은 규칙이다(시리즈를 다 묶은 뒤 판정).
   */
  from?: string;
  to?: string;
}

/** 목록과 승률의 분모를 공유한다. 한 다전제를 LIMIT으로 중간에서 자르지 않는다. */
function groupedMatches(streamerId: string, {category, year, from, to}: PersonalScope) {
  const sql = db();
  return sql`
    SELECT series_key, category, min(event_name) AS event_name, min(game_creation) AS played_at,
           count(*)::int AS sets, count(*) FILTER (WHERE outcome = 'win')::int AS set_wins,
           min(best_of)::int AS best_of,
           array_agg(match_id ORDER BY game_creation, match_id) AS match_ids,
           array_agg(series_game_no ORDER BY game_creation, match_id) AS set_nos,
           bool_or(set_order_known) AS set_order_known
      FROM (
        SELECT DISTINCT m.match_id, coalesce(m.series_id, m.match_id) AS series_key,
               m.category, ev.name AS event_name, m.game_creation, mp.outcome, m.best_of,
               m.series_game_no, m.set_order_known
          FROM core_public.match_participant mp
          JOIN core_public.match m ON m.match_id = mp.match_id
          LEFT JOIN core_public.event ev ON ev.event_id = m.event_id
         WHERE mp.streamer_id = ${streamerId}::uuid
           AND (${year ?? null}::int IS NULL OR EXTRACT(YEAR FROM m.game_creation AT TIME ZONE 'Asia/Seoul') = ${year ?? null}::int)
           AND (${expandCategory(category)}::text[] IS NULL OR m.category = ANY(${expandCategory(category)}::text[]))
      ) mine
     GROUP BY series_key, category
    HAVING (${from ?? null}::date IS NULL
            OR (min(game_creation) AT TIME ZONE 'Asia/Seoul')::date >= ${from ?? null}::date)
       AND (${to ?? null}::date IS NULL
            OR (min(game_creation) AT TIME ZONE 'Asia/Seoul')::date <= ${to ?? null}::date)
  `;
}

export async function listPersonalRecords(streamerId: string, scope: PersonalScope = {}): Promise<PersonalCategoryRecord[]> {
  return db()<PersonalCategoryRecord[]>`
    SELECT category, count(*)::int AS matches,
           count(*) FILTER (WHERE set_wins * 2 > sets)::int AS wins,
           count(*) FILTER (WHERE set_wins * 2 = sets)::int AS draws,
           count(*) FILTER (WHERE set_wins * 2 < sets)::int AS losses,
           sum(sets)::int AS sets, sum(set_wins)::int AS set_wins
      FROM (${groupedMatches(streamerId, scope)}) games
     GROUP BY category ORDER BY category
  `;
}

export async function listPersonalMatches(streamerId: string, scope: PersonalScope & { limit?: number; offset?: number } = {}): Promise<PersonalMatch[]> {
  const limit = Math.min(101, Math.max(1, scope.limit ?? 21));
  const offset = Math.max(0, scope.offset ?? 0);
  return db()<PersonalMatch[]>`
    SELECT * FROM (${groupedMatches(streamerId, scope)}) games
     ORDER BY played_at DESC, series_key
     LIMIT ${limit} OFFSET ${offset}
  `;
}

export async function listPersonalYears(streamerId: string): Promise<number[]> {
  const rows = await db()<{ year: number }[]>`
    SELECT DISTINCT EXTRACT(YEAR FROM m.game_creation AT TIME ZONE 'Asia/Seoul')::int AS year
      FROM core_public.match_participant mp JOIN core_public.match m ON m.match_id = mp.match_id
     WHERE mp.streamer_id = ${streamerId}::uuid ORDER BY year DESC
  `;
  return rows.map((r) => r.year);
}
