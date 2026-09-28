/**
 * 검수 화면의 **대회·이벤트 보기** — event → 시리즈(라운드) → 세트.
 *
 * ★ 이 화면은 "모르는 걸 아는 척" 하지 않는다 (0035).
 *   · 시드 생성기는 세트별 승자가 없으면 승리 세트를 앞에 몰아 넣는다. 그 순서는 우리가
 *     만든 것이라 `set_order_known = false` 인 시리즈는 "1세트·2세트" 로 단정하지 않는다.
 *   · 시각을 모르는 경기(`game_creation_precision = 'date'`)는 날짜만 보여준다.
 *   · 그래서 정렬은 "날짜 → 시리즈 ID(시드의 경기 번호) → 세트 번호" 다. 이건 **표시 순서를
 *     일정하게** 만드는 규칙이지 실제 순서의 복원이 아니다.
 *
 * 분류는 event.kind 하나다 — 단서(VOD)의 분류가 아니다.
 */

import { REVIEW_PROGRESS_JOIN, type ReviewProgress } from "./review-progress.ts";
import { db } from "./client.ts";
import type { LeadEventKind } from "./ck.ts";

export interface ReviewEventRow extends ReviewProgress {
  completed_count: number;
  id: string;
  slug: string | null;
  name: string;
  kind: LeadEventKind;
  starts_at: Date | null;
  ends_at: Date | null;
  series_count: number;
  match_count: number;
  /** 이 대회 경기가 나온 VOD(단서) 수. 0 이면 방송으로 확인한 경기가 아직 없다. */
  lead_count: number;
  first_played: Date | null;
  last_played: Date | null;
}

/**
 * 분류 하나의 대회 목록. **대회 시작일** 기준 최신순이다.
 * ★ 경기 날짜로 정렬하지 않는다. 경기 날짜는 틀릴 수 있다 — 2024 멸망전 시즌1 에 2026-07-14 로
 *   들어간 시드 경기 3개 때문에 그 대회가 2026 대회들보다 위로 올라갔다. 대회의 날짜는 대회 행에 있다.
 *   시작일이 없는 대회만 첫 경기 날짜로 대신한다.
 */
/** `kind` 가 null 이면 모든 분류의 대회를 한 목록으로 낸다(검수 목록의 "전체 분류"). */
export async function listReviewEvents(kind: LeadEventKind | null, unreviewed = false): Promise<ReviewEventRow[]> {
  const sql = db();
  return sql<ReviewEventRow[]>`
    WITH em AS (
      -- 경기의 대회는 시리즈가 있으면 시리즈 쪽이 정본이다(0027).
      SELECT COALESCE(ms.event_id, m.event_id) AS event_id, m.match_id, m.series_id,
             m.review_completed_at, m.game_creation, rp.participant_count, rp.position_count, rp.linked_count, rp.champion_count, rp.kda_count
        FROM match m
        ${sql.unsafe(REVIEW_PROGRESS_JOIN)}
        LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
       WHERE m.game_code = 'lol' AND COALESCE(ms.event_id, m.event_id) IS NOT NULL
    )
    SELECT e.id, e.slug, e.name, e.kind, e.starts_at, e.ends_at,
           count(DISTINCT COALESCE(em.series_id, em.match_id))::int      AS series_count,
           count(em.match_id)::int                                       AS match_count,
           count(em.match_id) FILTER (WHERE em.review_completed_at IS NOT NULL)::int AS completed_count,
           COALESCE(sum(em.participant_count), 0)::int AS participant_count,
           COALESCE(sum(em.position_count), 0)::int AS position_count,
           COALESCE(sum(em.linked_count), 0)::int AS linked_count,
           COALESCE(sum(em.champion_count), 0)::int AS champion_count,
           COALESCE(sum(em.kda_count), 0)::int AS kda_count,
           (SELECT count(DISTINCT lm.lead_id) FROM lead_match lm
              JOIN em em2 ON em2.match_id = lm.match_id AND em2.event_id = e.id)::int AS lead_count,
           min(em.game_creation) AS first_played,
           max(em.game_creation) AS last_played
      FROM event e
      LEFT JOIN em ON em.event_id = e.id
     WHERE (${kind}::text IS NULL OR e.kind = ${kind}) AND e.game_code = 'lol'
     GROUP BY e.id
    HAVING (${unreviewed} = false OR count(em.match_id) FILTER (WHERE em.review_completed_at IS NULL) > 0)
     ORDER BY COALESCE(e.starts_at, min(em.game_creation)) DESC NULLS LAST, e.name
  `;
}

