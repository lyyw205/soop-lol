/**
 * 대회(내전) 기록 적재.
 *
 * 멸망전 같은 내전은 커스텀 게임이라 Riot API 로 조회할 수 없다(CLAUDE.md 제약 1).
 * 그래서 **주최측 발표를 근거로 수기로** 넣는다. 대신 들어가는 자리는 공개 큐와 같다 —
 * `match`(source='manual') + `match_participant` 로 넣으면 Engine D 가 그대로
 * `streamer_encounter` 를 파생시킨다. 대회 상대전적을 위해 별도 계보를 만들지 않는다.
 *
 * `match.source` 로 공개 큐와 항상 분리 가능하다 (docs/PLAN.md §11-7).
 */

import type postgres from "postgres";

import { db } from "./client.ts";
// 파생 갱신은 수집·검수 경로와 **같은 함수**를 쓴다. 분류가 바뀌면 여기도 책임진다.
import { recomputeChampionStatsInTx, rederiveEncountersInTx } from "./ingest.ts";
// 참가자 불변식은 VOD 판독 경로(ck.ts)와 **같은 것**을 쓴다. 두 벌이면 한쪽만 고쳐진다.
import { assertIdentityAgrees, resolveChampion } from "./participant.ts";
import { ensureMatchSeries } from "./series.ts";

type Tx = postgres.TransactionSql;

export interface TournamentEventInput {
  slug: string;
  /** 새로 만들 때 필수. 기존 대회에 연결만 할 때는 비워도 된다. */
  name?: string;
  /** 새로 만들 때 필수. 기존 대회에 연결할 때 주면 기존 값과 대조한다. */
  kind?: EventKind;
  organizer?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  source_url?: string | null;
}

/**
 * 대회 팀과 그 명단을 넣는다. 이 대회에 더는 없는 팀·멤버는 지운다 —
 * 시드 파일이 그 대회의 전부여야 한다(pruneEventMatches 와 같은 이유).
 *
 * ★ 팀 소속은 대회 단위다. 이게 있어야 "이 사람이 그 대회에 어느 팀으로 나갔나" 를
 *   답할 수 있고, 스트리머별 대회 성적 리스트가 만들어진다.
 */
