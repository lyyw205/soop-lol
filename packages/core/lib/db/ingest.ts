/**
 * 수집 파이프라인의 DB 면(面).
 *
 * 워커(apps/worker)는 Riot 호출과 스케줄만 하고, **행을 만드는 규칙은 전부 여기**에 있다.
 * 웹의 관리자 화면이 같은 함수로 재파생을 돌릴 수 있어야 하기 때문이다.
 *
 * 원칙 (docs/PLAN.md §11-5): 파생 테이블(`streamer_encounter`·`champion_stat`)은
 * 언제나 지우고 다시 만들 수 있어야 한다. 그래서 여기의 모든 파생 함수는 **멱등**이다.
 */

import type postgres from "postgres";

import { db } from "./client.ts";
import type { MatchSource } from "./types.ts";
import {
  deriveEncounters,
  toMatchRow,
  toParticipantRows,
  type EncounterParticipant,
  type EncounterRow,
  type MatchRow,
  type ParticipantRow,
} from "../ingest/transform.ts";
import type { LeagueEntryDto, MatchDto } from "../riot/types.ts";

type Tx = postgres.TransactionSql;

// ── 폴링 대상 ────────────────────────────────────────────────────────

export interface IngestTarget {
  puuid: string;
  streamer_id: string;
  display_name: string;
  game_name: string | null;
  tag_line: string | null;
  summoner_id: string | null;
  last_match_synced_at: Date | null;
  last_rank_synced_at: Date | null;
  last_profile_synced_at: Date | null;
}

/**
 * 수집 대상 계정. **스트리머에게 붙어 있고 현재 유효한** 계정만이다.
 * `active_to IS NULL` 조건이 빠지면 양도된 옛 계정까지 계속 긁는다.
 *
 * 유효 계정은 스트리머 하나에만 붙는다(`streamer_account_one_owner_idx`)므로
 * 이 조인은 계정당 한 행이다.
 */
export async function listIngestTargets(): Promise<IngestTarget[]> {
  const sql = db();
  return sql<IngestTarget[]>`
    SELECT ra.puuid, sa.streamer_id, s.display_name,
           ra.game_name, ra.tag_line, ra.summoner_id,
           ra.last_match_synced_at, ra.last_rank_synced_at, ra.last_profile_synced_at
      FROM riot_account ra
      JOIN streamer_account sa ON sa.puuid = ra.puuid AND sa.active_to IS NULL
      JOIN streamer s          ON s.id = sa.streamer_id
     WHERE ra.is_active
     ORDER BY ra.last_match_synced_at NULLS FIRST, ra.puuid
  `;
}

// ── Engine A — 랭크 스냅샷 ───────────────────────────────────────────

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
 * 이미 가진 매치의 생성 시각. 백필 커서를 **API 호출 없이** 내리기 위한 것이다.
 * 배치 100개 중 90개가 이미 있는 계정에서 이게 없으면 커서가 제자리걸음을 한다.
 */
export async function matchCreationTimes(ids: string[]): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map();
  const sql = db();
  const rows = await sql<{ match_id: string; game_creation: Date }[]>`
    SELECT match_id, game_creation FROM match WHERE match_id = ANY(${ids}::text[])
  `;
  return new Map(rows.map((r) => [r.match_id, r.game_creation]));
}

export interface SaveMatchResult {
  inserted: boolean;
  encounters: number;
  game_creation: Date;
  /** 이 경기에서 새로 쌓인 미매핑 참가자 수. 내전이면 여기가 곧 '모르는 사람' 수다. */
  candidates: number;
}

/**
 * 매치 하나를 적재하고 조우까지 파생한다. **한 트랜잭션**이다 —
 * 매치만 들어가고 참가자가 빠진 상태가 남으면 파생이 조용히 틀어진다.
 *
 * `source` 를 넘기지 않으면 응답을 보고 판정한다(`classifySource`).
 * 수기 데이터처럼 응답으로 알 수 없는 것만 호출부가 지정한다.
 */
