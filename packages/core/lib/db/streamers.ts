/**
 * 스트리머·계정 매핑 질의.
 *
 * 관리자 화면이 쓰는 것이 대부분이다. 공개 화면 질의(프로필·상대전적)는
 * 데이터가 쌓이기 시작하면 별도 모듈로 나눈다.
 */

import { db } from "./client.ts";
import type {
  AccountEvidence,
  CareerEventRow,
  Confidence,
  Platform,
  StreamerAccountView,
  StreamerChannelRow,
  StreamerRow,
  Visibility,
} from "./types.ts";

// ── 스트리머 ─────────────────────────────────────────────────────────

export interface StreamerListItem extends StreamerRow {
  account_count: number;
  verified_count: number;
  match_count: number;
  /** 대표 채널 (없을 수 있다 — 채널은 1:N 이고 필수가 아니다) */
  platform: Platform | null;
  channel_id: string | null;
  channel_url: string | null;
  channel_count: number;
}

export async function listStreamers(opts: { q?: string; limit?: number } = {}): Promise<StreamerListItem[]> {
  const sql = db();
  const q = opts.q?.trim();
  const limit = opts.limit ?? 200;
  return sql<StreamerListItem[]>`
    SELECT s.*,
           count(sa.puuid)::int                                      AS account_count,
           count(sa.puuid) FILTER (WHERE sa.confidence = 'verified')::int AS verified_count,
           coalesce(m.match_count, 0)::int                           AS match_count,
           ch.platform, ch.channel_id, ch.channel_url,
           coalesce(cc.n, 0)::int                                    AS channel_count
      FROM streamer s
      LEFT JOIN streamer_account sa ON sa.streamer_id = s.id
      LEFT JOIN LATERAL (
             SELECT count(*) AS match_count
               FROM match_participant mp
              WHERE mp.puuid IN (SELECT puuid FROM streamer_account WHERE streamer_id = s.id)
           ) m ON true
      LEFT JOIN LATERAL (
             SELECT platform, channel_id, channel_url
               FROM streamer_channel
              WHERE streamer_id = s.id AND active_to IS NULL
              ORDER BY is_primary DESC, created_at
              LIMIT 1
           ) ch ON true
      LEFT JOIN LATERAL (
             SELECT count(*) AS n FROM streamer_channel
              WHERE streamer_id = s.id AND active_to IS NULL
           ) cc ON true
     WHERE ${q
       ? sql`(s.display_name ILIKE ${"%" + q + "%"}
              OR s.slug ILIKE ${"%" + q + "%"}
              OR EXISTS (SELECT 1 FROM streamer_channel c
                          WHERE c.streamer_id = s.id AND c.channel_id ILIKE ${"%" + q + "%"})
              OR EXISTS (SELECT 1 FROM unnest(s.aliases) a WHERE a ILIKE ${"%" + q + "%"}))`
       : sql`true`}
     GROUP BY s.id, m.match_count, ch.platform, ch.channel_id, ch.channel_url, cc.n
     ORDER BY s.display_name
     LIMIT ${limit}
  `;
}

export async function getStreamer(idOrSlug: string): Promise<StreamerRow | null> {
  const sql = db();
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const rows = await sql<StreamerRow[]>`
    SELECT * FROM streamer
     WHERE ${isUuid ? sql`id = ${idOrSlug}::uuid` : sql`slug = ${idOrSlug}`}
     LIMIT 1
  `;
  return rows[0] ?? null;
}

export interface CreateStreamerInput {
  slug: string;
  display_name: string;
  aliases?: string[];
  is_pro?: boolean;
  team_name?: string | null;
  note?: string | null;
  /** 편의용. 채널은 1:N 이라 나중에 addChannel 로 더 붙일 수 있다. */
  channel?: { platform?: Platform; channel_id: string; channel_url?: string | null; label?: string | null };
}

export async function createStreamer(input: CreateStreamerInput): Promise<StreamerRow> {
  const sql = db();
  return sql.begin(async (tx) => {
    const rows = await tx<StreamerRow[]>`
      INSERT INTO streamer ${tx({
        slug: input.slug,
        display_name: input.display_name,
        aliases: input.aliases ?? [],
        is_pro: input.is_pro ?? false,
        team_name: input.team_name ?? null,
        note: input.note ?? null,
      })}
      RETURNING *
    `;
    if (input.channel?.channel_id) {
      await tx`
        INSERT INTO streamer_channel (streamer_id, platform, channel_id, channel_url, label, is_primary)
        VALUES (${rows[0].id}::uuid, ${input.channel.platform ?? "soop"}, ${input.channel.channel_id},
                ${input.channel.channel_url ?? null}, ${input.channel.label ?? "본채널"}, true)
      `;
    }
    return rows[0];
  }) as Promise<StreamerRow>;
}

