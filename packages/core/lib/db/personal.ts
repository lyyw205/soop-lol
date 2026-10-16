/**
 * 개인 기록 — 한 스트리머의 공개 내전 세트(core_public.lol_versus_set 의 본인 행)를 고른다.
 *
 * ★ 요약 카드·매치 히스토리·챔피언 탭·사이드바 모스트 챔피언이 **같은 고르기**(`listPersonalSets` + `versusScopeSql`)와
 *   **같은 세기**(tally.ts)를 쓴다. 예전엔 요약이 SQL 다수결(+랜드 분기)로, 탭이 파생 표로 따로 셌다.
 * ★ 보너스 판(범인찾기 등)은 집계에 없다 — 매치 히스토리를 펼쳤을 때만 core_public.match_detail 에서 읽어 보인다(0079).
 */
import { db } from "./client.ts";
import { versusScopeSql } from "./public.ts";
import { listPairSets } from "./opponent-history.ts";
import type { Format } from "../metrics/format.ts";
import type { Counts, Outcome } from "../metrics/tally.ts";
import type { VersusScope } from "../metrics/record-scope.ts";
import { foldSeries, pageSeries } from "../metrics/record-series.ts";
import { championRecords, type ChampionRecord } from "../metrics/record-champions.ts";
import { pairResult, selectPairs } from "../metrics/opponent-history.ts";
export type { ChampionRecord, ChampionLine } from "../metrics/record-champions.ts";

/** 본인이 뛴 공개 본게임 세트 한 줄. */
export interface PersonalSet {
  match_id: string;
  series_id: string;
  series_game_no: number | null;
  played_at: Date;
  game_creation_precision: "datetime" | "date";
  /** KST 달력 날짜 — 기간 필터의 기준. */
  series_started_on: string;
  outcome: Outcome;
  side: number;
  position: string | null;
  champion_id: number | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  event_id: string;
  event_name: string;
  format: Format;
  map: string;
  best_of: number | null;
  set_order_known: boolean;
  /** 확인 전(회원 제보, 0093) — `listed` 로 읽었을 때만 true 일 수 있다. tally 가 세지 않는다. */
  pending: boolean;
}

/**
 * 공개 내전 세트 중 본인 행 — 맵 탭·진행 방식·기간으로 고른다. 최신순.
 * `listed` — 목록용(확인 전 세트 포함, lol_set_row). 기본은 집계용(lol_versus_set — 확인 전 없음). 둘 다 tally 로 세면 같은 점수다.
 */
export async function listPersonalSets(streamerId: string, scope: VersusScope = {}, { listed = false }: { listed?: boolean } = {}): Promise<PersonalSet[]> {
  const sql = db();
  return sql<PersonalSet[]>`
    SELECT v.match_id, v.series_id, v.series_game_no, v.played_at, v.game_creation_precision,
           v.series_started_on::text AS series_started_on, v.outcome, v.side, v.position, v.champion_id,
           v.kills, v.deaths, v.assists, v.event_id, e.name AS event_name, v.format, v.map, v.best_of, v.set_order_known,
           ${listed ? sql`v.pending` : sql`false`} AS pending
      FROM ${listed ? sql`core_public.lol_set_row` : sql`core_public.lol_versus_set`} v
      JOIN core_public.event e ON e.event_id = v.event_id
     WHERE v.streamer_id = ${streamerId}::uuid AND ${versusScopeSql(sql, "v", scope)}
     ORDER BY v.played_at DESC, v.match_id
  `;
}

/** 펼친 목록의 한 판. 보너스 판은 여기에만 있고 record·result 에 들어가지 않는다. */
export interface PersonalMatchSet {
  match_id: string;
  series_game_no: number | null;
  set_role: "main" | "bonus";
  /** 방송에서 부른 보너스 판 이름. 없으면 null. */
  set_label: string | null;
  outcome: Outcome;
  /** 확인 전 세트 — "확인 전" 표시, 점수에는 없다. */
  pending: boolean;
}

