/**
 * `/admin/overview` — 입력된 경기 수치를 **빠르게 훑는** 화면의 조회.
 *
 * 검수큐(`/admin/ck`)는 VOD·프레임을 보며 값을 넣는 곳이고, 여기는 넣은 결과를
 * 시리즈 단위로 펼쳐 라인·스트리머·챔피언·KDA 만 확인한다. 편집은 검수 완료 토글 하나뿐이다.
 *
 * ★ 목록과 상세를 나눈다. 대회만 500 시리즈·9천 참가 자리라 한 번에 그리면 무겁다 —
 *   목록은 세트 요약만, 참가자는 펼친 시리즈만 읽는다.
 * ★ 분류는 event.kind 하나다(검수큐와 같다). 대회가 안 붙은 경기는 'other' 로 모은다.
 * ★ 공개 큐(API) 경기는 뺀다 — 검수큐·CLI 로 입력한 경기만 대상이다.
 */

import { db } from "./client.ts";
import { REVIEW_PROGRESS_JOIN } from "./review-progress.ts";
import { LOL_PRIORITY_REASONS } from "./review-priority.ts";
import type { LeadEventKind } from "./ck.ts";

export interface OverviewSetSummary {
  match_id: string;
  series_game_no: number | null;
  winning_team: 100 | 200 | null;
  blue_team: string | null;
  red_team: string | null;
  completed: boolean;
  game_creation: Date; game_creation_precision: "datetime" | "date"; review_version: number; visibility: string;
  position_count: number; linked_count: number; champion_count: number; kda_count: number;
  priority_reasons: string[];
}

export interface OverviewSeriesRow {
  /** 시리즈가 없는 단판은 경기 ID 가 곧 키다. */
  key: string;
  kind: LeadEventKind;
  event_name: string | null;
  event_id: string | null;
  round_label: string | null;
  best_of: number | null;
  set_order_known: boolean;
  first_played: Date;
  game_creation_precision: "datetime" | "date";
  sets: OverviewSetSummary[];
}

const SERIES_EVENT_JOIN = `
  LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
  LEFT JOIN event e ON e.id = COALESCE(ms.event_id, m.event_id)`;

export interface OverviewOptions {
  kind?: LeadEventKind; unreviewed?: boolean; limit?: number; offset?: number; q?: string; event?: string; focus?: string; queue?: "priority" | "general";
}
function overviewWhere(opts: OverviewOptions) {
  const sql = db();
  return sql`m.game_code = 'lol' AND m.source <> 'public_queue'
    AND (${opts.kind ?? null}::text IS NULL OR COALESCE(e.kind, 'other') = ${opts.kind ?? null})
    AND (${opts.event ?? null}::text IS NULL OR e.slug = ${opts.event ?? null}
      OR (${opts.event ?? null} = 'unlinked' AND COALESCE(ms.event_id, m.event_id) IS NULL))`;
}
function overviewHaving(opts: OverviewOptions) {
  const sql = db(), q = opts.q?.trim();
  return sql`(${opts.unreviewed ?? false} = false OR bool_or(m.review_completed_at IS NULL))
    AND (${opts.queue ?? null}::text IS NULL OR bool_or(m.review_completed_at IS NULL
      AND CASE WHEN ${opts.queue ?? null} = 'priority' THEN cardinality(${sql.unsafe(LOL_PRIORITY_REASONS)}) > 0
        ELSE cardinality(${sql.unsafe(LOL_PRIORITY_REASONS)}) = 0 END))
    AND (${q || null}::text IS NULL OR bool_or(concat_ws(' ', e.name, ms.round_label, m.match_id, m.series_id) ILIKE ${'%' + (q ?? '') + '%'}
      OR EXISTS (SELECT 1 FROM match_participant mp LEFT JOIN streamer person ON person.id = mp.streamer_id
        WHERE mp.match_id = m.match_id AND concat_ws(' ', person.display_name, mp.observed_name) ILIKE ${'%' + (q ?? '') + '%'})))
    AND CASE ${opts.focus ?? ''} WHEN 'position' THEN bool_or(rp.position_count < 10)
      WHEN 'identity' THEN bool_or(rp.linked_count < 10) WHEN 'champion' THEN bool_or(rp.champion_count < 10)
      WHEN 'kda' THEN bool_or(rp.kda_count < 10) ELSE true END`;
}
export async function countOverviewSeries(opts: OverviewOptions = {}): Promise<number> {
  const sql = db();
  const [row] = await sql`SELECT count(*)::int AS n FROM (
    SELECT COALESCE(m.series_id, m.match_id) FROM match m ${sql.unsafe(SERIES_EVENT_JOIN)} ${sql.unsafe(REVIEW_PROGRESS_JOIN)}
    WHERE ${overviewWhere(opts)} GROUP BY COALESCE(m.series_id, m.match_id) HAVING ${overviewHaving(opts)}
  ) counted`;
  return row.n;
}