export type UpdateStreamerPatch = Partial<
  Pick<
    StreamerRow,
    | "slug" | "display_name" | "aliases" | "profile_image_url" | "is_pro"
    | "team_name" | "visibility" | "status" | "note"
  >
>;

export async function updateStreamer(id: string, patch: UpdateStreamerPatch): Promise<StreamerRow | null> {
  const keys = Object.keys(patch);
  if (keys.length === 0) return getStreamer(id);
  const sql = db();
  // ★ RETURNING 으로 실제 갱신 여부를 확인한다. "무조건 성공"을 돌려주지 않는다.
  const rows = await sql<StreamerRow[]>`
    UPDATE streamer SET ${sql(patch as Record<string, unknown>, ...keys)}
     WHERE id = ${id}::uuid
    RETURNING *
  `;
  return rows[0] ?? null;
}

// ── 방송 채널 (1:N) ──────────────────────────────────────────────────

export async function listStreamerChannels(streamerId: string): Promise<StreamerChannelRow[]> {
  const sql = db();
  return sql<StreamerChannelRow[]>`
    SELECT * FROM streamer_channel
     WHERE streamer_id = ${streamerId}::uuid
     ORDER BY active_to NULLS FIRST, is_primary DESC, created_at
  `;
}

/** 플랫폼 기본 채널 URL. 플랫폼이 늘면 여기만 고친다. */
export function channelUrlFor(platform: Platform, channelId: string): string | null {
  switch (platform) {
    case "soop": return `https://ch.sooplive.co.kr/${channelId}`;
    case "chzzk": return `https://chzzk.naver.com/${channelId}`;
    case "youtube": return `https://youtube.com/@${channelId}`;
    case "twitch": return `https://twitch.tv/${channelId}`;
    default: return null;
  }
}

export interface UpsertChannelInput {
  streamer_id: string;
  platform?: Platform;
  channel_id: string;
  channel_url?: string | null;
  label?: string | null;
  is_primary?: boolean;
}

/**
 * 채널을 붙이거나 갱신한다. is_primary 는 스트리머당 하나로 강제한다.
 *
 * ★ 이미 **다른 스트리머**에게 붙어 있는 채널이면 거부한다.
 *   ON CONFLICT 로 streamer_id 를 덮어쓰면 채널을 조용히 뺏어오게 되는데,
 *   그건 계정 매핑에서 한 계정이 두 주인을 못 갖게 막은 것과 같은 이유로 사고다.
 *   정말 양도라면 먼저 removeStreamerChannel(close=true) 로 이력을 닫아야 한다.
 */
export async function upsertStreamerChannel(input: UpsertChannelInput): Promise<void> {
  const platform = input.platform ?? "soop";
  const sql = db();
  await sql.begin(async (tx) => {
    const owner = await tx<{ streamer_id: string }[]>`
      SELECT streamer_id FROM streamer_channel
       WHERE platform = ${platform} AND channel_id = ${input.channel_id} AND active_to IS NULL
       LIMIT 1
    `;
    if (owner.length > 0 && owner[0].streamer_id !== input.streamer_id) {
      throw new Error(
        `채널 ${platform}/${input.channel_id} 은 이미 다른 스트리머에게 붙어 있다. ` +
          `옮기려면 먼저 떼어낼 것 (removeStreamerChannel).`,
      );
    }
    if (input.is_primary) {
      await tx`
        UPDATE streamer_channel SET is_primary = false
         WHERE streamer_id = ${input.streamer_id}::uuid AND active_to IS NULL
      `;
    }
    await tx`
      INSERT INTO streamer_channel (streamer_id, platform, channel_id, channel_url, label, is_primary)
      VALUES (${input.streamer_id}::uuid, ${platform}, ${input.channel_id},
              ${input.channel_url ?? channelUrlFor(platform, input.channel_id)},
              ${input.label ?? null}, ${input.is_primary ?? false})
      ON CONFLICT (platform, channel_id) WHERE active_to IS NULL DO UPDATE SET
        channel_url = EXCLUDED.channel_url,
        label       = coalesce(EXCLUDED.label, streamer_channel.label),
        is_primary  = EXCLUDED.is_primary,
        updated_at  = now()
    `;
  });
}