export async function saveEventTeams(
  eventId: string,
  teams: {
    name: string;
    placement?: string | null;
    placement_rank?: number | null;
    /** 주최측 발표 사실(0039). 모르면 비운다 — 지어내지 않는다. */
    prize?: string | null;
    vote_rank?: number | null;
    members: {
      streamer_id: string;
      position?: string | null;
      is_captain?: boolean | null;
      rating_label?: string | null;
      rating_points?: number | null;
      award?: string | null;
    }[];
  }[],
): Promise<Map<string, string>> {
  const sql = db();
  const byName = new Map<string, string>();
  await sql.begin(async (tx) => {
    for (const t of teams) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO event_team (event_id, name, placement, placement_rank, prize, vote_rank)
        VALUES (${eventId}::uuid, ${t.name}, ${t.placement ?? null}, ${t.placement_rank ?? null},
                ${t.prize ?? null}, ${t.vote_rank ?? null})
        ON CONFLICT (event_id, name) DO UPDATE SET
          placement = EXCLUDED.placement, placement_rank = EXCLUDED.placement_rank,
          prize = EXCLUDED.prize, vote_rank = EXCLUDED.vote_rank
        RETURNING id
      `;
      byName.set(t.name, row.id);
      await tx`DELETE FROM event_team_member WHERE event_team_id = ${row.id}::uuid`;
      for (const m of t.members) {
        await tx`
          INSERT INTO event_team_member
            (event_id, event_team_id, streamer_id, position, is_captain, rating_label, rating_points, award)
          VALUES (${eventId}::uuid, ${row.id}::uuid, ${m.streamer_id}::uuid, ${m.position ?? null},
                  ${m.is_captain ?? null}, ${m.rating_label ?? null}, ${m.rating_points ?? null}, ${m.award ?? null})
          ON CONFLICT (event_id, streamer_id) DO UPDATE SET
            event_team_id = EXCLUDED.event_team_id, position = EXCLUDED.position,
            is_captain = EXCLUDED.is_captain, rating_label = EXCLUDED.rating_label,
            rating_points = EXCLUDED.rating_points, award = EXCLUDED.award
        `;
      }
    }
    const keep = [...byName.values()];
    // ★ 검수된 경기가 쓰고 있는 팀은 지우지 않는다.
    //
    //   `match.blue_team_id`/`red_team_id` 는 `ON DELETE SET NULL`(0008)이다. 그래서
    //   여기서 팀을 지우면 **사람이 판독해 넣은 경기의 팀 배정이 조용히 NULL 이 된다** —
    //   `pruneEventMatches` 가 match 쪽에서 막은 것과 정확히 같은 사고가 팀 쪽으로 난다.
    //   VOD 판독은 시드에 없는 팀명(그 방송의 오버레이 팀명)을 쓰는 게 정상이므로
    //   (CK-COLLECTION.md — 같은 판을 참가자마다 자기 팀장 이름으로 부른다) 흔히 걸린다.
    await tx`
      DELETE FROM event_team
       WHERE event_id = ${eventId}::uuid
         AND id <> ALL(${keep}::uuid[])
         AND NOT EXISTS (
               SELECT 1 FROM match m
                WHERE (m.blue_team_id = event_team.id OR m.red_team_id = event_team.id)
                  AND (m.reviewed_at IS NOT NULL OR m.origin <> 'wiki_seed')
             )
    `;
  });
  return byName;
}

/**
 * 대회의 출처 링크를 넣는다. 시드가 그 대회의 전부라 **파일에 없는 링크는 지운다.**
 * 순서는 파일에 적힌 순서다.
 */
export async function saveEventLinks(eventId: string, links: { label: string; url: string }[]): Promise<void> {
  const sql = db();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM event_link WHERE event_id = ${eventId}::uuid`;
    for (const [i, l] of links.entries()) {
      await tx`
        INSERT INTO event_link (event_id, label, url, sort)
        VALUES (${eventId}::uuid, ${l.label}, ${l.url}, ${i})
      `;
    }
  });
}

/** 대회 안내 사실을 넣는다. 링크와 같이 파일에 없는 사실은 지운다(시드가 그 대회의 전부다). */
export async function saveEventFacts(
  eventId: string,
  facts: { section: string; label: string; value: string }[],
): Promise<void> {
  const sql = db();
  await sql.begin(async (tx) => {
    await tx`DELETE FROM event_fact WHERE event_id = ${eventId}::uuid`;
    for (const [i, f] of facts.entries()) {
      await tx`
        INSERT INTO event_fact (event_id, section, label, value, sort)
        VALUES (${eventId}::uuid, ${f.section}, ${f.label}, ${f.value}, ${i})
      `;
    }
  });
}

/** slug → streamer_id. 계정이 없어도 스트리머로는 존재하므로 팀 명단에는 넣을 수 있다. */
export async function streamerIdsBySlug(slugs: string[]): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const sql = db();
  const rows = await sql<{ slug: string; id: string }[]>`
    SELECT slug, id FROM streamer WHERE slug = ANY(${slugs}::text[])
  `;
  return new Map(rows.map((r) => [r.slug, r.id]));
}

export type EventKind = "ck" | "scrim" | "tournament" | "showmatch" | "other";

