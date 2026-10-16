/**
 * 공개 화면 질의.
 *
 * ★ 전부 `core_public` 뷰만 읽는다. 원본 테이블을 쓰지 않는다.
 *   관리자 화면(`streamers.ts`)은 원본을 보지만, 공개 화면은 숨김 처리를
 *   **질의마다 기억해서** 지키는 게 아니라 뷰가 대신 지키게 한다.
 *   `WHERE visibility = 'public'` 을 한 군데라도 빠뜨리면 그게 사고다.
 *
 * ★ 공개 집계는 **고르기·세기·보여 주기 함수 각 하나**만 거친다(docs/CLASSIFICATION-REDESIGN-PLAN.md §5).
 *   고르기 = `core_public.lol_versus_set`(공개 내전 본게임 세트, 한 행 = 사람×세트)·`versus_pair_set` + `versusScopeSql`,
 *   세기 = `metrics/tally.ts`, 보여 주기 = `packages/ui/record-pair.tsx`. 옛 분류(category)·파생 표(조우·챔피언 통계)는 없다.
 *
 * 모듈이 쓰는 `lib/contract` 와 같은 면을 본다 — 공개 화면도 결국 모듈과
 * 같은 자격으로 core 를 읽는 소비자다.
 */

import type postgres from "postgres";
import { isTitle, isRunnerUp } from "../metrics/event.ts";
import { db } from "./client.ts";
import type { Format } from "../metrics/format.ts";
import { tally, type Outcome, type Tally } from "../metrics/tally.ts";
import { DEFAULT_MAP, scopeFormat, type VersusScope } from "../metrics/record-scope.ts";
import { PLACEMENT_BUCKETS, placementBucket } from "../metrics/placement.ts";

/**
 * 공개 내전 세트를 고르는 조건 — 맵 탭·진행 방식·기간. `alias` 는 lol_versus_set(또는 같은 칸을 가진 versus_pair_set)의 별칭.
 * ★ 이 조건 하나를 개인 기록·상대 전적·챔피언·대회 성적이 같이 쓴다. 화면마다 따로 거르면 "전체 = 칩 합" 이 깨진다.
 * ★ 기간은 시리즈 첫 본게임의 KST 날짜(series_started_on) — 자정을 넘긴 3세트를 중간에서 자르지 않는다.
 */
export function versusScopeSql(sql: postgres.Sql, alias: string, scope: VersusScope = {}) {
  const map = scope.map ?? DEFAULT_MAP;
  const format = scopeFormat(map, scope.format ?? "all");
  const a = sql(alias);
  return sql`${a}.map = ${map}
    AND (${format}::text IS NULL OR ${a}.format = ${format}::text)
    AND (${scope.from ?? null}::date IS NULL OR ${a}.series_started_on >= ${scope.from ?? null}::date)
    AND (${scope.to ?? null}::date IS NULL OR ${a}.series_started_on <= ${scope.to ?? null}::date)`;
}

// ── 목록 ─────────────────────────────────────────────────────────────

export interface StreamerCard {
  profile_image_url: string | null;
  streamer_id: string;
  slug: string;
  display_name: string;
  aliases: string[];
  is_pro: boolean;
  team_name: string | null;
  channel_id: string | null;
  channel_url: string | null;
  platform: string | null;
  tier: string | null;
  division: string | null;
  league_points: number | null;
  lp_absolute: number | null;
  /** 대표 게임 계정(본계 우선)의 인게임 이름. 붙인 계정이 없으면 null. */
  account_name: string | null;
  account_tag: string | null;
  /** 붙어 있는 계정 수. 2 이상이면 화면에 `외 N` 을 붙인다. */
  account_count: number;
  /** 대회 우승 횟수(팀 순위 1위). 순위를 모르는 대회는 세지 않는다. */
  titles: number;
}

