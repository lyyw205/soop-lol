/**
 * 수집 파이프라인의 DB 면(面).
 *
 * 워커(apps/worker)는 Riot 호출과 스케줄만 하고, **행을 만드는 규칙은 전부 여기**에 있다.
 *
 * 롤 Riot 수집은 두 갈래뿐이다(docs/CLASSIFICATION-REDESIGN-PLAN.md §4, 사용자 결정 12):
 *   · **랭크 점수** — 연결된 활성 계정 전원, 매일(rank_snapshot·닉네임 갱신)
 *   · **지명 수집** — collection_target(계정·큐·기간)에 사람이 등록한 것만. 그 판은 개인 기록(scope='personal')이다.
 * ★ 목록 밖 공개 큐 판을 저장하는 경로는 **없다.** saveMatch 가 저장 직전에 지명을 다시 확인하고, 지명이 없으면
 *   아무것도 쓰지 않는다 — 엔진이 범위를 잘못 물어도(혹은 Riot 이 범위 밖 판을 섞어 줘도) 저장 단계에서 막힌다.
 *   옛 구조는 "연결된 계정 전원"을 긁어 하루 2.7만 판·참가자 27만 행(89% 일반인)을 쌓았고 운영 DB 가 읽기 전용이 됐다.
 * ★ 토너먼트 코드 판은 지명과 무관하게 내전 세트(scope='versus')로, KST 날짜별 자동 미분류 묶음에 한 판짜리 시리즈로 둔다
 *   (계획 §3.4 — 분류는 사람이 시리즈를 실제 행사로 옮겨서 한다).
 * ★ 파생 표(조우·챔피언 통계)는 없다(계획 §10 결정 5). 공개 뷰가 원본에서 질의 시점에 계산하므로, 계정 연결·공개 여부·
 *   분류를 바꿔도 여기서 다시 만들 것이 없다.
 */

import type postgres from "postgres";

import { ensureAutoBucketInTx, lolCodeBucketSlug, placeSingleSetInTx } from "./classification.ts";
import { db } from "./client.ts";
import {
  isTournamentCodeGame,
  toDetailRows,
  toMatchRow,
  toParticipantRows,
  type DetailRow,
  type ParticipantRow,
} from "../ingest/transform.ts";
import type { LeagueEntryDto, MatchDto } from "../riot/types.ts";
import { kstDateString } from "../time.ts";

type Tx = postgres.TransactionSql;

// ── Engine A — 랭크 점수 대상(연결 계정 전원) ─────────────────────────

export interface RankTarget {
  puuid: string;
  streamer_id: string;
  display_name: string;
  game_name: string | null;
  tag_line: string | null;
  summoner_id: string | null;
  last_rank_synced_at: Date | null;
  last_profile_synced_at: Date | null;
}

/**
 * 랭크 점수 대상. **스트리머에게 붙어 있고 현재 유효한** 계정 전원이다 — 경기 기록 수집 대상(collection_target)과 별개다.
 * `active_to IS NULL` 조건이 빠지면 양도된 옛 계정까지 계속 조회한다.
 *
 * 유효 계정은 스트리머 하나에만 붙는다(`streamer_account_one_owner_idx`)므로 이 조인은 계정당 한 행이다.
 */
export async function listRankTargets(): Promise<RankTarget[]> {
  const sql = db();
  return sql<RankTarget[]>`
    SELECT ra.puuid, sa.streamer_id, s.display_name,
           ra.game_name, ra.tag_line, ra.summoner_id,
           ra.last_rank_synced_at, ra.last_profile_synced_at
      FROM riot_account ra
      JOIN streamer_account sa ON sa.puuid = ra.puuid AND sa.active_to IS NULL
      JOIN streamer s          ON s.id = sa.streamer_id
     WHERE ra.is_active
     ORDER BY ra.last_rank_synced_at NULLS FIRST, ra.puuid
  `;
}

/**
 * 하루치 랭크를 기록한다.
 *
 * ★ 언랭도 **기록한다**. 행이 없으면 "언랭이었다"와 "그날 잡이 안 돌았다"를
 *   구분할 수 없다. 티어 추이에 구멍이 났을 때 원인을 찾을 수 없게 된다.
 *   (`lp_absolute` 는 tier 가 NULL 이면 생성 컬럼이 알아서 NULL 을 낸다)
 */
