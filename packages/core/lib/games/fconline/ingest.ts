import { db } from "../../db/client.ts";
import { isHumanExcluded } from "./context.ts";
import type { FcoMatchDetail, FcoMatchPlayer } from "./types.ts";
import type postgres from "postgres";

export function fcoMatchTimestamp(raw: string): string {
  // NEXON matchDate는 시간대 없는 UTC0 문자열로 내려온다.
  const iso = raw.trim().replace(" ", "T");
  const withZone = /(?:Z|[+-]\d\d:?\d\d)$/i.test(iso) ? iso : `${iso}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.valueOf())) throw new Error(`FC 온라인 경기 시각을 읽을 수 없습니다: ${raw}`);
  return date.toISOString();
}

function outcome(value: string): "win" | "draw" | "loss" | "unknown" {
  return value === "승" ? "win" : value === "무" ? "draw" : value === "패" ? "loss" : "unknown";
}

function goals(player: FcoMatchPlayer): number | null {
  const value = player.shoot?.goalTotal;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function displayScore(player: FcoMatchPlayer): number | null {
  const value = player.shoot?.goalTotalDisplay;
  return typeof value === "number" && Number.isFinite(value) ? value : goals(player);
}

/** 제공자 원본과 조회용 요약을 같은 트랜잭션에서 기록한다. 1:1 외 모드는 별도 모델이 필요하다. */
export async function saveFcoMatch(detail: FcoMatchDetail): Promise<"saved" | "unsupported"> {
  if (detail.matchInfo.length !== 2 || detail.matchInfo.some((p) => !p.ouid) || new Set(detail.matchInfo.map(p => p.ouid)).size !== 2) return "unsupported";
  const sql = db();
  const id = `fco:${detail.matchId}`;
  const playedAt = fcoMatchTimestamp(detail.matchDate);
  await sql.begin(async (tx) => {
    const existing = await tx<{ game_code: string }[]>`
      SELECT game_code FROM match WHERE match_id = ${id}
    `;
    if (existing[0] && existing[0].game_code !== "fconline") {
      throw new Error("같은 경기 ID를 다른 게임이 사용하고 있습니다.");
    }
    await tx`
      INSERT INTO match (match_id, game_code, mode_key, game_mode, game_creation, source)
      VALUES (${id}, 'fconline', ${String(detail.matchType)}, ${String(detail.matchType)},
              ${playedAt}, 'provider_api')
      ON CONFLICT (match_id) DO UPDATE SET
        game_creation = EXCLUDED.game_creation, mode_key = EXCLUDED.mode_key
      WHERE match.game_code = 'fconline'
    `;
    await tx`
      INSERT INTO fco_match_detail (match_id, provider_match_id, payload, fetched_at)
      VALUES (${id}, ${detail.matchId}, ${tx.json(detail as unknown as postgres.JSONValue)}, now())
      ON CONFLICT (match_id) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()
    `;
    // Preserve participant identity and side when the provider merely changes array order.
    // The match upsert above holds the parent lock through this transaction.
    const ouids = detail.matchInfo.map(p => p.ouid);
    await tx`DELETE FROM fco_match_participant WHERE match_id = ${id} AND (ouid IS NULL OR NOT (ouid = ANY(${ouids})))`;
    const kept = await tx<{ ouid: string; side_no: number }[]>`SELECT ouid, side_no FROM fco_match_participant WHERE match_id = ${id}`;
    const sides = new Map(kept.map(p => [p.ouid, p.side_no]));
    const used = new Set(kept.map(p => p.side_no));
    for (const player of detail.matchInfo) {
      const side = sides.get(player.ouid) ?? ([1, 2].find(n => !used.has(n))!);
      used.add(side);
      const owner = await tx<{ streamer_id: string }[]>`
        SELECT link.streamer_id FROM streamer_fco_account link
        JOIN streamer s ON s.id = link.streamer_id AND s.visibility = 'public'
        WHERE link.ouid = ${player.ouid} AND link.visibility = 'public'
      `;
      await tx`
        INSERT INTO fco_match_participant
          (match_id, ouid, nickname, streamer_id, side_no, outcome, goals, score_display, division, match_info)
        VALUES (${id}, ${player.ouid}, ${player.nickname}, ${owner[0]?.streamer_id ?? null},
                ${side}, ${outcome(player.matchDetail.matchResult)}, ${goals(player)},
                ${displayScore(player)},
                ${player.division ?? null}, ${tx.json(player as unknown as postgres.JSONValue)})
        ON CONFLICT (match_id, ouid) DO UPDATE SET
          nickname = EXCLUDED.nickname, streamer_id = EXCLUDED.streamer_id,
          side_no = EXCLUDED.side_no, outcome = EXCLUDED.outcome,
          goals = EXCLUDED.goals, score_display = EXCLUDED.score_display,
          division = EXCLUDED.division,
          match_info = EXCLUDED.match_info
      `;
    }
  });
  return "saved";
}

/** 계정 귀속은 명시적인 입력으로만 확정한다. 기존 경기에도 연결을 반영한다. */
export async function linkFcoAccount(input: {
  streamerSlug: string; ouid: string; nickname: string; level: number | null; sourceUrl?: string;
}): Promise<void> {
  const sql = db();
  await sql.begin(async (tx) => {
    const owners = await tx<{ id: string }[]>`
      SELECT id FROM streamer WHERE slug = ${input.streamerSlug} AND visibility = 'public'
    `;
    if (!owners[0]) throw new Error(`스트리머를 찾을 수 없습니다: ${input.streamerSlug}`);
    const existing = await tx<{ streamer_id: string }[]>`
      SELECT streamer_id FROM streamer_fco_account WHERE ouid = ${input.ouid}
    `;
    if (existing[0] && existing[0].streamer_id !== owners[0].id) {
      throw new Error(`OUID가 이미 다른 스트리머(${existing[0].streamer_id})에게 연결돼 있습니다.`);
    }
    await tx`
      INSERT INTO fco_account (ouid, nickname, level, seen_at)
      VALUES (${input.ouid}, ${input.nickname}, ${input.level}, now())
      ON CONFLICT (ouid) DO UPDATE SET nickname = EXCLUDED.nickname,
        level = EXCLUDED.level, seen_at = now()
    `;
    await tx`
      INSERT INTO streamer_fco_account (ouid, streamer_id, source_url)
      VALUES (${input.ouid}, ${owners[0].id}, ${input.sourceUrl ?? null})
      ON CONFLICT (ouid) DO UPDATE SET
        source_url = COALESCE(EXCLUDED.source_url, streamer_fco_account.source_url)
    `;
    await tx`
      UPDATE fco_match_participant SET streamer_id = ${owners[0].id}
       WHERE ouid = ${input.ouid}
    `;
  });
}

/**
 * 대회 경기는 사람이 확인한 matchId만 연결한다. 다른 대회와의 충돌은 거부한다.
 * ★ 사람(admin)이 이 행사에서 뺀 경기는 거부한다 — 되살리려면 force 로 **명시**한다(그러면 admin 의 include 결정을 남겨 공개 값과 결정 이력이 맞는다).
 *   이 함수는 구형 직접 연결 명령(fco:link-event)의 몸체다. 새 연결은 applyFcoMatchContext 를 쓴다.
 */
export async function linkFcoMatchToEvent(input: {
  providerMatchId: string; eventSlug: string; eventName: string;
  sourceUrl: string; force?: boolean;
}): Promise<void> {
  if (!input.sourceUrl.trim()) throw new Error("대회 경기 연결에는 확인 근거 URL이 필요합니다.");
  const sql = db();
  await sql.begin(async (tx) => {
    const game = await tx<{ match_id: string; event_id: string | null; series_id: string | null }[]>`
      SELECT m.match_id, m.event_id, m.series_id FROM match m
      JOIN fco_match_detail d ON d.match_id = m.match_id
      WHERE d.provider_match_id = ${input.providerMatchId} AND m.game_code = 'fconline'
    `;
    if (!game[0]) throw new Error("먼저 해당 FC 온라인 경기를 수집해야 합니다.");
    if (game[0].series_id) throw new Error("시리즈에 속한 경기는 시리즈 event를 연결해야 합니다.");
    const existing = await tx<{ id: string; game_code: string }[]>`
      SELECT id, game_code FROM event WHERE slug = ${input.eventSlug}
    `;
    if (existing[0]?.game_code === "lol") throw new Error("이 slug는 LOL 대회가 사용하고 있습니다.");
    const event = await tx<{ id: string }[]>`
      INSERT INTO event (slug, name, kind, game_code, source_url)
      VALUES (${input.eventSlug}, ${input.eventName}, 'tournament', 'fconline', ${input.sourceUrl})
      ON CONFLICT (slug) DO UPDATE SET
        name = EXCLUDED.name, source_url = COALESCE(event.source_url, EXCLUDED.source_url)
      RETURNING id
    `;
    if (game[0].event_id && game[0].event_id !== event[0].id) {
      throw new Error("경기가 이미 다른 대회에 연결돼 있습니다.");
    }
    if (await isHumanExcluded(tx, event[0].id, game[0].match_id)) {
      if (!input.force) throw new Error("사람이 이 행사에서 제외한 경기다 — 다시 붙이지 않는다. 의도한 것이면 force 로 명시한다.");
      await tx`INSERT INTO fco_event_match_decision (event_id, match_id, decision, note, created_by)
               VALUES (${event[0].id}::uuid, ${game[0].match_id}, 'include', '직접 연결 명령(force)으로 다시 포함', 'admin')`;
    }
    await tx`UPDATE match SET event_id = ${event[0].id}, source_url = ${input.sourceUrl}
              WHERE match_id = ${game[0].match_id}`;
  });
}
