/**
 * 대회(내전) 기록 적재 — 나무위키 시드(scripts/seed-tournament.ts)의 저장 경로.
 *
 * 멸망전 같은 내전은 커스텀 게임이라 Riot API 로 조회할 수 없다(CLAUDE.md 제약 1).
 * 그래서 **주최측 발표를 근거로 수기로** 넣는다(`collected_via='manual'`). 들어가는 자리는 모든 내전과 같다 —
 * 행사 → 시리즈 → 세트(match) + 참가자. 공개 집계(상대전적·챔피언)는 원본에서 바로 계산되는 뷰라(0089)
 * 대회를 위한 별도 계보도, 다시 만들 파생 표도 없다.
 *
 * ★ 행사 찾기·고치기와 판을 시리즈에 두는 쓰기는 classification.ts 한 곳이다 — 여기서 따로 SQL 로 붙이지 않는다.
 */

import { db } from "./client.ts";
import { normalizePlacement } from "../metrics/placement.ts";
import { dropEmptySeriesInTx, placeSetInTx } from "./classification.ts";
// 참가자 불변식은 VOD 판독 경로(ck.ts)와 **같은 것**을 쓴다. 두 벌이면 한쪽만 고쳐진다.
import { assertIdentityAgrees, resolveChampion } from "./participant.ts";

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
        VALUES (${eventId}::uuid, ${t.name}, ${normalizePlacement(t.placement)}, ${t.placement_rank ?? null},
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
                  -- 시드가 만든 판(수기)이 아니거나 사람이 검수한 판이면 그 판의 팀 배정은 시드 것이 아니다.
                  AND (m.reviewed_at IS NOT NULL OR m.collected_via <> 'manual')
             )
         -- 대진(0061)이 시드·결정으로 쓰는 팀도 지우지 않는다 — 지우면 외래키로 시드 전체가 실패한다.
         AND NOT EXISTS (SELECT 1 FROM event_slot sl WHERE event_team.id IN (sl.seed_a, sl.seed_b))
         AND NOT EXISTS (SELECT 1 FROM event_slot_decision d WHERE event_team.id = ANY(d.winners))
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
   *   시드는 단판이면 경기 ID 를 시리즈 ID 로 쓴다. 판은 시리즈 밖에 있을 수 없다(0089).
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
    const [game] = await tx<{ game_code: string }[]>`SELECT game_code FROM event WHERE id = ${g.event_id}::uuid`;
    if (game?.game_code !== "lol") throw new Error(`${g.match_id}: 행사 ${g.event_id} 는 롤 행사가 아니다.`);
    // ★ 사람이 검수 화면에서 고친 경기는 **건드리지 않는다**(0020).
    //   시드는 나무위키를 다시 읽어 통째로 재생성하므로, 안 막으면 손으로 고친
    //   라인업·승패가 다음 실행에 조용히 사라진다. 판독값이 시드보다 정확하다.
    //   ★ `FOR UPDATE` — 검수 저장과 동시에 돌아도 보호가 뚫리지 않아야 한다.
    const reviewed = await tx<{ reviewed_at: Date | null }[]>`
      SELECT reviewed_at FROM match WHERE match_id = ${g.match_id} FOR UPDATE
    `;
    if (reviewed[0]?.reviewed_at != null) return false;

    // 분류 칸(series·scope)은 이 INSERT 가 아니라 아래 placeSetInTx 가 정한다 — 판을 시리즈에 두는 길은 하나다.
    // 새 판은 시리즈 밖(personal)으로 잠깐 만들고 같은 트랜잭션에서 곧바로 시리즈에 둔다.
    await tx`
      INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, game_creation, game_duration,
                         winning_team, collected_via, scope, source_url,
                         blue_team_id, red_team_id, game_creation_precision)
      VALUES (${g.match_id}, 'lol', 0, '0', 'CUSTOM', ${g.played_at}, ${g.duration},
              ${g.winning_team}, 'manual', 'personal', ${g.source_url},
              ${g.blue_team_id ?? null}, ${g.red_team_id ?? null}, ${g.played_at_precision})
      ON CONFLICT (match_id) DO UPDATE SET
        game_creation  = EXCLUDED.game_creation,
        game_creation_precision = EXCLUDED.game_creation_precision,
        game_duration  = EXCLUDED.game_duration,
        winning_team   = EXCLUDED.winning_team,
        source_url     = EXCLUDED.source_url,
        blue_team_id   = EXCLUDED.blue_team_id,
        red_team_id    = EXCLUDED.red_team_id
        -- ⚠ collected_via 는 갱신하지 않는다. VOD 조사가 만든 행을 시드가 같은 match_id 로
        --   덮더라도 "어떻게 알았나" 를 뺏어오면 안 된다 — prune 대상이 조용히 바뀐다.
    `;
    // 시드는 사람이 돌리는 CLI 라 actor admin — 사람이 그 행사에서 뺀 판(event_exclusion)도 시드 파일이 정본이면 다시 붙인다.
    await placeSetInTx(tx, { match_id: g.match_id, game_no: g.series_game_no, actor: "admin", series: {
      id: g.series_id, game_code: "lol", event_id: g.event_id,
      best_of: g.best_of, best_of_evidence: g.best_of_evidence,
      round_label: g.round_label, set_order_known: g.set_order_known,
    } });
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
 *    같은 행사를 나무위키 시드와 VOD 판독이 공유하는 것이 정상 흐름이다 —
 *    멸망전 경기를 방송 결과창으로 보강하면 그 행은 collected_via='vod' 다.
 *    범위를 안 좁히면 시드를 한 번 다시 돌릴 때마다 그 판독이 통째로 사라진다.
 *    사람이 검수한 행(reviewed_at)도 같은 이유로 남긴다. 시드의 판은 수기(collected_via='manual')다.
 *
 * match_participant 는 ON DELETE CASCADE 로 같이 사라진다. 공개 집계는 뷰라 따로 지울 것이 없다.
 */
