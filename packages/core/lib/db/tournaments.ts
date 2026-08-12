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

import { db } from "./client.ts";

export interface TournamentEventInput {
  slug: string;
  name: string;
  kind?: "scrim" | "tournament" | "showmatch" | "other";
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
    members: { streamer_id: string; position?: string | null }[];
  }[],
): Promise<Map<string, string>> {
  const sql = db();
  const byName = new Map<string, string>();
  await sql.begin(async (tx) => {
    for (const t of teams) {
      const [row] = await tx<{ id: string }[]>`
        INSERT INTO event_team (event_id, name, placement, placement_rank)
        VALUES (${eventId}::uuid, ${t.name}, ${t.placement ?? null}, ${t.placement_rank ?? null})
        ON CONFLICT (event_id, name) DO UPDATE SET
          placement = EXCLUDED.placement, placement_rank = EXCLUDED.placement_rank
        RETURNING id
      `;
      byName.set(t.name, row.id);
      await tx`DELETE FROM event_team_member WHERE event_team_id = ${row.id}::uuid`;
      for (const m of t.members) {
        await tx`
          INSERT INTO event_team_member (event_id, event_team_id, streamer_id, position)
          VALUES (${eventId}::uuid, ${row.id}::uuid, ${m.streamer_id}::uuid, ${m.position ?? null})
          ON CONFLICT (event_id, streamer_id) DO UPDATE SET
            event_team_id = EXCLUDED.event_team_id, position = EXCLUDED.position
        `;
      }
    }
    const keep = [...byName.values()];
    await tx`DELETE FROM event_team WHERE event_id = ${eventId}::uuid AND id <> ALL(${keep}::uuid[])`;
  });
  return byName;
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

export async function upsertEvent(input: TournamentEventInput): Promise<string> {
  const sql = db();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO event (slug, name, kind, organizer, starts_at, ends_at, source_url)
    VALUES (${input.slug}, ${input.name}, ${input.kind ?? "tournament"},
            ${input.organizer ?? null}, ${input.starts_at || null},
            ${input.ends_at || null}, ${input.source_url ?? null})
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name, kind = EXCLUDED.kind, organizer = EXCLUDED.organizer,
      starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
      source_url = EXCLUDED.source_url
    RETURNING id
  `;
  return rows[0].id;
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
   * 다전제라면 그 시리즈를 묶는 키와 몇 번째 세트인지.
   * 단판이면 둘 다 비운다 — 그러면 질의에서 자기 자신이 곧 시리즈가 된다.
   * 세트로도 매치로도 셀 수 있어야 해서 필요하다 (마이그레이션 0007).
   */
  series_id?: string | null;
  series_game_no?: number | null;
  /** 그 경기의 청/홍이 어느 팀이었나 (event_team.id). 공개 큐에는 없다. */
  blue_team_id?: string | null;
  red_team_id?: string | null;
  /** 100 = blue, 200 = red */
  winning_team: 100 | 200;
  participants: {
    puuid: string;
    team_id: 100 | 200;
    position?: string | null;
    champion_id?: number | null;
  }[];
}

/**
 * 대회 경기 한 세트를 넣는다. 같은 `match_id` 로 다시 넣으면 갱신한다(멱등).
 *
 * ★ `game_id` 와 `platform_id` 는 **비운다**. Riot 이 준 값이 아니기 때문이다.
 *   가짜 값을 채우면 나중에 "이게 진짜 Riot id 인가"를 아무도 판단할 수 없다.
 *   마이그레이션 0006 이 이 두 컬럼을 nullable 로 풀었고, 공개 큐에는 여전히
 *   NOT NULL 을 CHECK 로 강제한다.
 */
export async function saveTournamentGame(g: TournamentGameInput): Promise<void> {
  const sql = db();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO match (match_id, queue_id, game_mode, game_creation, game_duration,
                         winning_team, source, event_id, source_url, result_evidence,
                         series_id, series_game_no, blue_team_id, red_team_id)
      VALUES (${g.match_id}, 0, 'CUSTOM', ${g.played_at}, ${g.duration},
              ${g.winning_team}, 'manual', ${g.event_id}::uuid, ${g.source_url},
              ${g.result_evidence ?? null},
              ${g.series_id ?? null}, ${g.series_game_no ?? null},
              ${g.blue_team_id ?? null}, ${g.red_team_id ?? null})
      ON CONFLICT (match_id) DO UPDATE SET
        game_creation  = EXCLUDED.game_creation,
        game_duration  = EXCLUDED.game_duration,
        winning_team   = EXCLUDED.winning_team,
        event_id       = EXCLUDED.event_id,
        source_url     = EXCLUDED.source_url,
        result_evidence = EXCLUDED.result_evidence,
        series_id      = EXCLUDED.series_id,
        series_game_no = EXCLUDED.series_game_no,
        blue_team_id   = EXCLUDED.blue_team_id,
        red_team_id    = EXCLUDED.red_team_id
    `;

    // 로스터가 바뀌었을 수 있으므로 참가자는 지우고 다시 넣는다.
    await tx`DELETE FROM match_participant WHERE match_id = ${g.match_id}`;

    for (const [i, p] of g.participants.entries()) {
      await tx`
        INSERT INTO match_participant
          (match_id, puuid, participant_id, team_id, team_position, individual_position,
           champion_id, win, kills, deaths, assists)
        VALUES (${g.match_id}, ${p.puuid}, ${i + 1}, ${p.team_id},
                ${p.position ?? null}, ${p.position ?? null},
                ${p.champion_id ?? 0}, ${p.team_id === g.winning_team},
                0, 0, 0)
      `;
    }
  });
}

/**
 * 이 대회에 남아 있는 경기 중 이번 시드에 없는 것을 지운다.
 *
 * ★ 없으면 낡은 행이 그대로 남아 이중 계상된다. 실제로 겪었다 —
 *   시리즈를 1판으로 넣었다가 세트 단위로 다시 넣으니 `…:g01` 과 `…:g01s1` 이
 *   동시에 남아 조우가 두 배로 잡혔다. 시드 파일이 곧 그 대회의 전부여야 한다.
 *
 * match_participant·streamer_encounter 는 ON DELETE CASCADE 로 같이 사라진다.
 */
export async function pruneEventMatches(eventId: string, keepMatchIds: string[]): Promise<number> {
  const sql = db();
  const rows = await sql<{ match_id: string }[]>`
    DELETE FROM match
     WHERE event_id = ${eventId}
       AND match_id <> ALL(${keepMatchIds})
    RETURNING match_id
  `;
  return rows.length;
}

export async function listEventGames(eventSlug: string): Promise<{ match_id: string }[]> {
  const sql = db();
  return sql<{ match_id: string }[]>`
    SELECT m.match_id FROM match m
      JOIN event e ON e.id = m.event_id
     WHERE e.slug = ${eventSlug}
     ORDER BY m.game_creation
  `;
}
