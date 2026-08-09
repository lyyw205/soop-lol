/**
 * 로컬 개발용 임시 Postgres.
 *
 * Supabase 프로젝트가 없어도 화면을 띄워 볼 수 있게, PGlite(WASM Postgres)를
 * 진짜 포트에 물려 준다. 스키마를 적용하고 시드 몇 줄을 넣은 뒤 계속 떠 있는다.
 *
 *   npm run dev:db          # 터미널 1
 *   npm run dev             # 터미널 2 (apps/web/.env.local 에 아래 두 줄)
 *
 * ⚠️ **메모리 DB다. 끄면 전부 사라진다.** 실제 데이터는 Supabase 로 간다.
 *
 * ⚠️ **DATABASE_POOL_MAX=1 이 필수다.**
 *   PGlite 소켓 서버는 동시 연결을 받지 못한다 — 커넥션이 2개가 되는 순간
 *   `read ECONNRESET` 으로 죽는다. 앱 코드의 문제가 아니라 이 하네스의 한계다.
 *   (실제 Postgres 에서는 Promise.all 로 병렬 질의하는 게 맞고, 그대로 둔다)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { applyAll } from "./lib/migrations.ts";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const ROOT = join(import.meta.dirname, "..");
const PORT = Number(process.env.DEV_DB_PORT ?? 5433);

const db = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
await applyAll((sql) => db.exec(sql), ROOT);

if (process.env.DEV_DB_SEED !== "0") {
  await db.exec(`
    INSERT INTO streamer (slug, display_name, platform_user_id, channel_url, is_pro, aliases)
    VALUES
      ('sample_a', '샘플 스트리머 A', 'sample_a', 'https://ch.sooplive.co.kr/sample_a', false, ARRAY['샘플에이']),
      ('sample_b', '샘플 스트리머 B', 'sample_b', 'https://ch.sooplive.co.kr/sample_b', true,  ARRAY['샘플비']);

    INSERT INTO riot_account (puuid, game_name, tag_line, summoner_level)
    VALUES
      (repeat('a', 78), '샘플에이', 'KR1', 412),
      (repeat('b', 78), '샘플비',   'KR1', 388);

    INSERT INTO streamer_account (streamer_id, puuid, label, is_main, confidence, evidence)
    SELECT s.id, repeat('a', 78), '본계', true, 'verified',
           '{"source":"broadcast_notice","url":"https://example.com/proof"}'::jsonb
      FROM streamer s WHERE s.slug = 'sample_a';

    INSERT INTO streamer_account (streamer_id, puuid, label, is_main, confidence, evidence)
    SELECT s.id, repeat('b', 78), '본계', true, 'likely',
           '{"source":"community_post","note":"커뮤니티 정리글 기준 — 재확인 필요"}'::jsonb
      FROM streamer s WHERE s.slug = 'sample_b';

    INSERT INTO rank_snapshot (puuid, queue_type, snapshot_date, tier, division, league_points, wins, losses)
    VALUES
      (repeat('a', 78), 'RANKED_SOLO_5x5', current_date, 'DIAMOND', 'I', 42, 120, 104),
      (repeat('b', 78), 'RANKED_SOLO_5x5', current_date, 'MASTER',  'I', 213, 240, 198);

    INSERT INTO career_event (streamer_id, title, placement, role)
    SELECT s.id, '2026 SOOP 멸망전', '준우승', '선수' FROM streamer s WHERE s.slug = 'sample_b';

    INSERT INTO ingest_cursor (puuid) VALUES (repeat('a', 78)), (repeat('b', 78));
  `);
}

const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
await server.start();

console.log(`임시 Postgres 준비됨 (메모리, 끄면 사라짐)`);
console.log(`apps/web/.env.local 에 아래 두 줄을 넣고 npm run dev:`);
console.log(`  DATABASE_URL=postgres://postgres@127.0.0.1:${PORT}/postgres`);
console.log(`  DATABASE_POOL_MAX=1   # ★ PGlite 는 동시 연결을 못 받는다. 빼면 ECONNRESET`);

const shutdown = async () => {
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
