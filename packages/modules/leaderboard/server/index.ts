/**
 * 리더보드 모듈 — 참조 구현.
 *
 * 이 모듈이 존재하는 이유의 절반은 "계약이 실제로 지켜지는지 보여주는 것"이다.
 * 여기서 하는 일은 전부 계약 안에서만 이뤄진다:
 *   · core 는 `@soop-lol/core/lib/contract` 로만 읽는다
 *   · 쓰기는 mod_leaderboard 스키마에만 한다
 *   · 다른 모듈을 모른다
 *
 * 이벤트 구독이 아니라 **재계산**이다. 새로 꽂아도 과거가 저절로 채워지고,
 * 두 번 돌려도 같은 결과가 나온다 (docs/ARCHITECTURE.md §왜 이벤트 버스가 아닌가).
 */

import { latestRanks, listPublicStreamers, moduleDb } from "@soop-lol/core/lib/contract";

const SCHEMA = "mod_leaderboard";

export interface Standing {
  streamer_id: string;
  rank_no: number;
  display_name: string;
  slug: string;
  puuid: string;
  tier: string | null;
  division: string | null;
  league_points: number | null;
  lp_absolute: number | null;
}

/**
 * 순위를 다시 만든다. 멱등이다.
 *
 * 한 스트리머가 계정을 여러 개 가지면 **가장 높은 계정**으로 대표한다.
 * 부계정이 리더보드에 따로 뜨면 같은 사람이 두 줄을 차지한다.
 */
export async function recompute(queueType = "RANKED_SOLO_5x5"): Promise<number> {
  const sql = moduleDb(SCHEMA);
  const [ranks, streamers] = await Promise.all([latestRanks(queueType), listPublicStreamers()]);
  const known = new Set(streamers.map((s) => s.streamer_id));

  const best = new Map<string, (typeof ranks)[number]>();
  for (const r of ranks) {
    if (!known.has(r.streamer_id) || r.lp_absolute === null) continue;
    const cur = best.get(r.streamer_id);
    if (!cur || (cur.lp_absolute ?? -1) < r.lp_absolute) best.set(r.streamer_id, r);
  }

  const ordered = [...best.values()].sort((a, b) => (b.lp_absolute ?? 0) - (a.lp_absolute ?? 0));

  await sql.begin(async (tx) => {
    await tx`DELETE FROM mod_leaderboard.standing WHERE queue_type = ${queueType}`;
    for (const [i, r] of ordered.entries()) {
      await tx`
        INSERT INTO mod_leaderboard.standing
          (streamer_id, queue_type, rank_no, puuid, tier, division, league_points, lp_absolute)
        VALUES (${r.streamer_id}::uuid, ${queueType}, ${i + 1}, ${r.puuid},
                ${r.tier}, ${r.division}, ${r.league_points}, ${r.lp_absolute})
      `;
    }
  });

  return ordered.length;
}

/** 화면이 읽는 것. 표시용 이름은 core 에서 가져와 붙인다. */
export async function listStandings(queueType = "RANKED_SOLO_5x5", limit = 100): Promise<Standing[]> {
  const sql = moduleDb(SCHEMA);
  const rows = await sql<Omit<Standing, "display_name" | "slug">[]>`
    SELECT streamer_id, rank_no, puuid, tier, division, league_points, lp_absolute
      FROM mod_leaderboard.standing
     WHERE queue_type = ${queueType}
     ORDER BY rank_no
     LIMIT ${limit}
  `;
  const byId = new Map((await listPublicStreamers()).map((s) => [s.streamer_id, s]));
  return rows.flatMap((r) => {
    const s = byId.get(r.streamer_id);
    // 숨김 처리된 스트리머는 core_public 에서 사라진다 → 화면에서도 조용히 빠진다.
    return s ? [{ ...r, display_name: s.display_name, slug: s.slug }] : [];
  });
}
