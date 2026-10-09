import { db } from "./client.ts";
import { REVIEW_PROGRESS_JOIN } from "./review-progress.ts";
import { lolReviewScope, type LoLReviewCollection } from "./lol-review-scope.ts";

/** Read-time queues only: these checks never mark a match as human reviewed. */
export const LOL_PRIORITY_REASONS = `array_remove(ARRAY[
  CASE WHEN m.origin = 'vod_scan' THEN '화면 판독' END,
  CASE WHEN rp.participant_count <> 10 OR rp.position_count < 10 OR rp.linked_count < 10
    OR rp.champion_count < 10 OR rp.kda_count < 10 OR m.winning_team IS NULL THEN '필수 값 누락' END,
  CASE WHEN m.review_completed_at IS NULL AND EXISTS (SELECT 1 FROM review_change rc WHERE rc.match_id = m.match_id AND rc.field = 'review_completed' AND rc.after = 'true'::jsonb) THEN '검수 후 변경·해제' END
]::text[], NULL)`;

export async function lolReviewQueueIds(ids: string[], from?: string, collection?: LoLReviewCollection): Promise<string[]> {
  const queue = new URL(from ?? '/admin/ck?queue=all', 'https://admin.invalid').searchParams.get('queue');
  const filteredQueue = queue === 'priority' || queue === 'general';
  if (!filteredQueue && !collection) return ids;
  const sql = db();
  const rows = await sql`SELECT m.match_id FROM match m ${sql.unsafe(REVIEW_PROGRESS_JOIN)} WHERE m.game_code = 'lol'
    AND m.match_id = ANY(${ids}) AND ${lolReviewScope(collection)}
    AND (${!filteredQueue} OR (m.review_completed_at IS NULL
      AND CASE WHEN ${queue} = 'priority' THEN cardinality(${sql.unsafe(LOL_PRIORITY_REASONS)}) > 0 ELSE cardinality(${sql.unsafe(LOL_PRIORITY_REASONS)}) = 0 END))`;
  return rows.map(r => r.match_id);
}

export async function listFcoReviewPriorities(): Promise<Map<string, string[]>> {
  const rows = await db()<{ match_id: string; reasons: string[] }[]>`
    SELECT m.match_id, array_remove(ARRAY[
      CASE WHEN m.source = 'manual' THEN '화면 판독' END,
      CASE WHEN (SELECT count(*) FROM fco_match_participant p WHERE p.match_id = m.match_id) <> 2
        OR EXISTS (SELECT 1 FROM fco_match_participant p WHERE p.match_id = m.match_id
          AND (NULLIF(trim(p.nickname), '') IS NULL OR p.score_display IS NULL OR p.outcome IS NULL OR p.outcome = 'unknown')) THEN '필수 값 누락' END,
      CASE WHEN EXISTS (SELECT 1 FROM fco_screen_link l
        JOIN fco_match_participant a ON a.match_id = l.api_match_id
        JOIN fco_match_participant b ON b.match_id = l.screen_match_id
          AND b.side_no = CASE WHEN (
            SELECT count(*) FROM fco_match_participant x JOIN fco_match_participant y ON y.side_no = 3 - x.side_no
            WHERE x.match_id = l.api_match_id AND y.match_id = l.screen_match_id
              AND coalesce(x.streamer_id::text, 'name:' || lower(regexp_replace(x.nickname, '[[:space:]]+', '', 'g')))
                = coalesce(y.streamer_id::text, 'name:' || lower(regexp_replace(y.nickname, '[[:space:]]+', '', 'g')))
          ) > (
            SELECT count(*) FROM fco_match_participant x JOIN fco_match_participant y ON y.side_no = x.side_no
            WHERE x.match_id = l.api_match_id AND y.match_id = l.screen_match_id
              AND coalesce(x.streamer_id::text, 'name:' || lower(regexp_replace(x.nickname, '[[:space:]]+', '', 'g')))
                = coalesce(y.streamer_id::text, 'name:' || lower(regexp_replace(y.nickname, '[[:space:]]+', '', 'g')))
          ) THEN 3 - a.side_no ELSE a.side_no END
        WHERE l.api_match_id = m.match_id AND (
          lower(regexp_replace(a.nickname, '[[:space:]]+', '', 'g')) <> lower(regexp_replace(b.nickname, '[[:space:]]+', '', 'g'))
          OR coalesce(a.score_display, a.goals) <> coalesce(b.score_display, b.goals)
          OR (a.outcome IN ('win','loss','draw') AND b.outcome IN ('win','loss','draw') AND a.outcome <> b.outcome))) THEN '시점 불일치' END,
      CASE WHEN m.review_completed_at IS NULL AND EXISTS (SELECT 1 FROM review_change rc WHERE rc.match_id = m.match_id AND rc.field = 'review_completed' AND rc.after = 'true'::jsonb) THEN '검수 후 변경·해제' END
    ]::text[], NULL) AS reasons FROM match m
    WHERE m.game_code = 'fconline' AND m.review_completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM fco_screen_link l WHERE l.screen_match_id = m.match_id)`;
  return new Map(rows.map(r => [r.match_id, r.reasons]));
}

export async function fcoReviewQueueIds(ids: string[], from?: string): Promise<string[]> {
  const view = new URL(from ?? '/admin/fco', 'https://admin.invalid').searchParams.get('view');
  if (view !== 'priority' && view !== 'general') return ids;
  const priorities = await listFcoReviewPriorities();
  return ids.filter(id => priorities.has(id) && (view === 'priority' ? priorities.get(id)!.length > 0 : priorities.get(id)!.length === 0));
}
