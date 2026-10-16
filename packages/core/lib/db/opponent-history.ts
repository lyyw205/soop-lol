/**
 * 상대 전적 질의 — `core_public.versus_pair_set`(같은 판의 두 공개 스트리머)만 읽는다.
 *
 * ★ 고르기는 개인 기록과 같은 조건(versusScopeSql — 맵 탭·진행 방식·기간)이고, 세기는 metrics/opponent-history 의
 *   pairResult(결과 짝) + tally 다. 프로필 상대 전적 탭·사이드바 "자주 만난 매치업"·상대전적 상세가 이 파일을 거친다.
 *   예전엔 SQL 다수결 사본(랜드 분기 포함)이 여기 있었고 상세 화면은 따로 세서 숫자가 달랐다.
 */
import { db } from "./client.ts";
import { versusScopeSql } from "./public.ts";
import type { Format } from "../metrics/format.ts";
import type { Counts, Outcome } from "../metrics/tally.ts";
import type { VersusScope } from "../metrics/record-scope.ts";
import { foldSeries } from "../metrics/record-series.ts";
import { isStandaloneSet } from "../metrics/set-label.ts";
import {
  pairResult, selectPairs, summarizeOpponents, type OpponentSummary, type PairRelation, type PairSetRow,
} from "../metrics/opponent-history.ts";

/** versus_pair_set 한 행 + 화면에 필요한 행사·형식 칸. a = 기준 스트리머. */
export interface PairSet extends PairSetRow {
  a_champion_id: number | null;
  b_champion_id: number | null;
  event_id: string;
  event_name: string;
  format: Format;
  map: string;
  series_started_on: string;
  played_at: Date;
  /** 확인 전(회원 제보, 0093) — `listed` 로 읽었을 때만 true 일 수 있다. tally 가 세지 않는다. */
  pending: boolean;
}

/**
 * 기준 스트리머(a)가 다른 공개 스트리머와 같은 판에 있던 세트 — 같은 팀·상대편 모두. `otherId` 를 주면 그 사람과만.
 * 고르기(맵·진행 방식·기간)는 개인 기록과 같다.
 */
// ★ 상대를 지정해도 "이 사람이 낀 판의 짝"을 먼저 고르고 그 안에서 상대를 거른다(MATERIALIZED — 순서 고정).
//   상대 조건을 뷰 안으로 밀어 넣게 두면 PostgreSQL 이 상대 쪽부터 풀려고 참가자 전체의 신원 규칙을 판마다 다시 계산한다 —
//   칼바람처럼 판이 적은 맵에서 그 계획이 골라져 두 사람 상세가 3.5초 걸렸다(운영 복사본 실측, scripts/skeleton-rehearsal.ts).
// `listed` — 목록용(확인 전 포함, lol_pair_row). 기본은 집계용(versus_pair_set — 확인 전 없음).
export async function listPairSets(streamerId: string, scope: VersusScope = {}, otherId?: string, { listed = false }: { listed?: boolean } = {}): Promise<PairSet[]> {
  const sql = db();
  const mine = sql`
    SELECT p.b_streamer_id AS other_id, p.match_id, p.series_id, p.series_game_no, p.played_at,
           p.series_started_on::text AS series_started_on, p.relation, p.a_outcome, p.b_outcome,
           p.a_position, p.b_position, p.a_champion_id, p.b_champion_id,
           p.event_id, e.name AS event_name, p.format, p.map, ${listed ? sql`p.pending` : sql`false`} AS pending
      FROM ${listed ? sql`core_public.lol_pair_row` : sql`core_public.versus_pair_set`} p
      JOIN core_public.event e ON e.event_id = p.event_id
     WHERE p.game_code = 'lol' AND p.a_streamer_id = ${streamerId}::uuid
       AND ${versusScopeSql(sql, "p", scope)}`;
  if (!otherId) return sql<PairSet[]>`${mine} ORDER BY p.played_at DESC, p.match_id`;
  return sql<PairSet[]>`
    WITH mine AS MATERIALIZED (${mine})
    SELECT * FROM mine WHERE other_id = ${otherId}::uuid ORDER BY played_at DESC, match_id`;
}

export interface OpponentScope extends VersusScope { laneOnly?: boolean }

/** 상대별 전적(세트·시리즈). 정렬은 metrics/opponents 의 sortOpponents 가 한다. */
export async function listOpponentSummaries(streamerId: string, scope: OpponentScope = {}): Promise<OpponentSummary[]> {
  return summarizeOpponents(selectPairs(await listPairSets(streamerId, scope), scope.laneOnly ? "lane" : "opponent"));
}

