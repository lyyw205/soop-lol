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
  /** match_ids 와 같은 순서. "bonus" 판은 펼쳤을 때만 보이고 sets·set_wins 에 들어가지 않는다(0079). */
  set_roles: string[];
  /** 방송에서 부른 보너스 판 이름. 없으면 빈 문자열. */
  set_labels: string[];
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

/**
 * 목록과 승률의 분모를 공유한다. 한 다전제를 LIMIT으로 중간에서 자르지 않는다.
 *
 * ★ 보너스 판(범인찾기 등)은 묶음에 **보이기만** 한다 — sets·set_wins 는 본게임만 센다(0079).
 *   그래서 경기 뷰는 보너스까지 내는 match_with_bonus 를 쓰고, 세는 곳에서 set_role 로 거른다.
 * ★ 랜드는 묶음 하나가 한 줄이지만 sets·set_wins 가 곧 그 사람의 판 단위 n승 m패다.
 */
function groupedMatches(streamerId: string, {category, year, from, to}: PersonalScope) {
  const sql = db();
  return sql`
    SELECT series_key, category, min(event_name) AS event_name, min(game_creation) AS played_at,
           count(*) FILTER (WHERE set_role = 'main')::int AS sets,
           count(*) FILTER (WHERE set_role = 'main' AND outcome = 'win')::int AS set_wins,
           min(best_of)::int AS best_of,
           array_agg(match_id ORDER BY game_creation, match_id) AS match_ids,
           array_agg(series_game_no ORDER BY game_creation, match_id) AS set_nos,
           array_agg(set_role ORDER BY game_creation, match_id) AS set_roles,
           -- ⚠ text 배열 속 NULL 이 드라이버에서 문자열 "NULL" 로 온다(실측). 빈 문자열로 바꿔 보낸다.
           array_agg(coalesce(set_label, '') ORDER BY game_creation, match_id) AS set_labels,
           bool_or(set_order_known) AS set_order_known
      FROM (
        SELECT DISTINCT m.match_id, coalesce(m.series_id, m.match_id) AS series_key,
               m.category, ev.name AS event_name, m.game_creation, mp.outcome, m.best_of,
               m.series_game_no, m.set_order_known, m.set_role, m.set_label
          -- 사람으로 찾을 땐 streamer_match 에서 출발한다 — 참가자 뷰의 streamer_id 는 계산값이라
          -- 직접 거르면 1GB 표를 통째로 훑어 탭 하나에 20초가 들었다(0075).
          FROM core_public.streamer_match sm
          JOIN core_public.match_participant mp ON mp.match_id = sm.match_id AND mp.participant_id = sm.participant_id
          JOIN core_public.match_with_bonus m ON m.match_id = mp.match_id
          LEFT JOIN core_public.event ev ON ev.event_id = m.event_id
         WHERE sm.streamer_id = ${streamerId}::uuid
           AND (${year ?? null}::int IS NULL OR EXTRACT(YEAR FROM m.game_creation AT TIME ZONE 'Asia/Seoul') = ${year ?? null}::int)
           AND (${expandCategory(category)}::text[] IS NULL OR m.category = ANY(${expandCategory(category)}::text[]))
      ) mine
     GROUP BY series_key, category
    -- 보너스만 남은 묶음(본게임이 다른 분류로 빠진 경우)은 줄로 세우지 않는다.
    HAVING count(*) FILTER (WHERE set_role = 'main') > 0
       AND (${from ?? null}::date IS NULL
            OR (min(game_creation) AT TIME ZONE 'Asia/Seoul')::date >= ${from ?? null}::date)
       AND (${to ?? null}::date IS NULL
            OR (min(game_creation) AT TIME ZONE 'Asia/Seoul')::date <= ${to ?? null}::date)
  `;
}

export async function listPersonalRecords(streamerId: string, scope: PersonalScope = {}): Promise<PersonalCategoryRecord[]> {
  return db()<PersonalCategoryRecord[]>`
    -- ★ 랜드는 묶음 승패가 없다(팀이 매 판 바뀐다) — 경기 수·승패를 판 단위로 센다(0079).
    SELECT category,
           sum(CASE WHEN category = 'land' THEN sets ELSE 1 END)::int AS matches,
           sum(CASE WHEN category = 'land' THEN set_wins ELSE (set_wins * 2 > sets)::int END)::int AS wins,
           sum(CASE WHEN category = 'land' THEN 0 ELSE (set_wins * 2 = sets)::int END)::int AS draws,
           sum(CASE WHEN category = 'land' THEN sets - set_wins ELSE (set_wins * 2 < sets)::int END)::int AS losses,
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
      FROM core_public.streamer_match sm JOIN core_public.match m ON m.match_id = sm.match_id
     WHERE sm.streamer_id = ${streamerId}::uuid ORDER BY year DESC
  `;
  return rows.map((r) => r.year);
}