/**
 * 대회를 **찾거나 새로 만든다.** 이미 있으면 절대 고치지 않는다.
 *
 * ★★ 왜 찾기와 고치기를 나누나 (2026-09-24 사고, 0035)
 *    VOD 조사 반영이 "기존 멸망전에 경기를 붙이기" 만 하면 되는 자리에서 `upsertEvent` 를
 *    불렀고, 그 함수가 분류·주최·기간·출처·이름을 **입력에 없는 값까지** 덮었다. 분류를 안 적은
 *    입력에는 기본값 'ck' 가 들어가 멸망전 4개 대회·153경기가 공개 화면에서 내전이 됐다.
 *    연결하는 쪽은 대회를 **읽기만** 해야 한다. 고치는 것은 주인(시드·관리자)의 일이다.
 *
 * ★ `kind` 를 주면 기존 값과 대조한다. 다르면 조용히 넘어가지도, 덮지도 않고 멈춘다 —
 *   입력이 틀렸거나 대회를 고쳐야 하거나 둘 중 하나고, 어느 쪽인지는 사람이 정한다.
 * ★ 새로 만들 때는 이름과 분류가 **필수**다. 기본값을 두면 빠뜨린 입력이 오류 대신
 *   "내전" 이 된다(0035 가 DB 기본값도 지웠다).
 * ★ 동시에 두 쪽이 같은 slug 를 만들어도 하나만 들어가고, 나중 쪽은 **실제로 저장된 값**과
 *   대조한다 (`ensureMatchSeries` 와 같은 모양).
 */
export async function ensureEventInTx(tx: Tx, input: TournamentEventInput): Promise<string> {
  const slug = input.slug.trim();
  if (!slug) throw new Error("대회 slug 가 비어 있습니다.");
  const [existing] = await tx<{ id: string; kind: EventKind }[]>`
    SELECT id, kind FROM event WHERE slug = ${slug} FOR UPDATE
  `;
  if (!existing) {
    if (!input.name?.trim()) throw new Error(`새 대회 ${slug} 에는 이름이 필요합니다 — slug 로 대신하지 않습니다.`);
    if (!input.kind) throw new Error(`새 대회 ${slug} 에는 분류(kind)가 필요합니다 — 기본값이 없습니다.`);
    await tx`
      INSERT INTO event (slug, name, kind, organizer, starts_at, ends_at, source_url)
      VALUES (${slug}, ${input.name.trim()}, ${input.kind}, ${input.organizer ?? null},
              ${input.starts_at || null}, ${input.ends_at || null}, ${input.source_url ?? null})
      ON CONFLICT (slug) DO NOTHING
    `;
  }
  const [row] = await tx<{ id: string; kind: EventKind }[]>`
    SELECT id, kind FROM event WHERE slug = ${slug} FOR UPDATE
  `;
  if (input.kind && row.kind !== input.kind) {
    throw new Error(`대회 ${slug} 의 분류는 이미 ${row.kind} 입니다 (입력: ${input.kind}). `
      + "연결하는 쪽은 대회를 고치지 않습니다 — 분류가 틀렸으면 시드나 관리자 화면에서 고치세요.");
  }
  return row.id;
}

/** 필드를 **생략하면 그대로**, 명시한 null 이면 비운다. 이름과 분류는 비울 수 없다. */
export type EventPatch = Partial<Omit<TournamentEventInput, "slug">>;

/**
 * 이미 있는 대회를 고친다 — 대회의 주인(시드·관리자)만 부른다.
 *
 * ★ 생략한 필드는 건드리지 않는다. 사고 때 빈칸이 null 로 덮여 주최·기간·출처가 사라졌다.
 *
 * ★★ `kind` 를 바꾸면 **그 대회 경기들의 분류가 통째로 바뀐다**(`lol_match_category`).
 *    그런데 분류가 사는 곳이 둘이다 — `match` 쪽은 질의 시점에 계산하고(뷰),
 *    `streamer_encounter`·`champion_stat` 쪽은 **저장된 컬럼**이다(0016 이 속도 때문에
 *    비정규화했다). 그래서 kind 만 바꾸면 공개 경기 목록은 `tournament` 인데 상대전적과
 *    챔피언 통계는 `ck` 인 채로 갈라진다(재현됨). 아무도 눈치채지 못한다.
 *    그래서 여기서 파생까지 같이 책임진다 — **kind 가 실제로 바뀐 때만** 다시 만든다.
 *
 * ⚠ 이건 경기의 `reviewed_at` 으로는 못 막는다. 그건 경기 행을 지키는 자물쇠이고,
 *   여기서 바뀌는 것은 **대회의 성격**이라 검수된 경기에도 정당하게 번져야 한다.
 */