export async function pruneEventMatches(eventId: string, keepMatchIds: string[]): Promise<number> {
  return db().begin(async (tx) => {
    const rows = await tx<{ match_id: string; series_id: string }[]>`
      DELETE FROM match m
       USING match_series ms
       WHERE ms.id = m.series_id AND ms.game_code = m.game_code AND ms.event_id = ${eventId}::uuid
         AND m.match_id <> ALL(${keepMatchIds})
         AND m.collected_via = 'manual'
         AND m.reviewed_at IS NULL
         -- ★ VOD 근거가 붙은 경기도 남긴다. 근거 프레임은 ON DELETE SET NULL 이라 지우면
         --   연결이 소리 없이 끊기고, 후보 JSON 의 match_id 는 없는 경기를 가리키게 된다.
         --   멸망전 경기를 방송 결과창으로 보강하는 것이 정상 흐름이라 흔히 걸린다.
         AND NOT EXISTS (SELECT 1 FROM lead_match lm WHERE lm.match_id = m.match_id)
      RETURNING m.match_id, m.series_id
    `;
    // ★ 판이 지워지면 **빈 시리즈**가 남는다. 빈 시리즈는 라운드명 같은 값을 받아도 어떤 경기에도 안 보이므로,
    //   채웠다는 처리 건수가 복구를 증명하지 못하게 된다(2026-09-24 — 라운드명 476개 중 162개가 빈 시리즈에 들어갔다).
    //   빈 시리즈 정리는 classification.ts 한 곳의 규칙을 쓴다.
    for (const seriesId of new Set(rows.map((r) => r.series_id))) await dropEmptySeriesInTx(tx, seriesId);
    return rows.length;
  }) as Promise<number>;
}

export async function listEventGames(eventSlug: string): Promise<{ match_id: string }[]> {
  const sql = db();
  return sql<{ match_id: string }[]>`
    SELECT m.match_id FROM match m
      JOIN match_series ms ON ms.id = m.series_id AND ms.game_code = m.game_code
      JOIN event e ON e.id = ms.event_id
     WHERE e.slug = ${eventSlug}
     ORDER BY m.game_creation
  `;
}

/**
 * 로스터 빈자리의 출처 표기 이름(0068)을 대회 단위로 다시 쓴다. 표시 전용 — 스트리머를 만들지 않는다.
 * ★ 연결된 멤버(event_team_member)가 그 포지션에 이미 있으면 넣지 않는다 — 사람이 이름보다 우선이다.
 * 같은 출처(source_url)로 넣었던 이름은 지우고 다시 쓴다 — 다른 출처로 채운 이름은 남긴다. 넣은·건너뛴 수를 돌려준다.
 */