/** 채널을 떼어낸다. 이력을 남기려면 close=true (active_to 를 찍는다). */
export async function removeStreamerChannel(id: string, close = false): Promise<boolean> {
  const sql = db();
  const rows = close
    ? await sql`UPDATE streamer_channel SET active_to = now() WHERE id = ${id}::uuid AND active_to IS NULL RETURNING id`
    : await sql`DELETE FROM streamer_channel WHERE id = ${id}::uuid RETURNING id`;
  return rows.length > 0;
}

// ── 계정 매핑 ────────────────────────────────────────────────────────

export async function listStreamerAccounts(streamerId: string): Promise<StreamerAccountView[]> {
  const sql = db();
  return sql<StreamerAccountView[]>`
    SELECT sa.*,
           ra.game_name, ra.tag_line, ra.summoner_level,
           ra.profile_icon_id, ra.last_match_synced_at,
           r.tier, r.division, r.league_points, r.lp_absolute
      FROM streamer_account sa
      JOIN riot_account ra ON ra.puuid = sa.puuid
      LEFT JOIN LATERAL (
             SELECT tier, division, league_points, lp_absolute
               FROM rank_snapshot
              WHERE puuid = sa.puuid AND queue_type = 'RANKED_SOLO_5x5'
              ORDER BY snapshot_date DESC
              LIMIT 1
           ) r ON true
     WHERE sa.streamer_id = ${streamerId}::uuid
     ORDER BY sa.is_main DESC, ra.game_name NULLS LAST
  `;
}

/** Riot 계정을 등록/갱신한다. puuid 가 이미 있으면 표시 정보만 최신화. */
export async function upsertRiotAccount(input: {
  puuid: string;
  game_name?: string | null;
  tag_line?: string | null;
  summoner_id?: string | null;
  summoner_level?: number | null;
  profile_icon_id?: number | null;
}): Promise<void> {
  const sql = db();
  await sql`
    INSERT INTO riot_account (puuid, game_name, tag_line, summoner_id, summoner_level, profile_icon_id)
    VALUES (${input.puuid}, ${input.game_name ?? null}, ${input.tag_line ?? null},
            ${input.summoner_id ?? null}, ${input.summoner_level ?? null}, ${input.profile_icon_id ?? null})
    ON CONFLICT (puuid) DO UPDATE SET
      game_name       = coalesce(EXCLUDED.game_name, riot_account.game_name),
      tag_line        = coalesce(EXCLUDED.tag_line, riot_account.tag_line),
      summoner_id     = coalesce(EXCLUDED.summoner_id, riot_account.summoner_id),
      summoner_level  = coalesce(EXCLUDED.summoner_level, riot_account.summoner_level),
      profile_icon_id = coalesce(EXCLUDED.profile_icon_id, riot_account.profile_icon_id),
      updated_at      = now()
  `;
}

export interface LinkAccountInput {
  streamer_id: string;
  puuid: string;
  label?: string | null;
  is_main?: boolean;
  evidence: AccountEvidence;
  confidence: Confidence;
}

/**
 * 스트리머에 계정을 붙인다.
 *
 * ★ 근거(evidence)가 비어 있으면 거부한다. 스키마가 아니라 여기서 막는 이유는
 *   "근거 없이 붙일 수 있는 경로를 코드에 아예 두지 않기" 위해서다.
 *   관리자 UI 가 실수로 빈 값을 보내도 여기서 걸린다.
 */