export async function updateEventInTx(tx: Tx, slug: string, patch: EventPatch): Promise<string> {
  const [before] = await tx<{ id: string; kind: EventKind }[]>`
    SELECT id, kind FROM event WHERE slug = ${slug} FOR UPDATE
  `;
  if (!before) throw new Error(`대회 ${slug} 가 없습니다 — 새로 만들 때는 ensureEvent 를 쓰세요.`);
  if (patch.name === null || (patch.name !== undefined && !patch.name.trim())) throw new Error("대회 이름은 비울 수 없습니다.");
  if (patch.kind === null) throw new Error("대회 분류는 비울 수 없습니다.");

  const set: Record<string, unknown> = {};
  for (const key of ["name", "kind", "organizer", "starts_at", "ends_at", "source_url"] as const) {
    if (patch[key] === undefined) continue;
    set[key] = key === "starts_at" || key === "ends_at" ? (patch[key] || null) : patch[key];
  }
  if (Object.keys(set).length > 0) {
    await tx`UPDATE event SET ${tx(set, ...Object.keys(set))} WHERE id = ${before.id}::uuid`;
  }

  if (patch.kind !== undefined && patch.kind !== before.kind) {
    const affected = await tx<{ match_id: string }[]>`
      SELECT m.match_id
        FROM match m
        LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
       WHERE COALESCE(ms.event_id, m.event_id) = ${before.id}::uuid
    `;
    for (const m of affected) await rederiveEncountersInTx(tx, m.match_id);
    // 챔피언 통계는 사람 단위라 한 번에 범위 재계산한다.
    const people = await tx<{ streamer_id: string }[]>`
      SELECT DISTINCT COALESCE(sa.streamer_id, mp.streamer_id) AS streamer_id
        FROM match_participant mp
        JOIN match m ON m.match_id = mp.match_id
        LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
        LEFT JOIN streamer_account sa ON sa.puuid = mp.puuid AND sa.active_to IS NULL
       WHERE COALESCE(ms.event_id, m.event_id) = ${before.id}::uuid
         AND COALESCE(sa.streamer_id, mp.streamer_id) IS NOT NULL
    `;
    await recomputeChampionStatsInTx(tx, people.map((p) => p.streamer_id));
  }
  return before.id;
}

export async function ensureEvent(input: TournamentEventInput): Promise<string> {
  return db().begin((tx) => ensureEventInTx(tx, input)) as Promise<string>;
}

export async function updateEvent(slug: string, patch: EventPatch): Promise<string> {
  return db().begin((tx) => updateEventInTx(tx, slug, patch)) as Promise<string>;
}

/** slug → 대표 계정 puuid. 계정이 없는 스트리머는 빠진다 (조우는 puuid 로 맺힌다). */
export async function mainPuuidsBySlug(slugs: string[]): Promise<Map<string, string>> {
  if (slugs.length === 0) return new Map();
  const sql = db();
  const rows = await sql<{ slug: string; puuid: string }[]>`
    SELECT s.slug, sa.puuid
      FROM streamer s
      JOIN LATERAL (
             SELECT puuid FROM streamer_account
              WHERE streamer_id = s.id AND active_to IS NULL
              ORDER BY is_main DESC, created_at
              LIMIT 1
           ) sa ON true
     WHERE s.slug = ANY(${slugs}::text[])
  `;
  return new Map(rows.map((r) => [r.slug, r.puuid]));
}