/** 매치 히스토리 한 줄 = 한 시리즈(본인이 뛴, 고른 세트들). */
export interface PersonalMatch {
  series_id: string;
  played_at: Date;
  event_name: string;
  format: Format;
  best_of: number | null;
  set_order_known: boolean;
  /** 본게임 세트 결과. */
  record: Counts;
  /** 시리즈 결과(tally 규칙). */
  result: Outcome;
  /** 확인 전 세트가 있다. */
  pending: boolean;
  /** 본게임 + 보너스, 세트 번호·시각 순. */
  sets: PersonalMatchSet[];
}

/**
 * 매치 히스토리 한 쪽. 이미 고른 세트(`listPersonalSets(…, { listed: true })` — 확인 전 포함)를 시리즈로 접어 자른다 — 요약 카드와 분모가 같다.
 * 시리즈를 중간에서 자르지 않는다. 보너스 판은 보이는 시리즈의 것만 match_detail 에서 읽는다.
 */
export async function listPersonalMatches(streamerId: string, sets: readonly PersonalSet[], { limit = 20, cursor }: { limit?: number; cursor?: string } = {}): Promise<{ rows: PersonalMatch[]; more: boolean }> {
  const page = pageSeries(foldSeries(sets), cursor, Math.min(100, Math.max(1, limit)));
  const ids = page.rows.map((g) => g.series_id);
  const bonus = ids.length ? await db()<(PersonalMatchSet & { series_id: string; played_at: Date })[]>`
    SELECT DISTINCT ON (d.match_id) d.match_id, d.series_id, d.series_game_no, d.set_role, d.set_label, d.outcome, d.played_at, d.pending
      FROM core_public.match_detail d
     WHERE d.series_id = ANY(${ids}) AND d.set_role = 'bonus' AND d.streamer_id = ${streamerId}::uuid
     ORDER BY d.match_id
  ` : [];
  return {
    more: page.more,
    rows: page.rows.map((g) => {
      const extra = bonus.filter((b) => b.series_id === g.series_id);
      const main: (PersonalMatchSet & { at: number })[] = g.sets.map((s) => ({
        match_id: s.match_id, series_game_no: s.series_game_no, set_role: "main", set_label: null, outcome: s.outcome,
        pending: s.pending, at: new Date(s.played_at).getTime(),
      }));
      const all = [...main, ...extra.map((b) => ({
        match_id: b.match_id, series_game_no: b.series_game_no, set_role: "bonus" as const, set_label: b.set_label, outcome: b.outcome,
        pending: b.pending, at: new Date(b.played_at).getTime(),
      }))].sort((a, b) => a.at - b.at || (a.series_game_no ?? 0) - (b.series_game_no ?? 0) || a.match_id.localeCompare(b.match_id));
      return {
        series_id: g.series_id, played_at: g.played_at, event_name: g.first.event_name, format: g.first.format,
        best_of: g.first.best_of, set_order_known: g.first.set_order_known, record: g.record, result: g.result, pending: g.pending,
        sets: all.map(({ match_id, series_game_no, set_role, set_label, outcome, pending }) => ({ match_id, series_game_no, set_role, set_label, outcome, pending })),
      };
    }),
  };
}

/**
 * 챔피언 기록 — 챔피언 탭과 사이드바 모스트 챔피언이 같이 쓴다(metrics/record-champions).
 * 맞라인 상대는 상대전적의 맞라인과 같은 정의(같은 고르기의 versus_pair_set, isLanePair).
 */
export async function listChampionRecords(streamerId: string, limit = 20, scope: VersusScope = {}): Promise<ChampionRecord[]> {
  const [mine, pairs] = await Promise.all([listPersonalSets(streamerId, scope), listPairSets(streamerId, scope)]);
  const lane = selectPairs(pairs, "lane").map((p) => ({
    match_id: p.match_id, series_id: p.series_id, foe_champion_id: p.b_champion_id, outcome: pairResult(p),
  }));
  return championRecords(mine, lane, limit);
}

/**
 * 사이드바·프로필 카드의 "모스트 챔피언" — **챔피언 탭의 기본 보기(협곡 · 전체 진행 방식 · 전체 기간)와 같은 수**다.
 * 칼바람은 맵이 달라 섞지 않는다(맵 탭이 따로 있다).
 */
export function listChampions(streamerId: string, limit = 8): Promise<ChampionRecord[]> {
  return listChampionRecords(streamerId, limit, { map: "rift" });
}