export async function saveMatch(dto: MatchDto, source?: MatchSource): Promise<SaveMatchResult> {
  const sql = db();
  const matchRow = toMatchRow(dto, source);
  const participantRows = toParticipantRows(dto);

  return sql.begin(async (tx) => {
    const inserted = await tx<{ match_id: string }[]>`
      INSERT INTO match ${tx(matchRow as unknown as Record<string, unknown>)}
      ON CONFLICT (match_id) DO NOTHING
      RETURNING match_id
    `;

    if (inserted.length > 0) {
      for (const p of participantRows) await insertParticipant(tx, p);
    }
    // 이미 있던 매치라도 파생은 다시 돈다 — 새 스트리머가 등록됐을 수 있다.
    const encounters = await writeEncounters(tx, matchRow, participantRows);
    // ★ 후보는 **첫 적재 때만** 쌓는다. 백필이 이미 아는 매치를 다시 만나는 건
    //   흔한 일인데(창 겹침·live 선점), 그때마다 seen_count 를 올리면 "몇 번 봤나"가
    //   "몇 번 저장을 시도했나"로 변질되고 파생 멱등 약속도 깨진다.
    const candidates = inserted.length > 0
      ? await recordCandidatesFromMatch(tx, matchRow, participantRows, riotIdsOf(dto))
      : 0;

    return {
      inserted: inserted.length > 0,
      encounters,
      game_creation: matchRow.game_creation,
      candidates,
    };
  }) as Promise<SaveMatchResult>;
}

/**
 * account_candidate 한 건 UPSERT. **후보를 쌓는 두 경로의 단일 출처다** —
 * 스펙테이터(Engine B, recordAccountCandidates)와 매치 적재(recordCandidatesFromMatch).
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

/**
 * 같은 경기에 있던 **미매핑 참가자**를 후보로 쌓는다.
 *
 * ★ 왜 매치 적재 시점에 하나
 *   지금까지 후보는 스펙테이터(Engine B 실시간)에서만 쌓였다. 그래서 **끝난 뒤에
 *   수집한 경기**의 미등록 참가자는 그냥 버려졌다. 내전은 대부분 이 경로로 들어온다
 *   (경기 중에 우리가 보고 있을 이유가 없다) — 정작 제일 중요한 데서 안 쌓이고 있었다.
 *
 * ★ **내전만** 쌓는다. 공개 큐는 쌓지 않는다
 *   처음엔 "아는 스트리머가 2명 이상인 경기"로 넓게 잡았는데, verify:ingest 에서
 *   솔랭 한 판이 후보를 8명 만들어냈다. 스트리머 400명 × 수백 판이면 승인 큐가
 *   무작위 유저로 덮이고, 정작 봐야 할 내전 참가자가 그 아래 묻힌다.
 *
 *   내전 방은 다르다 — 아무나 못 들어간다. 거기 있는 10명은 **초대받은 사람들**이라
 *   모르는 참가자도 스트리머일 가능성이 실제로 높다. 그래서 내전은 아는 사람이
 *   한 명만 있어도 나머지 아홉을 전부 본다.
 *
 *   공개 큐의 미매핑 계정은 지금처럼 스펙테이터(Engine B)가 맡는다. 실시간으로
 *   본 것만 쌓이므로 양이 저절로 제한된다.
 *
 * 자동 등록은 여기서도 하지 않는다(§11-2). 후보는 승인 큐로만 간다.
 */