export interface TournamentGameInput {
  match_id: string;
  event_id: string;
  played_at: Date;
  duration: number | null;
  source_url: string | null;
  /**
   * 승패를 확정한 **결과 화면**의 지점 (VOD 시각 · 프레임 파일명).
   * 채팅 `!공지` 는 사람이 치는 거라 틀리고 뒤늦게 고쳐진다 — 단서일 뿐 정본이 아니다.
   * 방송을 읽어 넣는 내전은 seed-tournament 가 이걸 필수로 요구한다 (마이그레이션 0015).
   */
  result_evidence?: string | null;
  /**
   * 그 경기가 속한 시리즈와 몇 번째 세트인지. 세트로도 매치로도 셀 수 있어야 해서 필요하다(0007).
   * ★ 대회 경기는 단판도 시리즈다(0035) — 라운드명을 둘 곳이 시리즈 하나여야 한다.
   *   시드는 단판이면 경기 ID 를 시리즈 ID 로 쓴다.
   */
  series_id: string;
  series_game_no: number;
  /** 대회 안의 위치 ("8강 2경기"). 세트 번호는 빼고 적는다. */
  round_label?: string | null;
  /** 세트 순서를 출처에서 확인했나. 시드 생성기가 순서를 만들었으면 false. */
  set_order_known?: boolean;
  /** 'date' 면 played_at 의 시각은 지어낸 값이다. 시드는 확인한 경우에만 'datetime'. */
  played_at_precision: "datetime" | "date";
  /** 결과 스코어가 아니라 대회 규정·VOD 표기로 확인된 경우에만 채운다. */
  best_of?: number | null;
  best_of_evidence?: string | null;
  /** 그 경기의 청/홍이 어느 팀이었나 (event_team.id). 공개 큐에는 없다. */
  blue_team_id?: string | null;
  red_team_id?: string | null;
  /** 100 = blue, 200 = red */
  winning_team: 100 | 200;
  participants: {
    /** 계정을 붙였으면 puuid. 아직이면 null 이고 streamer_id 로 사람을 식별한다(0017). */
    puuid: string | null;
    /** 계정이 없어도 방송에서 확인된 사람. 둘 다 비면 저장이 거부된다. */
    streamer_id?: string | null;
    /**
     * 아직 등록 안 된 사람의 **화면·출처에 적힌 이름**(0020). 사람을 모를 때 자리를 지키는 칸이다 —
     * 이게 없으면 시드가 그 자리를 버리거나(9명) 팀 명단의 다른 사람으로 채운다(거짓 출전).
     */
    observed_name?: string | null;
    team_id: 100 | 200;
    position?: string | null;
    champion_id?: number | null;
    /**
     * match-v5 의 `championName` 과 같은 영문 키(`Thresh`). 화면이 이걸로 이름을 낸다 —
     * 없으면 '챔피언 412' 라고 뜬다. champions.ko.json 의 `en` 이 같은 값이다.
     */
    champion_name?: string | null;
    /** 결과 화면에서 읽은 값. 모르면 비운다 — 0 으로 채우지 않는다. */
    kills?: number | null;
    deaths?: number | null;
    assists?: number | null;
  }[];
}

/**
 * 대회 경기 한 세트를 넣는다. 같은 `match_id` 로 다시 넣으면 갱신한다(멱등).
 *
   * ★ `riot_game_id` 와 `platform_id` 는 **비운다**. Riot 이 준 값이 아니기 때문이다.
 *   가짜 값을 채우면 나중에 "이게 진짜 Riot id 인가"를 아무도 판단할 수 없다.
 *   마이그레이션 0006 이 이 두 컬럼을 nullable 로 풀었고, 공개 큐에는 여전히
 *   NOT NULL 을 CHECK 로 강제한다.
 */
