/**
 * 모듈 계약 — 모듈이 core 에서 쓸 수 있는 **전부**.
 *
 * 모듈은 이 계약 디렉터리만 import 한다. 브라우저는 DB를 불러오지 않는 client.ts를 쓴다.
 * `core/lib/db/*` 를 직접 부르면 안 된다.
 * 이유는 두 가지다:
 *
 *  1. **안전.** core/lib/db 는 raw 테이블을 쓴다. 거기엔 visibility='hidden' 인
 *     부계정과 evidence(제보자 메모)가 그대로 들어 있다. 모듈이 그걸 만지면
 *     삭제 요청 경로가 무의미해진다 (docs/PLAN.md §11-2).
 *     여기 있는 함수는 전부 `core_public` 뷰만 읽으므로 애초에 못 본다.
 *     ★ 회원 읽기·쓰기(커뮤니티)는 여기가 아니라 contract/community.ts 다 — 쿠키를 읽어 서버 전용이고(워커 금지),
 *       쓰기는 세션 토큰으로 core 접근자를 부른다. 계약은 공개 읽기 · 화면용 회원 · 회원 쓰기 세 갈래다(ARCHITECTURE §3).
 *
 *  2. **자유.** core 는 내부 테이블을 언제든 바꿀 수 있어야 한다.
 *     계약이 좁을수록 core 가 움직일 여지가 넓다.
 *
 * 모듈이 필요한 게 여기 없으면 **여기에 추가하는 게 맞다**. 우회하지 않는다.
 */

import { db } from "../db/client.ts";
import type { MatchOutcome } from "../db/types.ts";
import type { Position } from "../riot/types.ts";
export type { MatchOutcome } from "../db/types.ts";

// 지표 계산은 모듈도 같은 것을 써야 한다 — 두 군데서 계산하면 반드시 어긋난다.
export { affinity, rawWinRate, games, isSmallSample, formatRecord, SMALL_SAMPLE_THRESHOLD } from "../metrics/affinity.ts";
export type { HeadToHead } from "../metrics/affinity.ts";
export { lpAbsolute, lpAbsoluteToRank, formatRank, tierGridLines } from "../metrics/lp.ts";
export { kda, formatKda } from "../metrics/matchup.ts";
export { kstDateString, kstDotted, kstYear, kstPlayedAt } from "../time.ts";
export { setLabel, isStandaloneSet } from "../metrics/set-label.ts";
export { QUEUE, QUEUE_LABEL, POSITION_LABEL, SUMMONERS_RIFT_QUEUES } from "../riot/types.ts";
export type { Position } from "../riot/types.ts";

// ── 읽기 모델 ────────────────────────────────────────────────────────

export interface PublicStreamer {
  streamer_id: string;
  slug: string;
  display_name: string;
  aliases: string[];
  profile_image_url: string | null;
  channel_id?: string | null;
  is_pro: boolean;
  team_name: string | null;
  status: string;
}

export interface PublicEncounter {
  match_id: string;
  streamer_a_id: string;
  streamer_b_id: string;
  relation: "opponent" | "ally";
  a_position: Position | null;
  b_position: Position | null;
  is_lane_matchup: boolean;
  /** 승패의 유일한 표현 (0028). boolean 승패는 은퇴했다 — 무승부를 표현하지 못한다. */
  a_outcome: MatchOutcome;
  b_outcome: MatchOutcome;
  a_champion_id: number | null;
  b_champion_id: number | null;
  a_kills: number | null; a_deaths: number | null; a_assists: number | null;
  b_kills: number | null; b_deaths: number | null; b_assists: number | null;
  queue_id: number;
  source: string;
  /** 경기 분류 (solo/ck/tournament …). 규칙은 core 의 matchCategory 하나다. */
  category: string;
  /** 같은 다전제를 묶는 키. 세트와 매치를 나눠 세려면 필요하다. */
  series_key: string;
  series_game_no: number | null;
  /** 확인된 승선승제 포맷. 고정 세트제·모르면 null. */
  best_of: number | null;
  /** 세트 순서를 출처에서 확인했나. false 면 "N세트" 로 단정하지 않는다 — 표시는 setLabel 로. */
  set_order_known: boolean;
  /** 'date' 면 시각은 모른다 — 표시는 kstPlayedAt 으로. */
  game_creation_precision: "datetime" | "date";
  /** 대회 이름. 공개 큐면 null. */
  event_name: string | null;
  game_creation: Date;
  game_duration: number | null;
}