export async function saveRankSnapshot(
  puuid: string,
  snapshotDate: string,
  entries: LeagueEntryDto[],
): Promise<number> {
  const sql = db();
  const byQueue = new Map<string, LeagueEntryDto>();
  for (const e of entries) {
    if (e?.queueType) byQueue.set(e.queueType, e);
  }
  // 솔랭은 언랭이어도 자리를 만든다.
  if (!byQueue.has("RANKED_SOLO_5x5")) {
    byQueue.set("RANKED_SOLO_5x5", {
      queueType: "RANKED_SOLO_5x5", leaguePoints: 0, wins: 0, losses: 0,
    } as LeagueEntryDto);
  }

  await sql.begin(async (tx) => {
    for (const [queueType, e] of byQueue) {
      const unranked = !e.tier;
      await tx`
        INSERT INTO rank_snapshot
          (puuid, queue_type, snapshot_date, tier, division, league_points, wins, losses, hot_streak)
        VALUES (${puuid}, ${queueType}, ${snapshotDate},
                ${e.tier ?? null}, ${e.rank ?? null},
                ${unranked ? null : e.leaguePoints ?? 0},
                ${unranked ? null : e.wins ?? 0},
                ${unranked ? null : e.losses ?? 0},
                ${e.hotStreak ?? null})
        ON CONFLICT (puuid, queue_type, snapshot_date) DO UPDATE SET
          tier          = EXCLUDED.tier,
          division      = EXCLUDED.division,
          league_points = EXCLUDED.league_points,
          wins          = EXCLUDED.wins,
          losses        = EXCLUDED.losses,
          hot_streak    = EXCLUDED.hot_streak,
          captured_at   = now()
      `;
    }
    await tx`UPDATE riot_account SET last_rank_synced_at = now() WHERE puuid = ${puuid}`;
  });
  return byQueue.size;
}

/** 닉네임·레벨 갱신. Riot ID 는 바뀌므로 표시용 캐시를 하루 1회 새로 받는다. */
export async function saveProfile(input: {
  puuid: string;
  game_name?: string | null;
  tag_line?: string | null;
  summoner_id?: string | null;
  summoner_level?: number | null;
  profile_icon_id?: number | null;
  revision_date?: Date | null;
}): Promise<void> {
  const sql = db();
  await sql`
    UPDATE riot_account SET
      game_name              = coalesce(${input.game_name ?? null}, game_name),
      tag_line               = coalesce(${input.tag_line ?? null}, tag_line),
      summoner_id            = coalesce(${input.summoner_id ?? null}, summoner_id),
      summoner_level         = coalesce(${input.summoner_level ?? null}, summoner_level),
      profile_icon_id        = coalesce(${input.profile_icon_id ?? null}, profile_icon_id),
      revision_date          = coalesce(${input.revision_date ?? null}, revision_date),
      last_profile_synced_at = now()
     WHERE puuid = ${input.puuid}
  `;
}

// ── 지명 수집 대상(collection_target) ────────────────────────────────

export interface CollectionTarget {
  id: string;
  puuid: string;
  queue_id: number;
  starts_at: Date;
  ends_at: Date | null;
  purpose: string;
  /** 백필 커서 — 이 시각 **이전**을 아직 덜 봤다. null 이면 아직 시작 전(위쪽 끝부터). */
  cursor_before: Date | null;
  reached_end: boolean;
  state: "pending" | "running" | "done" | "error";
  /** 이 계정의 지금 주인. 지명은 계정 단위라 스트리머에 안 붙은 계정일 수도 있다(null). */
  streamer_id: string | null;
  /** 로그용 이름. */
  label: string;
}

const TARGET_COLUMNS = (sql: postgres.Sql) => sql`
  t.id, t.puuid, t.queue_id, t.starts_at, t.ends_at, t.purpose, t.cursor_before, t.reached_end, t.state,
  (SELECT sa.streamer_id FROM streamer_account sa WHERE sa.puuid = t.puuid AND sa.active_to IS NULL LIMIT 1) AS streamer_id,
  coalesce((SELECT s.display_name FROM streamer_account sa JOIN streamer s ON s.id = sa.streamer_id
             WHERE sa.puuid = t.puuid AND sa.active_to IS NULL LIMIT 1),
           (SELECT ra.game_name FROM riot_account ra WHERE ra.puuid = t.puuid),
           left(t.puuid, 8)) AS label`;