export async function saveTournamentGame(g: TournamentGameInput): Promise<boolean> {
  const sql = db();
  return sql.begin(async (tx) => {
    // ★ 사람이 검수 화면에서 고친 경기는 **건드리지 않는다**(0020).
    //   시드는 나무위키를 다시 읽어 통째로 재생성하므로, 안 막으면 손으로 고친
    //   라인업·승패가 다음 실행에 조용히 사라진다. 판독값이 시드보다 정확하다.
    //   ★ `FOR UPDATE` — 검수 저장과 동시에 돌아도 보호가 뚫리지 않아야 한다.
    const reviewed = await tx<{ reviewed_at: Date | null }[]>`
      SELECT reviewed_at FROM match WHERE match_id = ${g.match_id} FOR UPDATE
    `;
    if (reviewed[0]?.reviewed_at != null) return false;

    await ensureMatchSeries(tx, {
      id: g.series_id,
      game_code: "lol",
      event_id: g.event_id,
      best_of: g.best_of,
      best_of_evidence: g.best_of_evidence,
      round_label: g.round_label,
      set_order_known: g.set_order_known,
    });

    // 시리즈가 event 를 소유한다(0027) — 세트 행의 event_id 는 비운다.
    await tx`
      INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, game_creation, game_duration,
                         winning_team, source, origin, event_id, source_url,
                         series_id, series_game_no, blue_team_id, red_team_id, game_creation_precision)
      VALUES (${g.match_id}, 'lol', 0, '0', 'CUSTOM', ${g.played_at}, ${g.duration},
              ${g.winning_team}, 'manual', 'wiki_seed', NULL, ${g.source_url},
              ${g.series_id}, ${g.series_game_no},
              ${g.blue_team_id ?? null}, ${g.red_team_id ?? null}, ${g.played_at_precision})
      ON CONFLICT (match_id) DO UPDATE SET
        game_creation  = EXCLUDED.game_creation,
        game_creation_precision = EXCLUDED.game_creation_precision,
        game_duration  = EXCLUDED.game_duration,
        winning_team   = EXCLUDED.winning_team,
        event_id       = EXCLUDED.event_id,
        source_url     = EXCLUDED.source_url,
        series_id      = EXCLUDED.series_id,
        series_game_no = EXCLUDED.series_game_no,
        blue_team_id   = EXCLUDED.blue_team_id,
        red_team_id    = EXCLUDED.red_team_id
        -- ⚠ origin 은 갱신하지 않는다. VOD 조사가 만든 행을 시드가 같은 match_id 로
        --   덮더라도 소유권을 뺏어오면 안 된다 — prune 대상이 조용히 바뀐다.
    `;
    if (g.result_evidence?.trim()) await tx`
      INSERT INTO review_record (match_id, type, body, created_by)
      VALUES (${g.match_id}, 'final_evidence', ${g.result_evidence.trim()}, 'auto')
      ON CONFLICT (match_id) WHERE type='final_evidence' DO UPDATE SET
        body=EXCLUDED.body, created_at=now()
    `;

    // 로스터가 바뀌었을 수 있으므로 참가자는 지우고 다시 넣는다.
    await tx`DELETE FROM match_participant WHERE match_id = ${g.match_id}`;

    for (const [i, p] of g.participants.entries()) {
      await assertIdentityAgrees(tx, { participant_id: i + 1, puuid: p.puuid, streamer_id: p.streamer_id });
      // 이름과 ID 를 맞춘다 — `champion_id` 만 준 항목도 이름을 얻어야 화면이
      // '챔피언 412' 대신 제 이름을 낸다.
      const champ = resolveChampion(p.champion_id, p.champion_name);
      await tx`
        INSERT INTO match_participant
          (match_id, puuid, streamer_id, observed_name, participant_id, team_id, side_no,
           team_position, individual_position, champion_id, champion_name, outcome,
           kills, deaths, assists)
        VALUES (${g.match_id}, ${p.puuid}, ${p.streamer_id ?? null}, ${p.observed_name ?? null}, ${i + 1}, ${p.team_id},
                ${p.team_id === 100 ? 1 : 2},
                ${p.position ?? null}, ${p.position ?? null},
                ${champ.champion_id}, ${champ.champion_name},
                ${p.team_id === g.winning_team ? "win" : "loss"},
                -- ★ 모르면 NULL. 0 으로 채우면 "딜 안 하고 안 죽은 사람"이 전적에 남는다.
                --   TournamentGameInput 주석이 원래 그렇게 적고 있었는데 코드가 0 으로
                --   채우고 있었다 — 0020 이 컬럼을 nullable 로 풀어 맞췄다.
                ${p.kills ?? null}, ${p.deaths ?? null}, ${p.assists ?? null})
      `;
    }
    return true;
  }) as Promise<boolean>;
}