export async function linkAccount(input: LinkAccountInput): Promise<void> {
  const hasEvidence = Boolean(input.evidence?.url || input.evidence?.note);
  if (!hasEvidence) {
    throw new Error("계정 매핑에는 근거(URL 또는 메모)가 필요하다. docs/PLAN.md §11-2");
  }
  const sql = db();
  await sql.begin(async (tx) => {
    if (input.is_main) {
      await tx`UPDATE streamer_account SET is_main = false WHERE streamer_id = ${input.streamer_id}::uuid`;
    }
    await tx`
      INSERT INTO streamer_account (streamer_id, puuid, label, is_main, evidence, confidence)
      VALUES (${input.streamer_id}::uuid, ${input.puuid}, ${input.label ?? null},
              ${input.is_main ?? false}, ${tx.json(input.evidence as never)}, ${input.confidence})
      ON CONFLICT (streamer_id, puuid) DO UPDATE SET
        label      = EXCLUDED.label,
        is_main    = EXCLUDED.is_main,
        evidence   = EXCLUDED.evidence,
        confidence = EXCLUDED.confidence,
        updated_at = now()
    `;
    // 백필 대상으로 큐에 올린다. 이미 있으면 건드리지 않는다.
    await tx`
      INSERT INTO ingest_cursor (puuid) VALUES (${input.puuid})
      ON CONFLICT (puuid) DO NOTHING
    `;
  });
}

export async function setMainAccount(streamerId: string, puuid: string): Promise<void> {
  const sql = db();
  await sql.begin(async (tx) => {
    await tx`UPDATE streamer_account SET is_main = false WHERE streamer_id = ${streamerId}::uuid`;
    await tx`UPDATE streamer_account SET is_main = true
              WHERE streamer_id = ${streamerId}::uuid AND puuid = ${puuid}`;
  });
}

export async function setAccountVisibility(
  streamerId: string,
  puuid: string,
  visibility: Visibility,
): Promise<boolean> {
  const sql = db();
  const rows = await sql`
    UPDATE streamer_account SET visibility = ${visibility}, updated_at = now()
     WHERE streamer_id = ${streamerId}::uuid AND puuid = ${puuid}
    RETURNING puuid
  `;
  return rows.length > 0;
}

export async function unlinkAccount(streamerId: string, puuid: string): Promise<boolean> {
  const sql = db();
  const rows = await sql`
    DELETE FROM streamer_account
     WHERE streamer_id = ${streamerId}::uuid AND puuid = ${puuid}
    RETURNING puuid
  `;
  return rows.length > 0;
}

// ── 커리어 (수기) ────────────────────────────────────────────────────

export async function listCareerEvents(streamerId: string): Promise<CareerEventRow[]> {
  const sql = db();
  return sql<CareerEventRow[]>`
    SELECT * FROM career_event
     WHERE streamer_id = ${streamerId}::uuid
     ORDER BY date_from DESC NULLS LAST, title
  `;
}

export async function addCareerEvent(input: {
  streamer_id: string;
  title: string;
  role?: string | null;
  team_name?: string | null;
  placement?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  source_url?: string | null;
}): Promise<CareerEventRow> {
  const sql = db();
  const rows = await sql<CareerEventRow[]>`
    INSERT INTO career_event ${sql({
      streamer_id: input.streamer_id,
      title: input.title,
      role: input.role ?? null,
      team_name: input.team_name ?? null,
      placement: input.placement ?? null,
      date_from: input.date_from || null,
      date_to: input.date_to || null,
      source_url: input.source_url ?? null,
    })}
    RETURNING *
  `;
  return rows[0];
}

export async function deleteCareerEvent(id: string): Promise<boolean> {
  const sql = db();
  const rows = await sql`DELETE FROM career_event WHERE id = ${id}::uuid RETURNING id`;
  return rows.length > 0;
}

// ── 대시보드 ─────────────────────────────────────────────────────────

export interface AdminCounts {
  streamers: number;
  accounts: number;
  verified_accounts: number;
  matches: number;
  encounters: number;
  rank_snapshots: number;
  pending_candidates: number;
  backfill_pending: number;
}

export async function adminCounts(): Promise<AdminCounts> {
  const sql = db();
  const rows = await sql<AdminCounts[]>`
    SELECT (SELECT count(*) FROM streamer)::int                                          AS streamers,
           (SELECT count(*) FROM streamer_account)::int                                  AS accounts,
           (SELECT count(*) FROM streamer_account WHERE confidence = 'verified')::int    AS verified_accounts,
           (SELECT count(*) FROM match)::int                                             AS matches,
           (SELECT count(*) FROM streamer_encounter)::int                                AS encounters,
           (SELECT count(*) FROM rank_snapshot)::int                                     AS rank_snapshots,
           (SELECT count(*) FROM account_candidate WHERE state = 'pending')::int         AS pending_candidates,
           (SELECT count(*) FROM ingest_cursor WHERE backfill_state <> 'done')::int      AS backfill_pending
  `;
  return rows[0];
}