export interface ReviewSetRow extends ReviewProgress {
  review_completed_at: Date | null;
  review_version: number;
  match_id: string;
  series_game_no: number | null;
  game_creation: Date;
  game_creation_precision: "datetime" | "date";
  winning_team: 100 | 200 | null;
  blue_team: string | null;
  red_team: string | null;
  visibility: string;
  reviewed_at: Date | null;
  /** 누가 만든 행인가. API 가 준 경기는 null 이다 — 그래서 source 와 같이 봐야 출처를 말할 수 있다. */
  origin: string | null;
  source: string;
  /** 이 경기가 나온 VOD. 누르면 그 VOD 의 검수 화면으로 간다. */
  leads: { id: string; title: string }[];
}

export interface ReviewSeriesRow {
  /** 시리즈가 없는 단판(VOD 판독이 대회에 바로 붙인 경기)은 경기 ID 가 곧 키다. */
  key: string;
  round_label: string | null;
  best_of: number | null;
  set_order_known: boolean;
  sets: ReviewSetRow[];
}

export interface ReviewEventDetail {
  event: Omit<ReviewEventRow, "series_count" | "match_count" | "completed_count" | keyof ReviewProgress | "lead_count" | "first_played" | "last_played">
    & { organizer: string | null; source_url: string | null };
  series: ReviewSeriesRow[];
}

export async function getReviewEvent(slug: string): Promise<ReviewEventDetail | null> {
  const sql = db();
  const [event] = await sql<ReviewEventDetail["event"][]>`
    SELECT id, slug, name, kind, starts_at, ends_at, organizer, source_url
      FROM event WHERE slug = ${slug} AND game_code = 'lol'
  `;
  if (!event) return null;

  const rows = await sql<(ReviewSetRow & {
    series_key: string; round_label: string | null; best_of: number | null; set_order_known: boolean | null;
  })[]>`
    SELECT m.match_id, m.series_game_no, m.game_creation, m.game_creation_precision, m.winning_team,
           bt.name AS blue_team, rt.name AS red_team, m.visibility, m.reviewed_at, m.review_completed_at, m.review_version, m.origin, m.source,
           rp.participant_count, rp.position_count, rp.linked_count, rp.champion_count, rp.kda_count,
           COALESCE(m.series_id, m.match_id) AS series_key,
           ms.round_label, ms.best_of, ms.set_order_known,
           COALESCE((
             SELECT json_agg(json_build_object('id', el.id, 'title', el.title) ORDER BY el.observed_at)
               FROM lead_match lm JOIN event_lead el ON el.id = lm.lead_id
              WHERE lm.match_id = m.match_id
           ), '[]'::json) AS leads
      FROM match m
      ${sql.unsafe(REVIEW_PROGRESS_JOIN)}
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      LEFT JOIN event_team bt ON bt.id = m.blue_team_id
      LEFT JOIN event_team rt ON rt.id = m.red_team_id
     WHERE COALESCE(ms.event_id, m.event_id) = ${event.id}::uuid
     -- 날짜 → 시리즈 ID → 세트 번호. 날짜만 아는 경기의 시각(19시·20시)은 생성기가 지어낸
     -- 값이라 정렬 키로 쓰지 않는다. 시리즈 ID 는 시드의 경기 번호(g03)라 대진 순서를 따른다.
     ORDER BY (m.game_creation AT TIME ZONE 'Asia/Seoul')::date,
              CASE WHEN m.game_creation_precision = 'datetime' THEN m.game_creation END NULLS LAST,
              COALESCE(m.series_id, m.match_id),
              m.series_game_no NULLS FIRST
  `;

  // 행 순서를 지키며 시리즈로 묶는다. 한 시리즈의 첫 세트 위치가 시리즈의 위치다.
  const series: ReviewSeriesRow[] = [];
  const byKey = new Map<string, ReviewSeriesRow>();
  for (const { series_key, round_label, best_of, set_order_known, ...set } of rows) {
    let s = byKey.get(series_key);
    if (!s) {
      s = { key: series_key, round_label, best_of, set_order_known: set_order_known ?? false, sets: [] };
      byKey.set(series_key, s);
      series.push(s);
    }
    s.sets.push(set);
  }
  return { event, series };
}