/** 시리즈의 형식 칸(best_of·세트 순서 확인) — 같은 고르기 뷰에서 시리즈 단위로 읽는다. */
export async function listSeriesMeta(seriesIds: readonly string[]): Promise<Map<string, { best_of: number | null; set_order_known: boolean }>> {
  if (!seriesIds.length) return new Map();
  const rows = await db()<{ series_id: string; best_of: number | null; set_order_known: boolean }[]>`
    SELECT DISTINCT series_id, best_of, set_order_known FROM core_public.lol_versus_set WHERE series_id = ANY(${[...seriesIds]})`;
  return new Map(rows.map((r) => [r.series_id, { best_of: r.best_of, set_order_known: r.set_order_known }]));
}

/** 상대 전적 펼친 목록의 한 줄 = 한 시리즈(둘이 상대편이었던 세트들). */
export interface OpponentHistoryMatch {
  series_id: string;
  played_at: Date;
  event_name: string;
  format: Format;
  best_of: number | null;
  /** 원래 한 판짜리 시리즈인가 — 형식 뱃지(단판/1세트)를 가른다. */
  standalone: boolean;
  record: Counts;
  result: Outcome;
  /** 확인 전 세트가 있다. */
  pending: boolean;
}

export async function listOpponentHistoryMatches(streamerId: string, otherId: string, scope: OpponentScope = {}): Promise<{ matches: OpponentHistoryMatch[]; truncated: boolean }> {
  const rows = selectPairs(await listPairSets(streamerId, scope, otherId, { listed: true }), scope.laneOnly ? "lane" : "opponent");
  const groups = foldSeries(rows.map((r) => ({ ...r, outcome: pairResult(r) })));
  const shown = groups.slice(0, 200);
  const meta = await listSeriesMeta(shown.map((g) => g.series_id));
  return {
    truncated: groups.length > 200,
    matches: shown.map((g) => ({
      series_id: g.series_id, played_at: g.played_at, event_name: g.first.event_name, format: g.first.format,
      best_of: meta.get(g.series_id)?.best_of ?? null,
      standalone: g.sets.length === 1 && isStandaloneSet(g.sets[0].match_id, g.series_id),
      record: g.record, result: g.result, pending: g.pending,
    })),
  };
}

/** 상대전적 상세(모듈)가 받는 한 세트 — 두 사람 사이의 모든 세트를 받아 화면에서 맵·진행 방식·관계·기간으로 고른다. */
export interface PublicPairSet {
  match_id: string;
  series_id: string;
  series_game_no: number | null;
  best_of: number | null;
  set_order_known: boolean;
  event_name: string;
  format: Format;
  map: string;
  relation: PairRelation;
  /** ISO. 서버→클라이언트 경계에서 Date 를 넘기지 않는다. */
  played_at: string;
  series_started_on: string;
  x_outcome: Outcome;
  y_outcome: Outcome;
  x_position: string | null;
  y_position: string | null;
  x_champion_id: number | null;
  y_champion_id: number | null;
  /** 확인 전 — 목록에 보이고 tally 가 세지 않는다. */
  pending: boolean;
}

/** x 기준으로 본 x–y 의 모든 공개 세트(맵·진행 방식·기간 구분 없이). 최신순. */
export async function listPairSetsBetween(x: string, y: string): Promise<PublicPairSet[]> {
  const rows = (await Promise.all([listPairSets(x, { map: "rift" }, y, { listed: true }), listPairSets(x, { map: "aram" }, y, { listed: true })])).flat();
  const meta = await listSeriesMeta([...new Set(rows.map((r) => r.series_id))]);
  return rows.map((r) => ({
    match_id: r.match_id, series_id: r.series_id, series_game_no: r.series_game_no,
    best_of: meta.get(r.series_id)?.best_of ?? null, set_order_known: meta.get(r.series_id)?.set_order_known ?? false,
    event_name: r.event_name, format: r.format, map: r.map, relation: r.relation,
    played_at: new Date(r.played_at).toISOString(), series_started_on: r.series_started_on,
    x_outcome: r.a_outcome, y_outcome: r.b_outcome, x_position: r.a_position, y_position: r.b_position,
    x_champion_id: r.a_champion_id, y_champion_id: r.b_champion_id, pending: r.pending,
  })).sort((a, b) => b.played_at.localeCompare(a.played_at) || a.match_id.localeCompare(b.match_id));
}
