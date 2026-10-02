/**
 * 낡은 puuid 를 새 puuid 로 갈아끼운다 — scripts/repair-puuid.ts 가 계정마다 한 트랜잭션으로 부른다.
 *
 * ★ 새 행을 만들고 → 참조를 옮기고 → 옛 행을 지운다. 값만 덮으면 참조가 주인 없는 행이 된다.
 *
 * ★★ 검수 완료를 지켜야 한다.
 *   `match_participant.puuid` 가 바뀌면 트리거(0043 `participant_review_values`)가 그 경기의 완료를 풀고
 *   변경 번호를 올린다. 그런데 puuid 교체는 **같은 사람의 암호화 값만 바뀌는 일**이라 경기 내용이 달라진 게 아니다.
 *   2026-10-02 에 이걸 모르고 44개를 옮겨 **사람이 완료한 442경기가 한꺼번에 풀렸다**(review_change 에 남은 완료 기록으로 복구).
 *   그래서 옮기기 전의 완료 시각·변경 번호를 잡아 두었다가 옮긴 뒤 그대로 되돌린다.
 *   (같은 트랜잭션 안이라 밖에서는 완료가 풀린 순간이 보이지 않는다.)
 */

import type postgres from "postgres";

/** `puuid` 를 들고 있는 테이블 전부. 하나라도 빠뜨리면 그 데이터가 끊긴다. */
export const PUUID_REFERENCES = [
  { table: "streamer_account", column: "puuid" },
  { table: "rank_snapshot", column: "puuid" },
  { table: "ingest_cursor", column: "puuid" },
  { table: "match_participant", column: "puuid" },
  { table: "account_candidate", column: "puuid" },
  { table: "streamer_encounter", column: "a_puuid" },
  { table: "streamer_encounter", column: "b_puuid" },
] as const;

export async function repointPuuid(
  tx: postgres.TransactionSql,
  oldPuuid: string,
  newPuuid: string,
): Promise<{ preserved_reviews: number }> {
  // 1) 새 puuid 로 행을 만든다. 옛 행의 값을 그대로 복사한다.
  await tx`
    INSERT INTO riot_account (
      puuid, game_name, tag_line, platform_region, routing_region,
      summoner_id, summoner_level, profile_icon_id, revision_date,
      last_profile_synced_at, last_rank_synced_at, last_match_synced_at, is_active
    )
    SELECT ${newPuuid}, game_name, tag_line, platform_region, routing_region,
           summoner_id, summoner_level, profile_icon_id, revision_date,
           last_profile_synced_at, last_rank_synced_at, last_match_synced_at, is_active
      FROM riot_account WHERE puuid = ${oldPuuid}
    ON CONFLICT (puuid) DO NOTHING
  `;

  // 2) 옮기기 전에 이 계정이 낀 완료 경기의 상태를 잡아 둔다. 옮기는 도중 다른 저장이 끼지 못하게 잠근다.
  const completed = await tx<{ match_id: string; review_completed_at: Date; review_version: number }[]>`
    SELECT m.match_id, m.review_completed_at, m.review_version
      FROM match m
     WHERE m.game_code = 'lol' AND m.review_completed_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM match_participant p WHERE p.match_id = m.match_id AND p.puuid = ${oldPuuid})
     ORDER BY m.match_id
       FOR UPDATE OF m
  `;

  // 3) 참조를 전부 옮긴다.
  for (const ref of PUUID_REFERENCES) {
    await tx.unsafe(`UPDATE ${ref.table} SET ${ref.column} = $1 WHERE ${ref.column} = $2`, [newPuuid, oldPuuid]);
  }

  // 4) 트리거가 푼 완료를 되돌린다. review_* 두 칸만 바꾸므로 값 트리거는 다시 울리지 않는다.
  for (const m of completed) {
    await tx`UPDATE match SET review_completed_at = ${m.review_completed_at}, review_version = ${m.review_version}
              WHERE match_id = ${m.match_id}`;
  }

  // 5) 옛 행을 지운다. 참조가 남아 있으면 여기서 FK 가 막아 준다 — 그게 안전망이다.
  await tx`DELETE FROM riot_account WHERE puuid = ${oldPuuid}`;
  return { preserved_reviews: completed.length };
}