export async function listStreamerCards(opts: { q?: string } = {}): Promise<StreamerCard[]> {
  const sql = db();
  const q = opts.q?.trim();
  // ★ 화면이 쓰는 칸만 읽는다. 예전엔 경기 수·조우 수도 사람마다 셌는데 목록 화면은 둘 다 쓰지 않았다(카드 시절의 흔적).
  //   게다가 옛 참가자 공개 뷰의 streamer_id 는 COALESCE 계산값이라 인덱스를 못 탄다 — 한 명 세는 데 9.6초,
  //   공개 큐 1.6만 경기가 처음 들어온 날(2026-10-02) 820명분이 문장 시간 제한에 걸려 목록이 500 이었다.
  return sql<StreamerCard[]>`
    SELECT s.streamer_id, s.slug, s.display_name, s.aliases, s.is_pro, s.team_name, s.profile_image_url,
           ch.channel_id, ch.channel_url, ch.platform,
           r.tier, r.division, r.league_points, r.lp_absolute,
           acc.game_name AS account_name, acc.tag_line AS account_tag,
           coalesce(acc.total, 0)::int AS account_count,
           coalesce(tt.n, 0)::int AS titles
      FROM core_public.streamer s
      LEFT JOIN LATERAL (
             SELECT platform, channel_id, channel_url FROM core_public.streamer_channel
              WHERE streamer_id = s.streamer_id ORDER BY is_primary DESC LIMIT 1
           ) ch ON true
      -- 계정이 여러 개면 **가장 높은 계정**으로 대표한다. 부계정이 따로 뜨면 같은 사람이 두 줄이 된다.
      LEFT JOIN LATERAL (
             SELECT tier, division, league_points, lp_absolute
               FROM core_public.rank_snapshot
              WHERE streamer_id = s.streamer_id AND queue_type = 'RANKED_SOLO_5x5'
                AND snapshot_date = (SELECT max(snapshot_date) FROM core_public.rank_snapshot
                                      WHERE streamer_id = s.streamer_id AND queue_type = 'RANKED_SOLO_5x5')
              ORDER BY lp_absolute DESC NULLS LAST LIMIT 1
           ) r ON true
      -- ★ 순위를 **모르는** 대회는 세지 않는다. 우승 옆의 숫자가 무슨 뜻인지 흐려진다.
      LEFT JOIN LATERAL (
             SELECT count(*) AS n
               FROM core_public.event_team_member tm
               JOIN core_public.event_team t ON t.event_team_id = tm.event_team_id
               JOIN core_public.event e ON e.event_id = tm.event_id AND e.game_code = 'lol'
              WHERE tm.streamer_id = s.streamer_id AND e.format = 'tournament' AND t.placement_rank = 1
           ) tt ON true
      -- 대표 계정은 **본계 우선**이다. 부계정이 대표로 뜨면 같은 사람을 못 알아본다.
      LEFT JOIN LATERAL (
             SELECT a.game_name, a.tag_line,
                    (SELECT count(*) FROM core_public.streamer_account
                      WHERE streamer_id = s.streamer_id) AS total
               FROM core_public.streamer_account a
              WHERE a.streamer_id = s.streamer_id
              ORDER BY a.is_main DESC, a.game_name LIMIT 1
           ) acc ON true
     WHERE ${q
       ? sql`(s.display_name ILIKE ${"%" + q + "%"}
              OR s.slug ILIKE ${"%" + q + "%"}
              OR EXISTS (SELECT 1 FROM unnest(s.aliases) a WHERE a ILIKE ${"%" + q + "%"})
              OR EXISTS (SELECT 1 FROM core_public.streamer_channel c
                          WHERE c.streamer_id = s.streamer_id AND c.channel_id ILIKE ${"%" + q + "%"}))`
       : sql`true`}
     ORDER BY r.lp_absolute DESC NULLS LAST, s.display_name
  `;
}

// ── 프로필 ───────────────────────────────────────────────────────────

export interface ProfileAccount {
  puuid: string;
  game_name: string | null;
  tag_line: string | null;
  label: string | null;
  is_main: boolean;
  tier: string | null;
  division: string | null;
  league_points: number | null;
  lp_absolute: number | null;
  wins: number | null;
  losses: number | null;
}