async function recordCandidatesFromMatch(
  tx: Tx,
  match: Pick<MatchRow, "queue_id" | "source">,
  participants: ParticipantRow[],
  riotIds: Map<string, { game_name: string | null; tag_line: string | null }>,
): Promise<number> {
  if (match.source !== "tournament_code") return 0;

  const owners = await ownerMap(tx, participants.map((p) => p.puuid).filter((x): x is string => x != null));
  const knownStreamerIds = [...new Set(owners.values())];
  // 아는 사람이 하나도 없는 방은 우리 관심사가 아니다 — 근거 없이 명단만 부풀린다.
  if (knownStreamerIds.length === 0) return 0;

  // ★ 후보는 **계정이 있는데 주인을 모르는 사람**이다. puuid 가 아예 없는 참가자는
  //   우리가 이미 누군지 아는(streamer_id 로 넣은) 사람이라 후보가 아니다.
  const unmapped = participants.filter((p): p is typeof p & { puuid: string } =>
    p.puuid != null && !owners.has(p.puuid));
  if (unmapped.length === 0) return 0;

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
 * 참가자는 한 행씩 넣는다.
 * 벌크 헬퍼(`sql(rows)`)를 쓰지 않는 이유는 `perks`·`challenges` 가 jsonb 라서다 —
 * 벌크 경로에서는 객체가 JSON 으로 직렬화된다는 보장이 없어서 `[object Object]` 가 들어간다.
 * 경기당 10행이고 레이트리밋이 어차피 병목이라 손해가 아니다.
 */
async function insertParticipant(tx: Tx, p: ParticipantRow): Promise<void> {
  await tx`
    INSERT INTO match_participant (
      match_id, puuid, streamer_id, participant_id, team_id, side_no,
      team_position, individual_position, lane, role,
      champion_id, champion_name, champ_level, outcome,
      kills, deaths, assists, gold_earned, cs,
      damage_to_champions, damage_taken, vision_score,
      wards_placed, wards_killed, control_wards, turret_kills, first_blood_kill,
      summoner1_id, summoner2_id, items, perks, challenges
    ) VALUES (
      ${p.match_id}, ${p.puuid}, ${p.streamer_id ?? null}, ${p.participant_id}, ${p.team_id}, ${p.side_no},
      ${p.team_position}, ${p.individual_position}, ${p.lane}, ${p.role},
      ${p.champion_id}, ${p.champion_name}, ${p.champ_level}, ${p.outcome},
      ${p.kills}, ${p.deaths}, ${p.assists}, ${p.gold_earned}, ${p.cs},
      ${p.damage_to_champions}, ${p.damage_taken}, ${p.vision_score},
      ${p.wards_placed}, ${p.wards_killed}, ${p.control_wards}, ${p.turret_kills}, ${p.first_blood_kill},
      ${p.summoner1_id}, ${p.summoner2_id}, ${p.items},
      ${p.perks === null ? null : tx.json(p.perks as never)},
      ${tx.json(p.challenges as never)}
    )
    -- ★ PK 가 (match_id, participant_id) 로 바뀌었다(0017). (match_id, puuid) 는
    --   이제 **부분** 유니크 인덱스(WHERE puuid IS NOT NULL)라 ON CONFLICT 이
    --   같은 조건 없이는 추론하지 못한다 — 실제로 42P10 으로 적재가 죽었다.
    ON CONFLICT (match_id, participant_id) DO NOTHING
  `;
}

/** 404 난 매치. 2년 지나 삭제된 것이므로 **다시 시도하지 않는다**. */
export async function markDeadMatch(matchId: string, reason = "not_found"): Promise<void> {
  const sql = db();
  await sql`
    INSERT INTO dead_match (match_id, reason) VALUES (${matchId}, ${reason})
    ON CONFLICT (match_id) DO NOTHING
  `;
}

/** 신규 매치 커서. 뒤로 가지 않게 GREATEST 로만 올린다. */
export async function advanceMatchCursor(puuid: string, at: Date): Promise<void> {
  const sql = db();
  await sql`
    UPDATE riot_account
       SET last_match_synced_at = GREATEST(coalesce(last_match_synced_at, to_timestamp(0)), ${at})
     WHERE puuid = ${puuid}
  `;
}

// ── Engine D — 조우 파생 ─────────────────────────────────────────────

/** 이 경기에 있는 puuid 중 스트리머에게 매핑된 것 → streamer_id */
async function ownerMap(tx: Tx, puuids: string[]): Promise<Map<string, string>> {
  if (puuids.length === 0) return new Map();
  const rows = await tx<{ puuid: string; streamer_id: string }[]>`
    SELECT puuid, streamer_id FROM streamer_account
     WHERE puuid = ANY(${puuids}::text[]) AND active_to IS NULL
  `;
  return new Map(rows.map((r) => [r.puuid, r.streamer_id]));
}

type EncounterMatchRow = Pick<MatchRow,
  "match_id" | "game_code" | "queue_id" | "mode_key" | "source" | "game_creation" | "game_duration">;

async function writeEncounters(
  tx: Tx,
  match: EncounterMatchRow,
  // ParticipantRow 도 그대로 들어온다 — EncounterParticipant 가 그 부분집합이다.
  participants: EncounterParticipant[],
): Promise<number> {
  const owners = await ownerMap(tx, participants.map((p) => p.puuid).filter((x): x is string => x != null));
  const rows = deriveEncounters(
    {
      match_id: match.match_id,
      game_code: match.game_code,
      queue_id: match.queue_id,
      mode_key: match.mode_key,
      source: match.source,
      game_creation: match.game_creation,
      game_duration: match.game_duration,
    },
    participants,
    owners,
  );

  // 재파생은 **덮어쓰기**여야 한다. 매핑이 풀린 쌍이 남으면 유령 전적이 된다.
  await tx`DELETE FROM streamer_encounter WHERE match_id = ${match.match_id}`;
  for (const r of rows) await insertEncounter(tx, r);
  return rows.length;
}

async function insertEncounter(tx: Tx, r: EncounterRow): Promise<void> {
  await tx`
    INSERT INTO streamer_encounter (
      match_id, streamer_a_id, streamer_b_id, a_puuid, b_puuid,
      relation, a_position, b_position, is_lane_matchup,
      a_outcome, b_outcome, a_champion_id, b_champion_id,
      a_kills, a_deaths, a_assists, a_cs, a_gold, a_damage,
      b_kills, b_deaths, b_assists, b_cs, b_gold, b_damage,
      game_code, queue_id, mode_key, source, game_creation, game_duration, category
    ) VALUES (
      ${r.match_id}, ${r.streamer_a_id}::uuid, ${r.streamer_b_id}::uuid, ${r.a_puuid}, ${r.b_puuid},
      ${r.relation}, ${r.a_position}, ${r.b_position}, ${r.is_lane_matchup},
      ${r.a_outcome}, ${r.b_outcome}, ${r.a_champion_id}, ${r.b_champion_id},
      ${r.a_kills}, ${r.a_deaths}, ${r.a_assists}, ${r.a_cs}, ${r.a_gold}, ${r.a_damage},
      ${r.b_kills}, ${r.b_deaths}, ${r.b_assists}, ${r.b_cs}, ${r.b_gold}, ${r.b_damage},
      ${r.game_code}, ${r.queue_id}, ${r.mode_key}, ${r.source}, ${r.game_creation}, ${r.game_duration},
      -- ★ 분류는 SQL 함수 하나로만 낸다. TS 에도 같은 규칙이 있지만(화면이 이름을
      --   붙여야 해서) **쓰는 쪽은 한 곳**이라야 어긋날 여지가 없다.
      CASE WHEN ${r.game_code} = 'lol' THEN
        lol_match_category(${r.source}, ${r.queue_id},
          (SELECT ev.kind
             FROM match m
             LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
             LEFT JOIN event ev ON ev.id = COALESCE(ms.event_id, m.event_id)
            WHERE m.match_id = ${r.match_id}))
      ELSE NULL END
    )
    ON CONFLICT (match_id, streamer_a_id, streamer_b_id) DO UPDATE SET
      relation        = EXCLUDED.relation,
      is_lane_matchup = EXCLUDED.is_lane_matchup,
      -- 대회를 나중에 붙이면 분류가 바뀐다(예: 코드 내전 → 이름 붙은 대회).
      -- 재파생이 이걸 안 갱신하면 필터가 옛 분류에 갇힌다.
      category        = EXCLUDED.category,
      derived_at      = now()
  `;
}

/**
 * 조우가 어긋난 매치를 찾는다 — **신규 스트리머 등록 시 재파생의 진입점**(docs/PLAN.md §11-5).
 *
 * "쌍이 하나도 없는 매치"가 아니라 **기대 쌍 수와 실제 행 수가 다른** 매치를 찾는다.
 * 이미 조우가 있는 경기에 세 번째 스트리머가 등록되는 경우까지 잡아야 하기 때문이다.
 */
export async function findMatchesNeedingEncounters(limit = 500): Promise<string[]> {
  const sql = db();
  const rows = await sql<{ match_id: string }[]>`
    WITH present AS (
      SELECT mp.match_id, sa.streamer_id
        FROM match_participant mp
        JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
       GROUP BY mp.match_id, sa.streamer_id
    ), expected AS (
      SELECT match_id, count(*) * (count(*) - 1) / 2 AS pairs
        FROM present GROUP BY match_id HAVING count(*) >= 2
    ), actual AS (
      SELECT match_id, count(*) AS pairs FROM streamer_encounter GROUP BY match_id
    )
    SELECT e.match_id
      FROM expected e
      LEFT JOIN actual a ON a.match_id = e.match_id
     WHERE coalesce(a.pairs, 0) <> e.pairs
     ORDER BY e.match_id
     LIMIT ${limit}
  `;
  return rows.map((r) => r.match_id);
}

/** 매핑이 풀려 근거를 잃은 조우 행을 지운다. 반대 방향의 자기치유. */
export async function pruneOrphanEncounters(): Promise<number> {
  const sql = db();
  const rows = await sql`
    -- ★ "근거를 잃은 조우" 는 **계정으로 맺힌 조우의 계정이 떨어져 나간 것**이다.
    --   a_puuid 가 애초에 NULL 인 조우는 방송에서 사람을 직접 확인해 넣은 것이라
    --   계정 매핑에 기댄 적이 없다 — 지울 근거가 없다(0017).
    --   이 조건을 안 달았더니 이라333 의 조우 45쌍이 만들어지자마자 통째로 지워졌다.
    DELETE FROM streamer_encounter se
     WHERE (se.a_puuid IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM streamer_account sa
              WHERE sa.streamer_id = se.streamer_a_id AND sa.puuid = se.a_puuid AND sa.active_to IS NULL))
        OR (se.b_puuid IS NOT NULL AND NOT EXISTS (
             SELECT 1 FROM streamer_account sa
              WHERE sa.streamer_id = se.streamer_b_id AND sa.puuid = se.b_puuid AND sa.active_to IS NULL))
        -- 사람도 계정도 없는 조우는 남아 있을 이유가 없다.
        OR (se.a_puuid IS NULL AND NOT EXISTS (SELECT 1 FROM streamer WHERE id = se.streamer_a_id))
        OR (se.b_puuid IS NULL AND NOT EXISTS (SELECT 1 FROM streamer WHERE id = se.streamer_b_id))
    RETURNING match_id
  `;
  return rows.length;
}

/**
 * 한 매치의 조우를 **호출자의 트랜잭션 안에서** 다시 만든다.
 *
 * ★ 왜 tx 를 받는 판이 따로 있나: 원본(match·match_participant)을 고치는 것과 조우를
 *   다시 파생하는 것이 **다른 트랜잭션이면** 중간에 실패했을 때 승패가 어긋난 채 남는다.
 *   검수 화면의 저장은 둘을 한 트랜잭션으로 묶어야 한다.
 */
export async function rederiveEncountersInTx(tx: Tx, matchId: string): Promise<number> {
  const matches = await tx<EncounterMatchRow[]>`
    SELECT match_id, game_code, queue_id, mode_key, source, game_creation, game_duration
      FROM match WHERE match_id = ${matchId}
  `;
  if (matches.length === 0) return 0;
  const participants = await tx<EncounterParticipant[]>`
    SELECT puuid, streamer_id, team_id, side_no, team_position, individual_position,
           outcome, champion_id,
           kills, deaths, assists, cs, gold_earned, damage_to_champions
      FROM match_participant WHERE match_id = ${matchId}
  `;
  return writeEncounters(tx, matches[0], participants);
}

/** 이미 적재된 매치에서 조우를 다시 만든다. Riot 호출이 전혀 없다. */
export async function rederiveEncounters(matchIds: string[]): Promise<number> {
  if (matchIds.length === 0) return 0;
  const sql = db();
  let total = 0;

  for (const matchId of matchIds) {
    total += await sql.begin(async (tx) => rederiveEncountersInTx(tx, matchId)) as number;
  }
  return total;
}

// ── Engine C — 백필 커서 ─────────────────────────────────────────────

export interface BackfillTarget {
  puuid: string;
  backfill_before: Date | null;
  matches_ingested: number;
  error_count: number;
}

/**
 * 백필 대상 하나를 집는다.
 * `FOR UPDATE SKIP LOCKED` — 워커를 두 개 띄워도 같은 계정을 겹쳐 긁지 않는다.
 */
export async function claimBackfillTarget(maxErrors = 5): Promise<BackfillTarget | null> {
  const sql = db();
  const rows = await sql<BackfillTarget[]>`
    UPDATE ingest_cursor SET backfill_state = 'running', updated_at = now()
     WHERE puuid = (
       SELECT puuid FROM ingest_cursor
        WHERE backfill_state <> 'done'
          AND NOT backfill_reached_end
          AND error_count < ${maxErrors}
        ORDER BY updated_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING puuid, backfill_before, matches_ingested, error_count
  `;
  return rows[0] ?? null;
}

/**
 * 백필 한 배치의 결과를 기록한다.
 *
 * ★ 성공하면 `error_count` 를 **0으로 되돌린다**. 그러지 않으면 일시적인 5xx 몇 번에
 *   계정이 영구히 백필 대상에서 빠진다 (claim 이 error_count 로 거른다).
 */
export async function saveBackfillProgress(patch: {
  puuid: string;
  before?: Date | null;
  ingested?: number;
  state: "pending" | "running" | "done" | "error";
  reachedEnd?: boolean;
  error?: string | null;
}): Promise<void> {
  const sql = db();
  const failed = patch.state === "error";
  await sql`
    UPDATE ingest_cursor SET
      backfill_before      = coalesce(${patch.before ?? null}, backfill_before),
      backfill_state       = ${patch.state},
      backfill_reached_end = ${patch.reachedEnd ?? false} OR backfill_reached_end,
      matches_ingested     = matches_ingested + ${patch.ingested ?? 0},
      error_count          = ${failed ? sql`error_count + 1` : sql`0`},
      last_error           = ${failed ? patch.error ?? "unknown" : null},
      updated_at           = now()
     WHERE puuid = ${patch.puuid}
  `;
}

/** 계정 매핑 시 만들어진 커서에 시작 지점을 채운다. 없으면 만든다. */
export async function ensureBackfillCursor(puuid: string): Promise<void> {
  const sql = db();
  await sql`
    INSERT INTO ingest_cursor (puuid) VALUES (${puuid})
    ON CONFLICT (puuid) DO NOTHING
  `;
}

// ── 계정 후보 (spectator 로 발굴) ────────────────────────────────────

/**
 * 같은 로비에 있던 puuid 를 후보로 쌓는다. **자동 등록은 하지 않는다** —
 * 근거 없는 매핑을 만들지 않는다는 원칙(§11-2) 때문에 승인 큐로만 간다.
 */
export async function recordAccountCandidates(
  entries: { puuid: string; game_name?: string | null; tag_line?: string | null; seen_with: string[] }[],
): Promise<number> {
  // ★ puuid 가 빈 항목을 방어한다. spectator-v5 는 puuid 없는 참가자를 섞어서 주는데,
  //   그게 여기까지 오면 NOT NULL 위반으로 **잡 전체가 죽는다**. 실제로 그렇게 죽었다.
  //   호출부(Engine B)에서도 거르지만, 근거 없는 행을 만들지 않는 게 이 테이블의 원칙이라
  //   저장 직전에 한 번 더 막는다.
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

// ── champion_stat 재계산 ─────────────────────────────────────────────

/**
 * 모스트 챔피언 롤업. **통째로 다시 만든다** (증분 갱신은 어긋나면 못 잡는다).
 *
 * season 라벨은 지금 `'ALL'` 과 **KST 연도** 두 가지만 만든다.
 * Riot 의 스플릿 경계(2026-S2 같은)는 패치 일정에 따라 바뀌므로,
 * 경계 표를 근거 있게 확정하기 전에는 없는 구분을 만들어내지 않는다.
 */
/**
 * 챔피언 통계를 다시 만든다.
 *
 * `streamerIds` 를 주면 **그 사람들만** 다시 만든다. 검수 화면에서 한 경기를 고칠 때마다
 * 전 테이블을 재빌드하면(DELETE 후 전량 INSERT) 비용이 경기 수에 비례해 커지기 때문이다.
 * ⚠ SQL 본문을 복사해 두 함수로 나누지 않는다 — 갈라지면 전체 재빌드와 범위 재계산이
 *   다른 값을 내고, 그건 아무도 눈치채지 못한다.
 */
export async function recomputeChampionStats(streamerIds?: string[]): Promise<number> {
  const sql = db();
  return sql.begin(async (tx) => recomputeChampionStatsInTx(tx, streamerIds)) as Promise<number>;
}

/**
 * 위와 같은 일을 **호출자의 트랜잭션 안에서** 한다.
 *
 * 검수 화면의 저장은 원본 수정·조우 재파생·통계 재계산이 **다 되거나 다 안 되어야** 한다.
 * 따로 커밋하면 중간 실패 때 화면이 서로 다른 말을 하는 상태로 남는다.
 */
export async function recomputeChampionStatsInTx(tx: Tx, streamerIds?: string[]): Promise<number> {
  // 빈 배열은 "아무도"다. 전체 재빌드(undefined)와 구분해서 아무 일도 하지 않는다.
  if (streamerIds && streamerIds.length === 0) return 0;
  const scope = streamerIds ?? null;
  // ★ 지우기와 넣기를 **한 문장의 CTE 로 합치지 않는다**. 데이터 변경 CTE 들은 같은
  //   스냅샷을 보기 때문에 삭제가 삽입에 보이지 않고, PK 충돌 여부가 미묘해진다.
  //   두 문장이면 순서가 명확하다.
  {
    await tx`
      DELETE FROM champion_stat
       WHERE ${scope}::uuid[] IS NULL OR streamer_id = ANY(${scope}::uuid[])
    `;
    const rows = await tx`
      INSERT INTO champion_stat
        (streamer_id, champion_id, queue_id, season, games, wins, kills, deaths, assists, cs,
         seconds_played, category, kda_games)
      SELECT sid.streamer_id, mp.champion_id, m.queue_id, s.season,
             count(*)::int                             AS games,
             count(*) FILTER (WHERE mp.outcome = 'win')::int AS wins,
             -- ★★ 분자와 분모가 **같은 판을 센다.** 셋을 다 읽은 판만 더한다.
             --   왜 sum() 에 FILTER 를 거나 — sum 은 NULL 을 건너뛰고 coalesce 가 0 을
             --   씌우므로, kills=5 · deaths=NULL · assists=NULL 한 판이 **5/0/0** 이 된다.
             --   "모른다" 가 "안 죽었다" 로 바뀌는 것이고, 그건 숫자로 거짓말하는 것이다
             --   (CLAUDE.md 3). 분모만 고치면 더 나쁘다 — 분모 0 에 분자 5 가 남는다.
             coalesce(sum(mp.kills)    FILTER (WHERE kda.all_read), 0)::int AS kills,
             coalesce(sum(mp.deaths)   FILTER (WHERE kda.all_read), 0)::int AS deaths,
             coalesce(sum(mp.assists)  FILTER (WHERE kda.all_read), 0)::int AS assists,
             coalesce(sum(mp.cs), 0)::bigint           AS cs,
             coalesce(sum(m.game_duration), 0)::bigint AS seconds_played,
             lol_match_category(m.source, m.queue_id, ev.kind)  AS category,
             -- ★ 평균의 분모. games 로 나누면 못 읽은 판이 분모에만 남아 평균이 묽어진다
             --   (0020 ⑧). 결과 화면은 셋을 같이 주거나 안 주므로 손실은 거의 없고,
             --   부분 판독(툴팁 가림 등)은 **읽은 것으로 치지 않는다.**
             count(*) FILTER (WHERE kda.all_read)::int     AS kda_games
        FROM match_participant mp
        -- ★ 검수에서 뺀 경기와 다른 게임은 통계에도 없어야 한다. champion_stat 은 뷰가
        --   아니라 core_public 의 visibility/game_code 필터가 여기까지 오지 않는다 (0020·0026).
        JOIN match m             ON m.match_id = mp.match_id
                                AND m.visibility = 'public'
                                AND m.game_code = 'lol'
        LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
        LEFT JOIN event ev       ON ev.id = COALESCE(ms.event_id, m.event_id)
        -- ★ 계정이 붙었으면 매핑으로, 아니면 참가자 행에 적힌 사람으로.
        --   계정 없는 참가자를 빼면 그 사람의 모스트 챔피언이 통째로 빈다(0017).
        LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
        JOIN LATERAL (SELECT COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id) sid ON true
        -- 「이 판의 KDA 를 다 읽었나」. 분자와 분모가 이 하나를 같이 본다.
        CROSS JOIN LATERAL (
          SELECT (mp.kills IS NOT NULL AND mp.deaths IS NOT NULL AND mp.assists IS NOT NULL) AS all_read
        ) kda
        -- KST 고정 오프셋(+9h). tzdata 에 의존하지 않는다 — core 의 kstYear 와 같은 규칙.
        CROSS JOIN LATERAL (
          VALUES ('ALL'), (to_char(m.game_creation + interval '9 hours', 'YYYY'))
        ) AS s(season)
        -- ★ champion_id 0 은 챔피언이 아니라 **'모른다'** 다. 수기 대회 경기는
        --   누가 어느 팀으로 이겼는지는 근거가 있어도 챔피언까진 없을 때가 많고,
        --   saveTournamentGame 이 그런 참가자를 0 으로 넣는다(없는 값을 지어내지 않는다).
        --   거르지 않으면 모스트 챔피언 1위가 '알 수 없는 챔피언'이 되어 버린다.
       WHERE mp.champion_id > 0 AND sid.streamer_id IS NOT NULL
         -- 범위 재계산일 때는 지운 사람만 다시 넣는다. 위 DELETE 와 같은 조건이어야 한다.
         AND (${scope}::uuid[] IS NULL OR sid.streamer_id = ANY(${scope}::uuid[]))
       -- ⚠ 위치 번호다: 1=streamer_id 2=champion_id 3=queue_id 4=season **12=category**.
       --   ★ 이 다섯이 champion_stat 의 PK 와 **정확히 같아야** INSERT 가 자기와 충돌하지
       --     않는다(0016 이 category 를 여기 넣고 PK 엔 안 넣어서 실제로 터졌다 — 0020 ⑦).
       --   SELECT 목록에 컬럼을 끼워 넣으면 번호가 밀린다. 넣을 땐 **맨 뒤에** 넣을 것.
       GROUP BY 1, 2, 3, 4, 12
      ON CONFLICT (streamer_id, champion_id, queue_id, season, category) DO UPDATE SET
        games = EXCLUDED.games, wins = EXCLUDED.wins, kills = EXCLUDED.kills,
        deaths = EXCLUDED.deaths, assists = EXCLUDED.assists, cs = EXCLUDED.cs,
        seconds_played = EXCLUDED.seconds_played, kda_games = EXCLUDED.kda_games
      -- ★ 병렬 재계산 보호. 겹치는 스트리머를 건드리는 두 트랜잭션이 동시에 돌면
      --   (예: ck:merge 를 여러 조사자가 동시에 돌릴 때) 한쪽의 DELETE 가 다른 쪽의
      --   방금 커밋된 INSERT 를 못 보고 지나가, 이 INSERT 가 PK 충돌로 죽는 사고가
      --   실제로 났다(2026-09 동시 조사). 최종값은 어느 쪽이 이기든 같은 재계산
      --   결과라 UPDATE 로 흡수해도 안전하다 — 죽는 대신 마지막 값으로 수렴한다.
      RETURNING streamer_id
    `;
    return rows.length;
  }
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