export async function saveListedNames(
  eventId: string,
  rows: { team: string; position: "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY"; name: string; sourceUrl: string }[],
): Promise<{ inserted: number; skippedLinked: number; unknownTeams: string[] }> {
  const sql = db();
  let inserted = 0, skippedLinked = 0;
  const unknownTeams = new Set<string>();
  await sql.begin(async (tx) => {
    // 이 출처(같은 source_url)로 넣었던 것만 다시 쓴다 — 다른 출처(보조 자료)로 채운 이름은 지우지 않는다
    const sources = [...new Set(rows.map((r) => r.sourceUrl))];
    await tx`DELETE FROM event_team_listed_name WHERE event_id = ${eventId}::uuid AND source_url = ANY(${sources}::text[])`;
    for (const r of rows) {
      const [team] = await tx<{ id: string }[]>`SELECT id FROM event_team WHERE event_id = ${eventId}::uuid AND name = ${r.team}`;
      if (!team) { unknownTeams.add(r.team); continue; }
      const [linked] = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM event_team_member WHERE event_team_id = ${team.id}::uuid AND position = ${r.position}`;
      if (linked.n > 0) { skippedLinked++; continue; }
      const res = await tx`
        INSERT INTO event_team_listed_name (event_team_id, event_id, position, name, source_url)
        VALUES (${team.id}::uuid, ${eventId}::uuid, ${r.position}, ${r.name}, ${r.sourceUrl})
        ON CONFLICT (event_team_id, position) DO UPDATE SET name = EXCLUDED.name, source_url = EXCLUDED.source_url
        WHERE event_team_listed_name.source_url = EXCLUDED.source_url`;
      inserted += res.count;
    }
  });
  return { inserted, skippedLinked, unknownTeams: [...unknownTeams] };
}

type RosterPosition = "TOP" | "JUNGLE" | "MIDDLE" | "BOTTOM" | "UTILITY";

/**
 * 로스터 빈자리 채우기(보조 출처용). **기존 값을 덮지 않는다.**
 *   positions: 포지션이 비어 있는(NULL) 연결 멤버에게만 포지션을 준다. 그 팀에 이미 그 포지션 멤버가 있으면 건너뛴다.
 *   names:     연결 멤버도 표시 이름도 없는 자리에만 표시 이름(0068)을 넣는다.
 * 대회 단위 한 트랜잭션. 실제로 바뀐 수를 돌려준다.
 */
export async function fillRosterGaps(
  eventId: string,
  input: {
    positions: { teamId: string; streamerId: string; position: RosterPosition }[];
    names: { teamId: string; position: RosterPosition; name: string; sourceUrl: string }[];
  },
): Promise<{ positioned: number; named: number }> {
  let positioned = 0, named = 0;
  await db().begin(async (tx) => {
    for (const p of input.positions) {
      const r = await tx`
        UPDATE event_team_member m SET position = ${p.position}
         WHERE m.event_id = ${eventId}::uuid AND m.event_team_id = ${p.teamId}::uuid AND m.streamer_id = ${p.streamerId}::uuid
           AND m.position IS NULL
           AND NOT EXISTS (SELECT 1 FROM event_team_member o WHERE o.event_team_id = m.event_team_id AND o.position = ${p.position})`;
      positioned += r.count;
      // 사람이 그 자리를 채웠으니 같은 자리의 표시 이름은 치운다(사람이 이름보다 우선 — 0068)
      if (r.count) await tx`DELETE FROM event_team_listed_name WHERE event_team_id = ${p.teamId}::uuid AND position = ${p.position}`;
    }
    for (const n of input.names) {
      const r = await tx`
        INSERT INTO event_team_listed_name (event_team_id, event_id, position, name, source_url)
        SELECT ${n.teamId}::uuid, ${eventId}::uuid, ${n.position}, ${n.name}, ${n.sourceUrl}
         WHERE NOT EXISTS (SELECT 1 FROM event_team_member m WHERE m.event_team_id = ${n.teamId}::uuid AND m.position = ${n.position})
        ON CONFLICT (event_team_id, position) DO NOTHING`;
      named += r.count;
    }
  });
  return { positioned, named };
}

/** 표시 이름(0068) 한 칸을 지운다 — 사람이 근거를 보고 내린 정정(잘못 옮긴 이름·일반인 이름). 지운 수를 돌려준다. */
export async function removeListedName(eventId: string, teamName: string, position: RosterPosition): Promise<number> {
  const r = await db()`
    DELETE FROM event_team_listed_name l USING event_team t
     WHERE t.id = l.event_team_id AND t.event_id = ${eventId}::uuid AND t.name = ${teamName} AND l.position = ${position}`;
  return r.count;
}

/**
 * 출처가 발표한 팀 투표 순위(event_team.vote_rank)를 넣는다. 이름이 맞는 팀만 — 없는 팀은 돌려준다.
 * ★ 시드(seed:tournament)도 team_vote_ranks 로 같은 칸을 쓴다. 이 함수로 넣은 값은 시드 파일에도 적어야
 *   재시드 때 지워지지 않는다(scripts/fill-vote-ranks.mjs 가 둘 다 한다).
 */
export async function saveVoteRanks(eventId: string, ranks: Record<string, number>): Promise<{ updated: number; unknownTeams: string[] }> {
  let updated = 0;
  const unknownTeams: string[] = [];
  await db().begin(async (tx) => {
    for (const [team, rank] of Object.entries(ranks)) {
      const r = await tx`UPDATE event_team SET vote_rank = ${rank} WHERE event_id = ${eventId}::uuid AND name = ${team}`;
      if (r.count) updated += r.count; else unknownTeams.push(team);
    }
  });
  return { updated, unknownTeams };
}