/**
 * 이 대회에 남아 있는 경기 중 이번 시드에 없는 것을 지운다.
 *
 * ★ 없으면 낡은 행이 그대로 남아 이중 계상된다. 실제로 겪었다 —
 *   시리즈를 1판으로 넣었다가 세트 단위로 다시 넣으니 `…:g01` 과 `…:g01s1` 이
 *   동시에 남아 조우가 두 배로 잡혔다. 시드 파일이 곧 그 대회의 전부여야 한다.
 *
 * ★★ 다만 「그 대회의 전부」는 **시드가 만든 것의 전부**다 (0020).
 *    같은 event 를 나무위키 시드와 VOD 판독이 공유하는 것이 정상 흐름이다 —
 *    멸망전 경기를 방송 결과창으로 보강하면 그 행은 origin='vod_scan' 이다.
 *    범위를 안 좁히면 시드를 한 번 다시 돌릴 때마다 그 판독이 통째로 사라진다.
 *    사람이 검수한 행(reviewed_at)도 같은 이유로 남긴다.
 *
 * match_participant·streamer_encounter 는 ON DELETE CASCADE 로 같이 사라진다.
 */
export async function pruneEventMatches(eventId: string, keepMatchIds: string[]): Promise<number> {
  const sql = db();
  const rows = await sql<{ match_id: string }[]>`
    DELETE FROM match m
     WHERE (m.event_id = ${eventId}
            OR EXISTS (
              SELECT 1 FROM match_series ms
               WHERE ms.id = m.series_id AND ms.game_code = m.game_code
                 AND ms.event_id = ${eventId}
            ))
       AND m.match_id <> ALL(${keepMatchIds})
       AND m.origin = 'wiki_seed'
       AND m.reviewed_at IS NULL
       -- ★ VOD 근거가 붙은 경기도 남긴다. 근거 프레임은 ON DELETE SET NULL 이라 지우면
       --   연결이 소리 없이 끊기고, 후보 JSON 의 match_id 는 없는 경기를 가리키게 된다.
       --   멸망전 경기를 방송 결과창으로 보강하는 것이 정상 흐름이라 흔히 걸린다.
       AND NOT EXISTS (SELECT 1 FROM lead_match lm WHERE lm.match_id = m.match_id)
    RETURNING m.match_id
  `;
  // ★ 경기가 다른 시리즈로 옮겨 가거나 지워지면 **빈 시리즈**가 남는다. 빈 시리즈는 라운드명 같은
  //   값을 받아도 어떤 경기에도 안 보이므로, 채웠다는 처리 건수가 복구를 증명하지 못하게 된다
  //   (2026-09-24 — 라운드명 476개 중 162개가 빈 시리즈에 들어갔다). 이 대회 것만 치운다.
  await sql`
    DELETE FROM match_series ms
     WHERE ms.event_id = ${eventId}::uuid AND ms.game_code = 'lol'
       AND NOT EXISTS (SELECT 1 FROM match m WHERE m.series_id = ms.id AND m.game_code = ms.game_code)
  `;
  return rows.length;
}

export async function listEventGames(eventSlug: string): Promise<{ match_id: string }[]> {
  const sql = db();
  return sql<{ match_id: string }[]>`
    SELECT m.match_id FROM match m
      LEFT JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      JOIN event e ON e.id = COALESCE(ms.event_id, m.event_id)
     WHERE e.slug = ${eventSlug}
     ORDER BY m.game_creation
  `;
}
