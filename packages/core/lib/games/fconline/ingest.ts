import { db } from "../../db/client.ts";
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