/** 선택기용 최소 목록. 이름·별칭·방송국 아이디로 찾을 수 있어야 한다. */
export interface PublicStreamerOption {
  slug: string;
  display_name: string;
  aliases: string[];
  channel_id: string | null;
}

/**
 * 한 경기의 참가자 한 줄.
 *
 * ★ **사람을 못 붙인 자리도 온다**(0022). 그때 `streamer_id`·`slug`·`display_name` 이
 *   전부 NULL 이고 `observed_name` 에 화면에서 읽은 인게임명이 들어 있다.
 *   5대5 를 4명으로 그리면 누락인지 인원 차이인지 구분할 수 없어서 자리를 세운다.
 *   ⚠ 그래서 화면은 **`slug` 가 없을 수 있다고 보고 짜야 한다** — 링크를 걸면 안 된다.
 */
export interface PublicRosterEntry {
  match_id: string;
  participant_id: number;
  streamer_id: string | null;
  slug: string | null;
  display_name: string | null;
  /** 사람을 못 붙였을 때만 채워진다. 등록된 스트리머는 display_name 을 쓴다. */
  observed_name: string | null;
  team_id: number;
  team_name: string | null;
  team_position: Position | null;
  champion_id: number;
  champion_name: string | null;
  outcome: MatchOutcome;
  /**
   * ★ 못 읽었으면 NULL 이다 (0020). 방송 결과 화면이 그래프 탭이면 승패만 읽히고,
   *   그때 0 으로 채우면 "딜 안 하고 안 죽은 사람"이 전적에 남는다.
   *   화면은 NULL 을 '—' 로 그린다. 0 과 구분해서 쓸 것.
   */
  kills: number | null; deaths: number | null; assists: number | null;
}

/** 조우가 있는 두 사람. 상대전적 첫 화면이 "많이 붙은 쌍" 을 그릴 재료다. */
export interface PublicPair {
  a_slug: string; a_name: string;
  b_slug: string; b_name: string;
  sets: number;
  vs_sets: number;
  lane_sets: number;
  last_met: Date;
}

export interface PublicRankPoint {
  streamer_id: string;
  puuid: string;
  queue_type: string;
  snapshot_date: string;
  tier: string | null;
  division: string | null;
  league_points: number | null;
  lp_absolute: number | null;
}

export async function listPublicStreamers(): Promise<PublicStreamer[]> {
  return db()<PublicStreamer[]>`
    SELECT streamer_id, slug, display_name, aliases, profile_image_url, is_pro, team_name, status,
           (SELECT channel_id FROM core_public.streamer_channel c WHERE c.streamer_id = s.streamer_id
             AND c.platform = 'soop' ORDER BY is_primary DESC LIMIT 1) AS channel_id
      FROM core_public.streamer s ORDER BY display_name
  `;
}