/** Bounded series summaries; all sets stay together even when a person/missing-field filter matches one set. */
export async function listOverviewSeries(opts: OverviewOptions = {}): Promise<OverviewSeriesRow[]> {
  const sql = db();
  return sql<OverviewSeriesRow[]>`
    SELECT key, kind, event_id, event_name, round_label, best_of, set_order_known, first_played, game_creation_precision, sets
      FROM (
    SELECT COALESCE(m.series_id, m.match_id) AS key,
           COALESCE(min(e.id::text), COALESCE(m.series_id, m.match_id)) AS group_key,
           min(e.id::text) AS event_id, min(e.starts_at) AS event_start,
           min((m.game_creation AT TIME ZONE 'Asia/Seoul')::date) AS played_day,
           min(m.game_creation) FILTER (WHERE m.game_creation_precision = 'datetime') AS played_at,
           COALESCE(min(e.kind), 'other') AS kind, min(e.name) AS event_name,
           min(ms.round_label) AS round_label, min(ms.best_of) AS best_of,
           COALESCE(bool_or(ms.set_order_known), false) AS set_order_known,
           min(m.game_creation) AS first_played,
           CASE WHEN bool_and(m.game_creation_precision = 'datetime') THEN 'datetime' ELSE 'date' END AS game_creation_precision,
           json_agg(json_build_object(
             'match_id', m.match_id, 'series_game_no', m.series_game_no, 'winning_team', m.winning_team,
             'blue_team', bt.name, 'red_team', rt.name, 'completed', m.review_completed_at IS NOT NULL,
             'game_creation', m.game_creation, 'game_creation_precision', m.game_creation_precision,
             'review_version', m.review_version, 'visibility', m.visibility,
             'priority_reasons', ${sql.unsafe(LOL_PRIORITY_REASONS)},
             'position_count', rp.position_count, 'linked_count', rp.linked_count,
             'champion_count', rp.champion_count, 'kda_count', rp.kda_count
           ) ORDER BY m.series_game_no NULLS LAST, m.game_creation, m.match_id) AS sets
      FROM match m ${sql.unsafe(SERIES_EVENT_JOIN)} ${sql.unsafe(REVIEW_PROGRESS_JOIN)}
      LEFT JOIN event_team bt ON bt.id = m.blue_team_id
      LEFT JOIN event_team rt ON rt.id = m.red_team_id
     WHERE ${overviewWhere(opts)}
     GROUP BY COALESCE(m.series_id, m.match_id) HAVING ${overviewHaving(opts)}
      ) s
     ORDER BY COALESCE(event_start, max(first_played) OVER (PARTITION BY group_key)) DESC NULLS LAST, group_key,
              played_day, played_at NULLS LAST, key
     LIMIT ${opts.limit ?? 1000} OFFSET ${opts.offset ?? 0}
  `;
}

export interface OverviewParticipant {
  participant_id: number;
  team_id: 100 | 200;
  team_position: string | null;
  /** 연결된 스트리머. 계정 매핑(puuid)이 직접 연결보다 먼저다 — 집계와 같은 순서. */
  streamer_name: string | null;
  streamer_slug: string | null;
  observed_name: string | null;
  champion_id: number;
  champion_name: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
}

export interface OverviewSetDetail {
  match_id: string;
  series_game_no: number | null;
  game_creation: Date;
  game_creation_precision: "datetime" | "date";
  game_duration: number | null;
  winning_team: 100 | 200 | null;
  blue_team: string | null;
  red_team: string | null;
  visibility: string;
  review_completed_at: Date | null;
  review_version: number;
  participants: OverviewParticipant[];
}

/** 시리즈 하나의 세트 전부와 참가자. */
export async function getOverviewSeriesSets(key: string): Promise<OverviewSetDetail[]> {
  const sql = db();
  return sql<OverviewSetDetail[]>`
    SELECT m.match_id, m.series_game_no, m.game_creation, m.game_creation_precision, m.game_duration,
           m.winning_team, bt.name AS blue_team, rt.name AS red_team, m.visibility,
           m.review_completed_at, m.review_version,
           COALESCE((
             SELECT json_agg(json_build_object(
                      'participant_id', mp.participant_id, 'team_id', mp.team_id, 'team_position', mp.team_position,
                      'streamer_name', s.display_name, 'streamer_slug', s.slug, 'observed_name', mp.observed_name,
                      'champion_id', mp.champion_id, 'champion_name', mp.champion_name,
                      'kills', mp.kills, 'deaths', mp.deaths, 'assists', mp.assists
                    ) ORDER BY mp.participant_id)
               FROM match_participant mp
               LEFT JOIN LATERAL (
                 SELECT sa.streamer_id FROM streamer_account sa
                  WHERE sa.puuid = mp.puuid AND sa.active_to IS NULL LIMIT 1
               ) acc ON true
               LEFT JOIN streamer s ON s.id = COALESCE(acc.streamer_id, mp.streamer_id)
              WHERE mp.match_id = m.match_id
           ), '[]'::json) AS participants
      FROM match m
      LEFT JOIN event_team bt ON bt.id = m.blue_team_id
      LEFT JOIN event_team rt ON rt.id = m.red_team_id
     WHERE m.game_code = 'lol' AND m.source <> 'public_queue'
       AND COALESCE(m.series_id, m.match_id) = ${key}
     ORDER BY m.series_game_no NULLS LAST, m.game_creation
  `;
}