export async function getStreamerBySlug(slug: string) {
  const sql = db();
  const rows = await sql<
    { streamer_id: string; slug: string; display_name: string; aliases: string[]; is_pro: boolean; team_name: string | null; profile_image_url: string | null }[]
  >`
    SELECT streamer_id, slug, display_name, aliases, is_pro, team_name, profile_image_url
      FROM core_public.streamer WHERE slug = ${slug} LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function listPublicChannels(
  streamerId: string,
): Promise<{ platform: string; channel_id: string; channel_url: string | null; label: string | null; is_primary: boolean }[]> {
  const sql = db();
  return sql`
    SELECT platform, channel_id, channel_url, label, is_primary
      FROM core_public.streamer_channel
     WHERE streamer_id = ${streamerId}::uuid
     ORDER BY is_primary DESC, platform
  `;
}

export async function listProfileAccounts(streamerId: string): Promise<ProfileAccount[]> {
  const sql = db();
  return sql<ProfileAccount[]>`
    SELECT a.puuid, a.game_name, a.tag_line, a.label, a.is_main,
           r.tier, r.division, r.league_points, r.lp_absolute, r.wins, r.losses
      FROM core_public.streamer_account a
      LEFT JOIN LATERAL (
             SELECT tier, division, league_points, lp_absolute, wins, losses
               FROM core_public.rank_snapshot
              WHERE puuid = a.puuid AND queue_type = 'RANKED_SOLO_5x5'
              ORDER BY snapshot_date DESC LIMIT 1
           ) r ON true
     WHERE a.streamer_id = ${streamerId}::uuid
     ORDER BY a.is_main DESC, r.lp_absolute DESC NULLS LAST
  `;
}

// ── 대회 ─────────────────────────────────────────────────────────────

export interface EventRecord {
  event_slug: string;
  event_name: string;
  starts_at: Date | null;
  format: Format;
  team_name: string | null;
  position: string | null;
  /** 출처가 쓴 그대로의 순위 표기. 모르면 null — 지어내지 않는다. */
  placement: string | null;
  placement_rank: number | null;
  /** 이 대회에서 뛴 공개 본게임의 세트·시리즈 전적(맵 구분 없이 그 대회 전부). 경기를 못 붙였으면 전부 0. */
  record: Tally;
}

/**
 * 이 스트리머가 나간 롤 대회(진행 방식 tournament)와 그 성적. 최신순.
 *
 * ★ 성적은 공개 내전 세트(lol_versus_set)의 그 대회 세트를 tally 로 센다 — 다전제 2:1 은 세트 2승 1패, 시리즈 1승이다.
 *   옛 SQL 다수결 사본(세트 과반·정확히 반은 무)은 지웠다. 미상이 섞이면 tally 표대로 미상이다.
 * ★ 기간(`from`·`to`)을 주면 대회 기간(effective_starts_at~effective_ends_at)이 겹치는 대회만, 성적도 그 기간의 시리즈만 센다.
 *   예전엔 대회 탭이 기간 필터를 무시했다.
 * 팀명은 event_team 에서 온다(대회 단위 소속). 계정이 없어 경기에 못 들어간 사람도 팀 명단에는 있으므로
 * 전적이 0 인 줄이 나올 수 있다 — "나갔지만 우리가 전적을 못 붙였다" 는 사실이라 지우지 않는다.
 */
export async function listStreamerEvents(streamerId: string, period: { from?: string; to?: string } = {}): Promise<EventRecord[]> {
  const sql = db();
  const from = period.from ?? null, to = period.to ?? null;
  const events = await sql<(Omit<EventRecord, "record"> & { event_id: string })[]>`
    SELECT e.event_id, e.slug AS event_slug, e.name AS event_name, e.effective_starts_at AS starts_at, e.format,
           t.name AS team_name, tm.position, t.placement, t.placement_rank
      FROM core_public.event_team_member tm
      JOIN core_public.event_team t ON t.event_team_id = tm.event_team_id
      JOIN core_public.event_dates e ON e.event_id = tm.event_id
     -- ★ 롤 프로필의 대회 이력이다. FC 대회 참가 단위가 섞이지 않게 게임을 건다(0062).
     WHERE tm.streamer_id = ${streamerId}::uuid AND e.game_code = 'lol' AND e.format = 'tournament'
       -- 날짜를 모르는 대회는 기간으로 거르지 않는다(모르는 것을 밖이라고 단정하지 않는다).
       AND (${from}::date IS NULL OR coalesce(e.effective_ends_at, e.effective_starts_at) IS NULL
            OR (coalesce(e.effective_ends_at, e.effective_starts_at) AT TIME ZONE 'Asia/Seoul')::date >= ${from}::date)
       AND (${to}::date IS NULL OR e.effective_starts_at IS NULL
            OR (e.effective_starts_at AT TIME ZONE 'Asia/Seoul')::date <= ${to}::date)
     ORDER BY e.effective_starts_at DESC NULLS LAST, e.slug
  `;
  if (!events.length) return [];
  const sets = await sql<{ event_id: string; series_id: string; outcome: Outcome }[]>`
    SELECT v.event_id, v.series_id, v.outcome
      FROM core_public.lol_versus_set v
     WHERE v.streamer_id = ${streamerId}::uuid AND v.event_id = ANY(${events.map((e) => e.event_id)}::uuid[])
       AND (${from}::date IS NULL OR v.series_started_on >= ${from}::date)
       AND (${to}::date IS NULL OR v.series_started_on <= ${to}::date)
  `;
  return events.map(({ event_id, ...e }) => ({ ...e, record: tally(sets.filter((s) => s.event_id === event_id)) }));
}

export interface PlacementTally {
  key: string;
  label: string;
  count: number;
}

/** 순위 요약 한 덩어리. 화면 쪽에서 프로퍼티로 받으려면 이름이 있어야 한다. */
export interface PlacementSummary {
  /** 모든 대회의 순위(올스타전 포함, 2026-10-13 결정). */
  buckets: PlacementTally[];
  unknown: number;
  /** 참가 대회 수 — 올스타전 포함(참가는 참가다). */
  total: number;
}

/**
 * 순위별 횟수. 프로필 맨 위 요약 카드에 쓴다. **통산**이다 — 어느 탭·기간에서도 같은 값이어야 한다.
 *
 * 순위를 모르는 대회는 세지 않고 `unknown` 으로 따로 돌려준다 —
 * 합계에 슬쩍 섞으면 "우승 2회" 옆의 숫자들이 무슨 뜻인지 알 수 없게 된다.
 */
export async function summarizePlacements(streamerId: string): Promise<PlacementSummary> {
  const sql = db();
  const rows = await sql<{ format: Format; placement_rank: number | null }[]>`
    SELECT e.format, t.placement_rank
      FROM core_public.event_team_member tm
      JOIN core_public.event_team t ON t.event_team_id = tm.event_team_id
      JOIN core_public.event e ON e.event_id = tm.event_id
     WHERE tm.streamer_id = ${streamerId}::uuid AND e.game_code = 'lol' AND e.format = 'tournament'
  `;
  return {
    buckets: PLACEMENT_BUCKETS.map(b => ({ key: b.key, label: b.label,
      count: rows.filter(r => b.key === "champion" ? isTitle(r) : b.key === "runnerup" ? isRunnerUp(r)
        : r.placement_rank != null && b.match(r.placement_rank)).length,
    })),
    unknown: rows.filter(r => placementBucket(r.placement_rank) === null).length,
    total: rows.length,
  };
}

// ── 홈 ───────────────────────────────────────────────────────────────

/**
 * 롤 홈 숫자. 경기 = 공개 내전 본게임 세트 수, 조우 = 같은 판에 함께 있던 공개 스트리머 쌍(같은 팀·상대편)의 세트 수.
 * ★ 공개 집계와 같은 고르기(lol_versus_set·versus_pair_set)다 — 지운 공개 큐 판·보너스 판은 세지 않는다.
 */
export async function countPublic(): Promise<{ streamers: number; matches: number; encounters: number }> {
  const sql = db();
  const rows = await sql<{ streamers: number; matches: number; encounters: number }[]>`
    SELECT (SELECT count(*)::int FROM core_public.streamer) AS streamers,
           (SELECT count(DISTINCT match_id)::int FROM core_public.lol_versus_set) AS matches,
           -- 쌍 수는 판마다 n(n-1)/2 — 짝을 하나하나 만들 필요가 없다. 상대전적 뷰(versus_pair_set)는 사람 기준으로 판 번호를
           -- 따라가게 만들어져 있어 전체를 훑으면 느리다(운영 복사본 0.9초 → 이 계산은 공개 세트 한 번 훑기).
           (SELECT coalesce(sum(n * (n - 1) / 2), 0)::int
              FROM (SELECT count(*) AS n FROM core_public.lol_versus_set GROUP BY match_id) per_match) AS encounters
  `;
  return rows[0];
}
