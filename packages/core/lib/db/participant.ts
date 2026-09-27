/**
 * `match_participant` 한 줄을 쓸 때 **반드시 지켜야 하는 것들.**
 *
 * 왜 따로 두나 — 참가자를 쓰는 경로가 둘이다(나무위키 시드 `tournaments.ts` ·
 * VOD 판독/검수 `ck.ts`). 불변식을 각자 구현하면 한쪽에만 들어가고, 그게 정확히
 * 지금까지 생긴 사고의 모양이다. 쓰는 곳이 여럿이면 규칙은 한 곳에 둔다(CLAUDE.md 6).
 */

import type postgres from "postgres";

import { championById, championByName } from "../riot/champions.ts";

type Tx = postgres.TransactionSql;

/** 참가자 한 자리. 두 쓰기 경로가 모양은 달라도 이 세 값으로 불변식을 검사한다. */
export interface ParticipantIdentity {
  participant_id: number;
  puuid?: string | null;
  streamer_id?: string | null;
}

/**
 * 챔피언 이름과 ID 를 **서로 맞춘다.**
 *
 * 둘을 따로 받으면 어긋난 채 저장된다 — 이름만 고치면 화면은 새 챔피언을 보여주는데
 * 집계(`champion_stat` 은 champion_id 로 묶는다)는 옛 챔피언으로 센다.
 * 그래서 하나만 알면 나머지를 표에서 채우고, ⚠ 둘 다 있는데 다르면 **이름을 믿는다** —
 * 판독은 화면의 한글 이름을 읽는 일이고, ID 는 사람이 옮겨 적으면 반드시 틀린다
 * (champions.ts 주석: '제리' 를 895 로 쓸 뻔했고 정답은 221 이었다).
 */
export function resolveChampion(
  id: number | null | undefined,
  name: string | null | undefined,
): { champion_id: number; champion_name: string | null } {
  const found = (name ? championByName(name) : null) ?? (id ? championById(id) : null);
  if (found) return { champion_id: found.id, champion_name: found.en };
  // 표에 없는 이름은 지어내지 않는다. 0 은 '모른다' 이고 champion_stat 이 걸러낸다.
  return { champion_id: id ?? 0, champion_name: name ?? null };
}

/**
 * 계정과 사람이 어긋나는지 본다.
 *
 * ⚠⚠ **조용히 넘기면 검수가 아무 일도 못 한다.** 조우 파생은 사람을 이렇게 고른다 —
 *   `ownerOf.get(puuid) ?? streamer_id` (transform.ts). 즉 **puuid 가 먼저**다.
 *   그래서 puuid 가 A 에게 매핑된 자리에 "이 사람은 B 다" 라고 적어도, 계산은 계속 A 로 간다.
 *   고친 사람은 고쳐졌다고 믿고, 화면은 그대로다.
 *
 * 그때 puuid 를 말없이 지우는 것도 안 된다 — 부계정 오노출은 실제 분쟁이 된다(CLAUDE.md 2).
 * 어느 쪽이 틀렸는지는 사람이 정해야 하므로 **거부하고 말한다.**
 *
 * ⚠ 남은 구멍: puuid 에 **아직 주인이 없으면** 통과한다. 그 계정이 나중에 다른 사람에게
 *   매핑되면 위 순서 때문에 이 자리의 사람이 조용히 바뀐다. 그건 계정 매핑을 만들 때
 *   (`linkAccount`) 잡아야 하는 문제라 여기서는 막지 않는다.
 */
export async function assertIdentityAgrees(tx: Tx, p: ParticipantIdentity): Promise<void> {
  if (!p.puuid || !p.streamer_id) return;
  const rows = await tx<{ streamer_id: string }[]>`
    SELECT streamer_id FROM streamer_account
     WHERE puuid = ${p.puuid} AND active_to IS NULL
  `;
  const owner = rows[0]?.streamer_id;
  if (owner && owner !== p.streamer_id) {
    throw new Error(
      `참가자 ${p.participant_id}: 계정(${p.puuid.slice(0, 12)}…)의 주인은 ${owner} 인데 `
      + `${p.streamer_id} 로 지정했다. 조우 파생은 계정을 먼저 보므로 이대로 저장하면 `
      + `고친 대로 계산되지 않는다. 계정 매핑을 고치거나, 이 자리의 계정을 비우고 사람만 남길 것.`,
    );
  }
}