export interface CollectionTargetInput {
  puuid: string;
  queue_id: number;
  starts_at: Date;
  ends_at?: Date | null;
  /** 왜 모으나(예: `solo_challenge:ttgyo-duo`). 비울 수 없다 — 이유 없는 수집을 만들지 않는다. */
  purpose: string;
  note?: string | null;
}

/**
 * 지명을 등록한다 — 롤 경기 기록 수집 대상이 생기는 **유일한 길**이다(계정 연결은 대상을 만들지 않는다).
 * 같은 (계정, 큐, 시작) 은 하나다 — 다시 부르면 끝·목적·메모를 고친다.
 * ★ 끝이 바뀌면 백필을 처음부터 다시 돈다 — 늘어난 구간을 아무도 안 보게 되는 것을 막는다. 이미 가진 판은
 *   API 를 쓰지 않고 지나가므로(matchCoverage) 다시 도는 비용은 목록 조회뿐이다.
 */
export async function addCollectionTarget(input: CollectionTargetInput): Promise<string> {
  if (!input.purpose.trim()) throw new Error("지명 수집에는 목적(purpose)이 필요하다.");
  if (!Number.isInteger(input.queue_id) || input.queue_id < 0) throw new Error(`큐 번호가 올바르지 않다: ${input.queue_id}`);
  if (input.ends_at && input.ends_at <= input.starts_at) throw new Error("지명 기간의 끝은 시작보다 늦어야 한다.");
  const sql = db();
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO collection_target (puuid, queue_id, starts_at, ends_at, purpose, note)
    VALUES (${input.puuid}, ${input.queue_id}, ${input.starts_at}, ${input.ends_at ?? null}, ${input.purpose.trim()}, ${input.note ?? null})
    ON CONFLICT (puuid, queue_id, starts_at) DO UPDATE SET
      cursor_before = CASE WHEN EXCLUDED.ends_at IS DISTINCT FROM collection_target.ends_at THEN NULL ELSE collection_target.cursor_before END,
      reached_end   = CASE WHEN EXCLUDED.ends_at IS DISTINCT FROM collection_target.ends_at THEN false ELSE collection_target.reached_end END,
      state         = CASE WHEN EXCLUDED.ends_at IS DISTINCT FROM collection_target.ends_at THEN 'pending' ELSE collection_target.state END,
      ends_at = EXCLUDED.ends_at, purpose = EXCLUDED.purpose, note = EXCLUDED.note, updated_at = now()
    RETURNING id
  `;
  return row.id;
}

/**
 * 실시간(B)이 따라잡을 지명 — 기간이 시작됐고, 아직 열려 있거나 최근(`lookbackMs` 안)에 끝난 것.
 * 끝난 지 오래된 지명은 백필(C)만 맡는다.
 */
export async function listLiveTargets(now: Date, lookbackMs: number): Promise<CollectionTarget[]> {
  const sql = db();
  const since = new Date(now.getTime() - lookbackMs);
  return sql<CollectionTarget[]>`
    SELECT ${TARGET_COLUMNS(sql)}
      FROM collection_target t
     WHERE t.game_code = 'lol'
       AND t.starts_at <= ${now}
       AND (t.ends_at IS NULL OR t.ends_at > ${since})
       AND EXISTS (SELECT 1 FROM riot_account ra WHERE ra.puuid = t.puuid AND ra.is_active)
     ORDER BY t.puuid, t.queue_id, t.starts_at
  `;
}

/**
 * 이 지명으로 이미 가진 가장 최근 판의 시각 — 실시간 따라잡기의 시작점.
 * ★ 저장된 원본에서 구한다(따로 커서 칸을 두지 않는다). 옛 `last_match_synced_at` 도 "가장 최근에 넣은 판의 시각"이었고,
 *   오래된 것부터 넣다가 실패하면 거기서 멈추므로 같은 뜻이 된다. 지명이 여럿인 계정도 지명마다 따로 맞다.
 */
export async function newestCoveredAt(t: Pick<CollectionTarget, "puuid" | "queue_id" | "starts_at" | "ends_at">): Promise<Date | null> {
  const sql = db();
  const [row] = await sql<{ at: Date | null }[]>`
    SELECT max(m.game_creation) AS at
      FROM match_participant p
      JOIN match m ON m.match_id = p.match_id
     WHERE p.puuid = ${t.puuid} AND m.game_code = 'lol' AND m.queue_id = ${t.queue_id}
       AND m.game_creation >= ${t.starts_at}
       AND (${t.ends_at}::timestamptz IS NULL OR m.game_creation < ${t.ends_at})
  `;
  return row?.at ?? null;
}

/**
 * 백필 대상 지명 하나를 집는다.
 * `FOR UPDATE SKIP LOCKED` — 워커를 두 개 띄워도 같은 지명을 겹쳐 긁지 않는다.
 *
 * ★ 실패(error)한 지명은 `retryAfterMs` 가 지나야 다시 집는다. 옛 ingest_cursor 는 실패 횟수로 영구 제외했는데, 일시적인 5xx
 *   몇 번에 시한부 백필이 영영 빠지는 것보다 늦게라도 다시 시도하는 편이 낫다 — 오래된 순으로 돌아가므로 다른 지명을 굶기지 않는다.
 */
export async function claimBackfillTarget(retryAfterMs = 60 * 60 * 1000, now = new Date()): Promise<CollectionTarget | null> {
  const sql = db();
  const retryBefore = new Date(now.getTime() - retryAfterMs);
  const [claimed] = await sql<{ id: string }[]>`
    UPDATE collection_target SET state = 'running', updated_at = now()
     WHERE id = (
       SELECT t.id FROM collection_target t
        WHERE t.game_code = 'lol'
          AND t.state <> 'done' AND NOT t.reached_end
          AND (t.state <> 'error' OR t.updated_at < ${retryBefore})
          AND t.starts_at < ${now}
          AND EXISTS (SELECT 1 FROM riot_account ra WHERE ra.puuid = t.puuid AND ra.is_active)
        ORDER BY t.updated_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id
  `;
  if (!claimed) return null;
  const [row] = await sql<CollectionTarget[]>`SELECT ${TARGET_COLUMNS(sql)} FROM collection_target t WHERE t.id = ${claimed.id}::uuid`;
  return row ?? null;
}

/** 백필 한 조각의 결과를 기록한다. 커서는 아래로만 간다(coalesce — 안 주면 그대로). */
export async function saveBackfillProgress(patch: {
  id: string;
  before?: Date | null;
  state: "pending" | "running" | "done" | "error";
  reachedEnd?: boolean;
  error?: string | null;
}): Promise<void> {
  const sql = db();
  const failed = patch.state === "error";
  await sql`
    UPDATE collection_target SET
      cursor_before = coalesce(${patch.before ?? null}, cursor_before),
      state         = ${patch.state},
      reached_end   = ${patch.reachedEnd ?? false} OR reached_end,
      last_error    = ${failed ? patch.error ?? "unknown" : null},
      updated_at    = now()
     WHERE id = ${patch.id}::uuid
  `;
}

// ── 매치 적재 ────────────────────────────────────────────────────────

/** 아직 안 가진 매치 ID 만 남긴다. 이미 죽은(404) 매치도 걸러낸다. */
export async function filterUnknownMatchIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const sql = db();
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM unnest(${ids}::text[]) AS id
     WHERE NOT EXISTS (SELECT 1 FROM match      m WHERE m.match_id = id)
       AND NOT EXISTS (SELECT 1 FROM dead_match d WHERE d.match_id = id)
  `;
  const keep = new Set(rows.map((r) => r.id));
  return ids.filter((id) => keep.has(id)); // 원래 순서(최신순)를 지킨다
}

/**
 * 이미 가진 매치가 이 계정(지명) 기준으로 **다 갖춰졌나**. 백필 커서를 API 호출 없이 내리기 위한 것이다.
 *
 * ★ 개인 기록 판인데 이 계정의 상세가 없으면 `needs_detail` — 다른 지명(듀오 상대 등)으로 먼저 들어온 판이다.
 *   그 판은 다시 받아 이 계정의 상세를 채워야 "지명한 사람은 상세가 있다"가 지켜진다(일반인 상세는 받는 순간 버려서 남아 있지 않다).
 */
export async function matchCoverage(ids: string[], puuid: string): Promise<Map<string, { at: Date; needs_detail: boolean }>> {
  if (ids.length === 0) return new Map();
  const sql = db();
  const rows = await sql<{ match_id: string; game_creation: Date; needs_detail: boolean }[]>`
    SELECT m.match_id, m.game_creation,
           (m.scope = 'personal' AND NOT EXISTS (
              SELECT 1 FROM match_participant p
                JOIN lol_participant_detail d ON d.match_id = p.match_id AND d.participant_id = p.participant_id
               WHERE p.match_id = m.match_id AND p.puuid = ${puuid})) AS needs_detail
      FROM match m WHERE m.match_id = ANY(${ids}::text[])
  `;
  return new Map(rows.map((r) => [r.match_id, { at: r.game_creation, needs_detail: r.needs_detail }]));
}

export interface SaveMatchResult {
  /** out_of_scope = 지명 범위 밖의 공개 큐 판이라 **아무것도 쓰지 않았다**. */
  state: "saved" | "duplicate" | "out_of_scope";
  scope: "personal" | "versus" | null;
  game_creation: Date;
  /** 이번에 새로 넣은 상세 행 수(지명 계정만). */
  details: number;
  /** 이 경기에서 새로 쌓인 미매핑 참가자 수(토너먼트 코드 판만). */
  candidates: number;
}

/**
 * Riot 판 하나를 적재한다. **한 트랜잭션**이다 — 판만 들어가고 참가자가 빠진 상태가 남지 않는다.
 *
 *   · 토너먼트 코드 판 → 내전 세트. KST 날짜별 자동 미분류 묶음에 한 판짜리 시리즈(placeSingleSetInTx, actor auto).
 *   · 그 밖의 판 → 지명(collection_target: 참가 계정·큐·기간)이 있을 때만 개인 기록. 없으면 저장하지 않는다.
 *   · 참가자 10명은 기본 칸만, 상세는 그 판을 지명한 계정의 행만(lol_participant_detail).
 *
 * 이미 있는 판은 다시 쓰지 않는다 — 자리(시리즈·행사)는 사람이 옮겼을 수 있고, 자동 경로가 되돌리면 안 된다.
 * 빠진 지명 계정 상세만 채운다(나중에 등록된 지명).
 */
export async function saveMatch(dto: MatchDto): Promise<SaveMatchResult> {
  const sql = db();
  const matchRow = toMatchRow(dto);
  const participantRows = toParticipantRows(dto);
  const code = isTournamentCodeGame(dto.info);

  return sql.begin(async (tx) => {
    // 지명 확인 — 공개 큐 판이 저장되는 **유일한** 근거다.
    const puuids = participantRows.map((p) => p.puuid).filter((x): x is string => Boolean(x));
    const targeted = new Set((await tx<{ puuid: string }[]>`
      SELECT DISTINCT puuid FROM collection_target
       WHERE game_code = 'lol' AND puuid = ANY(${puuids}::text[]) AND queue_id = ${matchRow.queue_id}
         AND starts_at <= ${matchRow.game_creation}
         AND (ends_at IS NULL OR ${matchRow.game_creation} < ends_at)`).map((r) => r.puuid));
    if (!code && targeted.size === 0) {
      return { state: "out_of_scope", scope: null, game_creation: matchRow.game_creation, details: 0, candidates: 0 };
    }
    const scope = code ? "versus" : "personal";
    // ★ 내전 세트도 일단 personal 로 넣고 같은 트랜잭션에서 placeSingleSetInTx 가 시리즈에 둔다(scope → versus).
    //   판을 시리즈에 두는 쓰기는 classification.ts 한 곳만 한다(제외 확인·게임 대조) — 여기서 series_id 를 직접 쓰지 않는다.
    //   CHECK (scope='versus') = (series_id IS NOT NULL) 때문에 시리즈 없이 versus 로 넣을 수도 없다.
    const inserted = await tx<{ match_id: string }[]>`
      INSERT INTO match ${tx({ ...matchRow, scope: "personal" } as unknown as Record<string, unknown>)}
      ON CONFLICT (match_id) DO NOTHING
      RETURNING match_id
    `;
    const fresh = inserted.length > 0;

    if (fresh) {
      for (const p of participantRows) await insertParticipant(tx, p);
      if (code) {
        const day = matchRow.game_creation;
        const eventId = await ensureAutoBucketInTx(tx, {
          game_code: "lol", slug: lolCodeBucketSlug(day), name: `${kstDateString(day)} 토너먼트 코드 경기`, day,
        });
        await placeSingleSetInTx(tx, { match_id: matchRow.match_id, game_code: "lol", event_id: eventId, actor: "auto" });
      }
    }

    // 상세는 개인 기록 판의 지명 계정만. 이미 있던 판이면 빠진 것만 채운다(ON CONFLICT).
    let details = 0;
    if (!code) {
      const [stored] = await tx<{ scope: string }[]>`SELECT scope FROM match WHERE match_id = ${matchRow.match_id}`;
      if (stored?.scope === "personal") {
        for (const d of toDetailRows(dto, targeted)) details += await insertDetail(tx, d);
      }
    }
    // ★ 후보는 **첫 적재 때만** 쌓는다 — 같은 판을 다시 만날 때마다 seen_count 를 올리면 "몇 번 봤나"가 변질된다.
    const candidates = fresh && code ? await recordCandidatesFromMatch(tx, participantRows, riotIdsOf(dto)) : 0;

    return { state: fresh ? "saved" : "duplicate", scope, game_creation: matchRow.game_creation, details, candidates };
  }) as Promise<SaveMatchResult>;
}

/** 기본 칸만. 상세는 insertDetail(지명 계정만). */
async function insertParticipant(tx: Tx, p: ParticipantRow): Promise<void> {
  await tx`
    INSERT INTO match_participant (
      match_id, puuid, streamer_id, participant_id, team_id, side_no,
      team_position, individual_position, champion_id, champion_name, champ_level, outcome,
      kills, deaths, assists
    ) VALUES (
      ${p.match_id}, ${p.puuid}, ${p.streamer_id ?? null}, ${p.participant_id}, ${p.team_id}, ${p.side_no},
      ${p.team_position}, ${p.individual_position}, ${p.champion_id}, ${p.champion_name}, ${p.champ_level}, ${p.outcome},
      ${p.kills}, ${p.deaths}, ${p.assists}
    )
    -- ★ PK 가 (match_id, participant_id) 다(0017). (match_id, puuid) 는 **부분** 유니크 인덱스(WHERE puuid IS NOT NULL)라
    --   ON CONFLICT 이 같은 조건 없이는 추론하지 못한다 — 실제로 42P10 으로 적재가 죽었다.
    ON CONFLICT (match_id, participant_id) DO NOTHING
  `;
}

/**
 * 상세 한 행. 한 행씩 넣는 이유는 `perks`·`challenges` 가 jsonb 라서다 — 벌크 헬퍼 경로에서는 객체가 JSON 으로
 * 직렬화된다는 보장이 없어서 `[object Object]` 가 들어간다. 지명 계정만이라 판당 한두 행이다.
 */
async function insertDetail(tx: Tx, d: DetailRow): Promise<number> {
  const rows = await tx`
    INSERT INTO lol_participant_detail (
      match_id, participant_id, cs, gold_earned, damage_to_champions, vision_score,
      items, summoner1_id, summoner2_id, perks, challenges
    ) VALUES (
      ${d.match_id}, ${d.participant_id}, ${d.cs}, ${d.gold_earned}, ${d.damage_to_champions}, ${d.vision_score},
      ${d.items}, ${d.summoner1_id}, ${d.summoner2_id},
      ${d.perks === null ? null : tx.json(d.perks as never)},
      ${d.challenges == null ? null : tx.json(d.challenges as never)}
    )
    ON CONFLICT (match_id, participant_id) DO NOTHING
    RETURNING match_id
  `;
  return rows.length;
}

/** 404 난 매치. 2년 지나 삭제된 것이므로 **다시 시도하지 않는다**. */
export async function markDeadMatch(matchId: string, reason = "not_found"): Promise<void> {
  const sql = db();
  await sql`
    INSERT INTO dead_match (match_id, reason) VALUES (${matchId}, ${reason})
    ON CONFLICT (match_id) DO NOTHING
  `;
}

/**
 * 이 계정으로 가장 최근에 넣은 판의 시각 — 관리자 화면의 표시용(riot_account.last_match_synced_at).
 * 수집의 커서가 아니다(실시간 시작점은 newestCoveredAt). 뒤로 가지 않게 GREATEST 로만 올린다.
 */
export async function noteAccountMatchSynced(puuid: string, at: Date): Promise<void> {
  const sql = db();
  await sql`
    UPDATE riot_account
       SET last_match_synced_at = GREATEST(coalesce(last_match_synced_at, to_timestamp(0)), ${at})
     WHERE puuid = ${puuid}
  `;
}

// ── 계정 후보 ────────────────────────────────────────────────────────

/**
 * account_candidate 한 건 UPSERT. **후보를 쌓는 두 경로의 단일 출처다** —
 * 스펙테이터(Engine B, recordAccountCandidates)와 토너먼트 코드 판 적재(recordCandidatesFromMatch).
 * 한때 같은 SQL 이 두 곳에 글자 단위로 복붙돼 있었다. 한쪽만 고치면 조용히 어긋난다.
 */
async function upsertCandidate(
  tx: Tx,
  e: { puuid: string; game_name?: string | null; tag_line?: string | null; seen_with: string[] },
): Promise<boolean> {
  const rows = await tx`
    INSERT INTO account_candidate (puuid, game_name, tag_line, seen_with)
    VALUES (${e.puuid}, ${e.game_name ?? null}, ${e.tag_line ?? null}, ${e.seen_with}::uuid[])
    ON CONFLICT (puuid) DO UPDATE SET
      seen_count   = account_candidate.seen_count + 1,
      last_seen_at = now(),
      game_name    = coalesce(EXCLUDED.game_name, account_candidate.game_name),
      tag_line     = coalesce(EXCLUDED.tag_line, account_candidate.tag_line),
      seen_with    = (SELECT array_agg(DISTINCT x)
                        FROM unnest(account_candidate.seen_with || EXCLUDED.seen_with) x)
     WHERE account_candidate.state = 'pending'
    RETURNING puuid
  `;
  return rows.length > 0;
}

/** 경기 시점의 Riot ID. 표시용 힌트다 — 조인에 쓰지 않는다(§11-1). */
function riotIdsOf(dto: MatchDto): Map<string, { game_name: string | null; tag_line: string | null }> {
  return new Map(
    (dto.info.participants ?? [])
      .filter((p) => p.puuid)
      .map((p) => [p.puuid, { game_name: p.riotIdGameName || null, tag_line: p.riotIdTagline || null }]),
  );
}

/** 이 경기에 있는 puuid 중 스트리머에게 매핑된 것 → streamer_id */
async function ownerMap(tx: Tx, puuids: string[]): Promise<Map<string, string>> {
  if (puuids.length === 0) return new Map();
  const rows = await tx<{ puuid: string; streamer_id: string }[]>`
    SELECT puuid, streamer_id FROM streamer_account
     WHERE puuid = ANY(${puuids}::text[]) AND active_to IS NULL
  `;
  return new Map(rows.map((r) => [r.puuid, r.streamer_id]));
}

/**
 * 토너먼트 코드 판에 있던 **미매핑 참가자**를 후보로 쌓는다.
 *
 * ★ 토너먼트 코드 방은 아무나 못 들어간다. 거기 있는 10명은 **초대받은 사람들**이라 모르는 참가자도 스트리머일
 *   가능성이 실제로 높다. 그래서 아는 사람이 한 명만 있어도 나머지 아홉을 전부 본다.
 *   공개 큐(지명 수집의 개인 기록) 판은 쌓지 않는다 — 같은 판의 일반인 아홉이 승인 큐를 노이즈로 덮는다.
 *
 * 자동 등록은 여기서도 하지 않는다(§11-2). 후보는 승인 큐로만 간다.
 */
async function recordCandidatesFromMatch(
  tx: Tx,
  participants: ParticipantRow[],
  riotIds: Map<string, { game_name: string | null; tag_line: string | null }>,
): Promise<number> {
  const owners = await ownerMap(tx, participants.map((p) => p.puuid).filter((x): x is string => x != null));
  const knownStreamerIds = [...new Set(owners.values())];
  // 아는 사람이 하나도 없는 방은 우리 관심사가 아니다 — 근거 없이 명단만 부풀린다.
  if (knownStreamerIds.length === 0) return 0;

  // ★ 후보는 **계정이 있는데 주인을 모르는 사람**이다.
  const unmapped = participants.filter((p): p is typeof p & { puuid: string } =>
    p.puuid != null && !owners.has(p.puuid));
  let n = 0;
  for (const p of unmapped) {
    // game_name/tag_line 은 매치 응답에 있지만 **낡았을 수 있다**(닉네임은 바뀐다).
    // 여기선 그대로 넣고, 식별 잡이 account-v1 으로 현재 값을 다시 푼다.
    const id = riotIds.get(p.puuid);
    if (await upsertCandidate(tx, {
      puuid: p.puuid,
      game_name: id?.game_name ?? null,
      tag_line: id?.tag_line ?? null,
      seen_with: knownStreamerIds,
    })) n++;
  }
  return n;
}

/**
 * 같은 로비에 있던 puuid 를 후보로 쌓는다(Engine B 스펙테이터 — 지명 계정의 로비만 본다).
 * **자동 등록은 하지 않는다** — 근거 없는 매핑을 만들지 않는다는 원칙(§11-2) 때문에 승인 큐로만 간다.
 */
export async function recordAccountCandidates(
  entries: { puuid: string; game_name?: string | null; tag_line?: string | null; seen_with: string[] }[],
): Promise<number> {
  // ★ puuid 가 빈 항목을 방어한다. spectator-v5 는 puuid 없는 참가자를 섞어서 주는데,
  //   그게 여기까지 오면 NOT NULL 위반으로 **잡 전체가 죽는다**. 실제로 그렇게 죽었다.
  const clean = entries.filter((e) => typeof e.puuid === "string" && e.puuid.length > 0);
  if (clean.length === 0) return 0;
  const sql = db();
  let n = 0;
  await sql.begin(async (tx) => {
    for (const e of clean) {
      if (await upsertCandidate(tx, e)) n++;
    }
  });
  return n;
}

/** 이미 매핑된 계정은 후보가 아니다. spectator 로 본 puuid 를 걸러낸다. */
export async function filterUnmappedPuuids(puuids: string[]): Promise<string[]> {
  // 빈 값은 여기서 떨군다. NULL 이 섞여 들어오면 unnest 가 NULL 행을 돌려주고,
  // 그게 그대로 후보 삽입까지 흘러가 NOT NULL 위반이 된다.
  const clean = puuids.filter((p) => typeof p === "string" && p.length > 0);
  if (clean.length === 0) return [];
  const sql = db();
  const rows = await sql<{ p: string }[]>`
    SELECT p FROM unnest(${clean}::text[]) AS p
     WHERE p IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM streamer_account sa WHERE sa.puuid = p AND sa.active_to IS NULL)
  `;
  return rows.map((r) => r.p);
}

// ── job_run — 무엇이 언제 돌았나 ─────────────────────────────────────

export async function startJob(job: string): Promise<number> {
  const sql = db();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO job_run (job) VALUES (${job}) RETURNING id
  `;
  return Number(rows[0].id);
}

export async function finishJob(
  id: number,
  result: { state: "ok" | "failed"; processed?: number; apiCalls?: number; error?: string | null; detail?: unknown },
): Promise<void> {
  const sql = db();
  await sql`
    UPDATE job_run SET
      finished_at = now(),
      state       = ${result.state},
      processed   = ${result.processed ?? 0},
      api_calls   = ${result.apiCalls ?? 0},
      error       = ${result.error ?? null},
      detail      = ${result.detail === undefined ? null : sql.json(result.detail as never)}
     WHERE id = ${id}
  `;
}