export async function getPublicStreamer(slug: string): Promise<PublicStreamer | null> {
  const rows = await db()<PublicStreamer[]>`
    SELECT streamer_id, slug, display_name, aliases, profile_image_url, is_pro, team_name, status,
           (SELECT channel_id FROM core_public.streamer_channel c WHERE c.streamer_id = s.streamer_id
             AND c.platform = 'soop' ORDER BY is_primary DESC LIMIT 1) AS channel_id
      FROM core_public.streamer s WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0] ?? null;
}

/** 한 스트리머의 조우 전부. 상대·아군 모두 포함한다. */
export async function listEncountersFor(streamerId: string, limit = 500): Promise<PublicEncounter[]> {
  return db()<PublicEncounter[]>`
    SELECT e.match_id, e.streamer_a_id, e.streamer_b_id, e.relation,
           e.a_position, e.b_position, e.is_lane_matchup, e.a_outcome, e.b_outcome,
           e.a_champion_id, e.b_champion_id,
           e.a_kills, e.a_deaths, e.a_assists, e.b_kills, e.b_deaths, e.b_assists,
           e.queue_id, e.source, e.category, e.series_key, e.series_game_no, e.best_of,
           e.set_order_known, e.game_creation_precision,
           e.game_creation, e.game_duration,
           ev.name AS event_name
      FROM core_public.streamer_encounter e
      JOIN core_public.match m ON m.match_id = e.match_id
      LEFT JOIN core_public.event ev ON ev.event_id = m.event_id
     WHERE e.streamer_a_id = ${streamerId}::uuid OR e.streamer_b_id = ${streamerId}::uuid
     ORDER BY e.game_creation DESC LIMIT ${limit}
  `;
}

/** 두 스트리머 사이의 조우. 쌍 정규화(a < b)는 여기서 흡수한다 — 모듈이 신경 쓸 일이 아니다. */
export async function listEncountersBetween(x: string, y: string, limit = 500): Promise<PublicEncounter[]> {
  const [a, b] = [x, y].sort();
  return db()<PublicEncounter[]>`
    SELECT e.match_id, e.streamer_a_id, e.streamer_b_id, e.relation,
           e.a_position, e.b_position, e.is_lane_matchup, e.a_outcome, e.b_outcome,
           e.a_champion_id, e.b_champion_id,
           e.a_kills, e.a_deaths, e.a_assists, e.b_kills, e.b_deaths, e.b_assists,
           e.queue_id, e.source, e.category, e.series_key, e.series_game_no, e.best_of,
           e.set_order_known, e.game_creation_precision,
           e.game_creation, e.game_duration,
           ev.name AS event_name
      FROM core_public.streamer_encounter e
      JOIN core_public.match m ON m.match_id = e.match_id
      LEFT JOIN core_public.event ev ON ev.event_id = m.event_id
     WHERE e.streamer_a_id = ${a}::uuid AND e.streamer_b_id = ${b}::uuid
     ORDER BY e.game_creation DESC, e.series_game_no DESC LIMIT ${limit}
  `;
}

/** 티어 추이. snapshot_date 오름차순 — 그래프에 그대로 꽂는다. */
export async function listRankSeries(
  streamerId: string,
  queueType = "RANKED_SOLO_5x5",
): Promise<PublicRankPoint[]> {
  return db()<PublicRankPoint[]>`
    SELECT * FROM core_public.rank_snapshot
     WHERE streamer_id = ${streamerId}::uuid AND queue_type = ${queueType}
     ORDER BY snapshot_date
  `;
}

/** 최신 스냅샷 한 장씩. 리더보드의 원재료. */
export async function latestRanks(queueType = "RANKED_SOLO_5x5"): Promise<PublicRankPoint[]> {
  return db()<PublicRankPoint[]>`
    SELECT DISTINCT ON (streamer_id, puuid) *
      FROM core_public.rank_snapshot
     WHERE queue_type = ${queueType}
     ORDER BY streamer_id, puuid, snapshot_date DESC
  `;
}

/** 이름·별칭·방송국 아이디로 찾는 선택기용 목록. */
export async function listPublicStreamerOptions(): Promise<PublicStreamerOption[]> {
  return db()<PublicStreamerOption[]>`
    SELECT s.slug, s.display_name, s.aliases, ch.channel_id
      FROM core_public.streamer s
      LEFT JOIN LATERAL (
             SELECT channel_id FROM core_public.streamer_channel
              WHERE streamer_id = s.streamer_id ORDER BY is_primary DESC LIMIT 1
           ) ch ON true
     ORDER BY s.display_name
  `;
}

/**
 * 경기별 로스터. "그 판에 누가 있었나" 를 보여줄 때 쓴다.
 *
 * ★ 스트리머 조인이 **LEFT 다**(0022). 사람을 못 붙인 자리도 로스터에 세워야 하기
 *   때문이다 — 예전엔 여기서 한 번 더 걸러서, 뷰가 내보내도 화면엔 안 나왔다.
 *   누가 나오고 누가 빠지는지는 **뷰가 정한다**(숨긴 경기·계정·사람은 거기서 빠진다).
 *   이 질의가 또 거르면 그 규칙이 두 군데로 갈라진다.
 */
export async function listMatchRosters(matchIds: string[]): Promise<PublicRosterEntry[]> {
  if (matchIds.length === 0) return [];
  return db()<PublicRosterEntry[]>`
    SELECT mp.match_id, mp.participant_id, mp.streamer_id, s.slug, s.display_name, mp.observed_name,
           mp.team_id, mp.team_position, mp.champion_id, mp.champion_name, mp.outcome,
           mp.kills, mp.deaths, mp.assists,
           t.name AS team_name
      FROM core_public.match_participant mp
      LEFT JOIN core_public.streamer s ON s.streamer_id = mp.streamer_id
      JOIN core_public.match m    ON m.match_id = mp.match_id
      LEFT JOIN core_public.event_team t
             ON t.event_team_id = CASE WHEN mp.team_id = 100 THEN m.blue_team_id ELSE m.red_team_id END
     WHERE mp.match_id = ANY(${matchIds}::text[])
     -- 이름이 없는 자리는 맨 뒤로. 등록된 사람 먼저 보이는 게 읽기 편하다.
     ORDER BY mp.match_id, mp.team_id, mp.team_position NULLS LAST,
              s.display_name NULLS LAST, mp.observed_name
  `;
}

/**
 * 많이 붙은 쌍. 정렬은 **맞대결 세트** 다 — 총 조우로 정렬하면 같은 팀으로만
 * 만난 쌍이 위에 올라와서, 이 사이트가 무엇을 세는 곳인지 첫 화면부터 어긋난다.
 * laneOnly이면 집계와 LIMIT 전에 맞라인 세트만 남겨 순위·횟수 모두 맞라인 기준으로 낸다.
 */
export async function listPublicPairs(limit = 20, laneOnly = false, streamerSlug?: string): Promise<PublicPair[]> {
  return db()<PublicPair[]>`
    SELECT a.slug AS a_slug, a.display_name AS a_name,
           b.slug AS b_slug, b.display_name AS b_name,
           count(*)::int                                        AS sets,
           count(*) FILTER (WHERE e.relation = 'opponent')::int  AS vs_sets,
           count(*) FILTER (WHERE e.is_lane_matchup)::int        AS lane_sets,
           max(e.game_creation)                                  AS last_met
      FROM core_public.streamer_encounter e
      JOIN core_public.streamer a ON a.streamer_id = e.streamer_a_id
      JOIN core_public.streamer b ON b.streamer_id = e.streamer_b_id
     WHERE (NOT ${laneOnly} OR (e.relation = 'opponent' AND e.is_lane_matchup))
       AND (${streamerSlug ?? null}::text IS NULL OR a.slug = ${streamerSlug ?? null} OR b.slug = ${streamerSlug ?? null})
     GROUP BY 1, 2, 3, 4
    HAVING count(*) FILTER (WHERE e.relation = 'opponent') > 0
     ORDER BY vs_sets DESC, sets DESC, a.slug, b.slug
     LIMIT ${limit}
  `;
}

// ── 모듈 전용 SQL ────────────────────────────────────────────────────

/**
 * 모듈이 자기 스키마에 쓰기 위한 통로.
 *
 * ★ core 테이블을 건드리면 안 된다. 규칙은 `npm run verify:modules` 가 검사한다.
 *   여기서 raw 클라이언트를 주는 이유는 모듈마다 필요한 집계가 달라서인데,
 *   대신 어디에 쓸 수 있는지를 스키마 이름으로 못 박는다.
 */
export function moduleDb(schema: string) {
  if (!/^mod_[a-z0-9_]+$/.test(schema)) {
    throw new Error(`모듈 스키마 이름은 mod_ 로 시작해야 한다: ${schema}`);
  }
  return db();
}

// 공개 프로필의 수상·챔피언 기록. UI 모듈도 같은 읽기 모델을 사용한다.
export { listStreamerEvents, summarizePlacements, listChampions } from "../db/public.ts";
export { placementRank } from "../metrics/placement.ts";

// FC 온라인 공개 조회. FC 는 아직 core_public 뷰가 없어 조회 안에서 공개 범위를 걸고,
// 넥슨 원본(match_info)은 허용 목록 키만 내보낸다 — 숨긴 신원이 안 새는지는 verify:fco 가 본다.
export {
  listFcoPeople, getFcoPerson, listFcoVersus, listFcoTopPairs, getFeaturedFcoPair,
  listFcoEvents, getFcoEvent, listFcoEventGames, getFcoGame, FCO_PUBLIC_MATCH_INFO_KEYS,
} from "../db/fconline.ts";
export type { FcoGame, FcoParticipant, FcoPerson, FcoEvent, FcoTopPair } from "../db/fconline.ts";
export { addFcoStats, EMPTY_FCO_STATS, fcoNumber, FCO_MODE_LABEL } from "../games/fconline/view.ts";
export type { FcoStatLine } from "../games/fconline/view.ts";
export { fcoSeriesScore, groupFcoSeries } from "../games/fconline/series.ts";
export { fcoMetadata } from "../games/fconline/meta.ts";
// FC 구단(공식 구단가치·스쿼드 등록 선수·가치 이력). 원본 셋에서 계산만 한다 — docs/FCO-CLUB-VALUE-PLAN.md.
export { listFcoClubBoard, getFcoClub } from "../db/fconline-club.ts";
export type { FcoClubBoardRow, FcoClub, FcoClubAccountSummary, FcoClubSquad, FcoClubPoint } from "../db/fconline-club.ts";
export { cardKey, changeOver, formatWon, squadLabel, SQUAD_LABEL } from "../metrics/club-value.ts";
export type { HeldCard, HoldingRow, ValuePoint, ValueChange } from "../metrics/club-value.ts";

// 공개 대회 사실. 분류·집계·화면은 대회 모듈이 한다.
export { listPublicTournamentEvents, getPublicTournamentFacts } from "../db/public-tournaments.ts";
export type {
  PublicTournamentEventRow, PublicTournamentTeamRow, PublicTournamentMemberRow, PublicTournamentMatchRow,
  PublicTournamentLinkRow, PublicTournamentFactRow,
} from "../db/public-tournaments.ts";
// 대진(칸·화살표·결정). 계산은 core 한 곳 — 롤·FC 모듈이 같은 함수로 대진표와 순위를 그린다(docs/TOURNAMENT-FORMAT-PLAN.md).
export { getEventBracket } from "../db/event-bracket.ts";
export type { EventBracket } from "../db/event-bracket.ts";
export { resolveBracket, displayRank, rankText, slotDepths } from "../tournament/bracket.ts";
export type { BracketResult, ResolvedSlot, Certainty } from "../tournament/bracket.ts";
export { championById, championIconPath, CHAMPION_DATA_VERSION } from "../riot/champions.ts";

export { MATCH_CATEGORIES, RIFT_MATCH_CATEGORIES, CATEGORY_LABEL, isMatchCategoryFilter, expandCategory } from "../metrics/category.ts";
export type { MatchCategoryFilter } from "../metrics/category.ts";

export { RECORD_PERIODS, recordPeriodLabel, resolveRecordPeriod, withinRecordPeriod } from "../metrics/record-period.ts";
export type { RecordPeriod } from "../metrics/record-period.ts";

// 사이트 주소. core 화면 주소는 이 함수로만 만든다 — 모듈·공용 UI 에 주소 글자를 박지 않는다(verify:modules).
// 모듈 자기 화면은 module.json 의 routes 를 routeHref 에 넘겨 만든다.
export { gameHomeHref, profileHref, streamersHref, fcMatchHref, routeHref } from "../site-paths.ts";
export type { SiteGame, HrefQuery } from "../site-paths.ts";

// 편성표 — 공개 일정(core_public 만 읽는다)과 시간 규칙. 상태 문구·진행 판정은 metrics/schedule 하나가 정한다.
export { getPublicScheduleEntry, listPublicSchedule, listPublicScheduleChanges, SCHEDULE_MAX_DAYS } from "../db/schedule-public.ts";
export type { PublicScheduleChange, PublicScheduleEntry, PublicScheduleSlot, PublicScheduleQuery } from "../db/schedule-public.ts";
export {
  addDays, daysBetween, entryPeriod, entryState, kstClock, kstDayStart, slotPhase, slotTimeLabel,
  ENTRY_STATE_LABEL, SCHEDULE_GAME_LABEL, SCHEDULE_KIND_LABEL, SCHEDULE_ROLE_LABEL,
  SCHEDULE_GAMES, describeChange,
} from "../metrics/schedule.ts";
export type { EntryState, ScheduleGame, SlotPhase } from "../metrics/schedule.ts";

// 솔로랭크 — 정해진 계정들의 랭크 판·랭크 추이·같은 판의 다른 스트리머(솔랭 도전 모듈)
export { listPublicRankedGames, listPublicAccountRanks, listPublicCoPlayers, RANKED_CHALLENGE_KEYS } from "../db/public-ranked.ts";
export type { PublicRankedGame, PublicAccountRank, RankedChallengeKey } from "../db/public-ranked.ts";
export { itemIconPath, itemName, spellIconPath, spellName, runeIconPath, runeName } from "../riot/build-icons.ts";
export { listPublicLineups } from "../db/public-ranked.ts";
export type { PublicLineupSlot } from "../db/public-ranked.ts";
