/**
 * 낡은 `puuid` 를 현재 값으로 갈아끼운다.
 *
 *   npm run repair:puuid              # 확인만 한다 (기본값 — 아무것도 안 바꾼다)
 *   npm run repair:puuid -- --apply   # 실제로 옮긴다
 *
 * ★ 무슨 일이 있었나
 *   저장된 puuid 로 Riot 을 부르면 `400 Exception decrypting` 이 난다. 형식은 78자로
 *   멀쩡한데 **이 키로는 못 푸는 값**이라는 뜻이다. 계정 104개 중 44개가 이 상태였고,
 *   그동안 그 사람들의 경기는 공개 큐든 내전이든 **한 건도 안 들어오고 있었다.**
 *
 *   Development 키가 24시간마다 바뀌는 것과 맞물린 것으로 보인다(추정).
 *   원인이 무엇이든 대응은 같다 — Riot ID 로 다시 풀어서 갈아끼운다.
 *
 * ★ 값만 바꾸면 안 된다
 *   `puuid` 는 `riot_account` 의 PK 이고 여섯 테이블이 이 값을 들고 있다.
 *   김민교 한 명만 해도 `match_participant` 146건이 매달려 있어서, 값을 덮어쓰면
 *   그 146건이 주인 없는 행이 된다. **새 행을 만들고 → 참조를 옮기고 → 옛 행을 지운다**,
 *   이 셋이 한 트랜잭션 안에서 끝나야 한다.
 *
 * ★ 한 번 쓰고 버릴 스크립트가 아니다
 *   키가 또 바뀌면 또 깨진다. 워커에도 같은 복구를 붙이기 전까지는 이걸 주기적으로 돌린다.
 */

import { closeDb, db } from "@soop-lol/core/lib/db/client";
import { RiotClient } from "@soop-lol/core/lib/riot/client";

const apply = process.argv.includes("--apply");
const riot = new RiotClient({ apiKey: process.env.RIOT_API_KEY ?? "" });
if (!process.env.RIOT_API_KEY) {
  console.error("RIOT_API_KEY 가 없다. apps/web/.env.local 을 확인해라.");
  process.exit(1);
}

/** `puuid` 를 들고 있는 테이블 전부. 하나라도 빠뜨리면 그 데이터가 끊긴다. */
const REFERENCES = [
  { table: "streamer_account", column: "puuid" },
  { table: "rank_snapshot", column: "puuid" },
  { table: "ingest_cursor", column: "puuid" },
  { table: "match_participant", column: "puuid" },
  { table: "account_candidate", column: "puuid" },
  { table: "streamer_encounter", column: "a_puuid" },
  { table: "streamer_encounter", column: "b_puuid" },
] as const;

const sql = db();
try {
  const rows = await sql<
    { display_name: string; puuid: string; game_name: string | null; tag_line: string | null }[]
  >`
    SELECT s.display_name, a.puuid, ra.game_name, ra.tag_line
      FROM streamer_account a
      JOIN streamer s ON s.id = a.streamer_id
      JOIN riot_account ra ON ra.puuid = a.puuid
     ORDER BY s.display_name
  `;
  console.log(`계정 ${rows.length}개 검사${apply ? "" : "  (확인만 — 아무것도 바꾸지 않는다)"}\n`);

  let ok = 0;
  const moved: string[] = [];
  const failed: string[] = [];

  for (const r of rows) {
    // 지금 값으로 조회가 되면 건드릴 이유가 없다.
    const alive = await riot.matchIds(r.puuid, { count: 1 }).then(() => true).catch(() => false);
    if (alive) { ok++; continue; }

    if (!r.game_name || !r.tag_line) {
      failed.push(`${r.display_name} — Riot ID 가 없어 다시 풀 수 없다`);
      continue;
    }
    const acc = await riot.accountByRiotId(r.game_name, r.tag_line).catch(() => null);
    if (!acc?.puuid) {
      failed.push(`${r.display_name} (${r.game_name}#${r.tag_line}) — Riot ID 로도 안 풀린다`);
      continue;
    }
    if (acc.puuid === r.puuid) {
      // 값은 같은데 조회가 안 된다 — puuid 문제가 아니다. 건드리면 안 된다.
      failed.push(`${r.display_name} — 값은 그대로인데 조회가 안 된다 (다른 원인)`);
      continue;
    }
    const works = await riot.matchIds(acc.puuid, { count: 1 }).then(() => true).catch(() => false);
    if (!works) {
      failed.push(`${r.display_name} — 새 puuid 로도 조회가 안 된다`);
      continue;
    }

    const label = `${r.display_name} (${r.game_name}#${r.tag_line})`;
    if (!apply) { moved.push(`${label} — 옮길 수 있다`); continue; }

    try {
      await sql.begin(async (tx) => {
        // 1) 새 puuid 로 행을 만든다. 옛 행의 값을 그대로 복사한다.
        await tx`
          INSERT INTO riot_account (
            puuid, game_name, tag_line, platform_region, routing_region,
            summoner_id, summoner_level, profile_icon_id, revision_date,
            last_profile_synced_at, last_rank_synced_at, last_match_synced_at, is_active
          )
          SELECT ${acc.puuid}, game_name, tag_line, platform_region, routing_region,
                 summoner_id, summoner_level, profile_icon_id, revision_date,
                 last_profile_synced_at, last_rank_synced_at, last_match_synced_at, is_active
            FROM riot_account WHERE puuid = ${r.puuid}
          ON CONFLICT (puuid) DO NOTHING
        `;
        // 2) 참조를 전부 옮긴다.
        for (const ref of REFERENCES) {
          await tx.unsafe(
            `UPDATE ${ref.table} SET ${ref.column} = $1 WHERE ${ref.column} = $2`,
            [acc.puuid, r.puuid],
          );
        }
        // 3) 옛 행을 지운다. 참조가 남아 있으면 여기서 FK 가 막아 준다 — 그게 안전망이다.
        await tx`DELETE FROM riot_account WHERE puuid = ${r.puuid}`;
      });
      moved.push(`${label} — 옮겼다`);
    } catch (e) {
      failed.push(`${label} — 옮기다 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log(`정상 ${ok}개 · ${apply ? "옮김" : "옮길 수 있음"} ${moved.length}개 · 실패 ${failed.length}개\n`);
  for (const m of moved) console.log(`  ${m}`);
  if (failed.length) {
    console.log(`\n⚠ 손대지 못한 것 ${failed.length}개 — 사람이 봐야 한다:`);
    for (const f of failed) console.log(`   ${f}`);
  }
  if (!apply && moved.length > 0) {
    console.log(`\n실제로 옮기려면:  npm run repair:puuid -- --apply`);
  }
} finally {
  await closeDb();
}
