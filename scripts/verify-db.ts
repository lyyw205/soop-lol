/**
 * 스키마와 질의를 **실제로 실행해서** 검증한다.
 *
 * PGlite(WASM Postgres)를 소켓 서버로 띄우고, 거기에 db/schema.sql 을 적용한 뒤
 * packages/core 의 **진짜 질의 함수**를 그대로 호출한다.
 * "SQL 을 눈으로 읽어 맞는 것 같다"가 아니라 돌려보고 확인하기 위한 것이다.
 *
 *   npm run verify:db
 *
 * 로컬 Postgres 도 도커도 필요 없다. Supabase 프로젝트가 준비되기 전에도 돈다.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const ROOT = join(import.meta.dirname, "..");
const PORT = Number(process.env.VERIFY_DB_PORT ?? 5433);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function expectReject(name: string, fn: () => Promise<unknown>, expected: string) {
  try {
    await fn();
    check(name, false, "거부되어야 하는데 통과했다");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    check(name, message.includes(expected), message.includes(expected) ? "" : message);
  }
}

const db = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
const server = new PGLiteSocketServer({ db, port: PORT, host: "127.0.0.1" });
await server.start();
process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;

// core 는 import 시점이 아니라 호출 시점에 DATABASE_URL 을 읽으므로 순서는 안전하다.
const { db: sqlClient, closeDb } = await import("../packages/core/lib/db/client.ts");
const streamers = await import("../packages/core/lib/db/streamers.ts");
const { lpAbsolute } = await import("../packages/core/lib/metrics/lp.ts");

try {
  console.log("\n▸ 스키마 적용");
  await db.exec(readFileSync(join(ROOT, "db", "schema.sql"), "utf8"));
  check("db/schema.sql 이 오류 없이 적용된다", true);

  const tables = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const names = tables.rows.map((r) => r.tablename);
  const expected = [
    "account_candidate", "career_event", "champion_stat", "dead_match", "event",
    "ingest_cursor", "job_run", "match", "match_participant", "rank_snapshot",
    "riot_account", "season_record", "streamer", "streamer_account", "streamer_encounter",
  ];
  const missing = expected.filter((t) => !names.includes(t));
  check(`테이블 ${expected.length}개가 모두 생성된다`, missing.length === 0, missing.join(", "));

  console.log("\n▸ lp_absolute — SQL 과 TS 가 같은 값을 낸다");
  const grid: { tier: string; division: string; lp: number }[] = [];
  for (const tier of ["IRON", "BRONZE", "SILVER", "GOLD", "PLATINUM", "EMERALD", "DIAMOND"]) {
    for (const division of ["IV", "III", "II", "I"]) {
      for (const lp of [0, 37, 99]) grid.push({ tier, division, lp });
    }
  }
  for (const tier of ["MASTER", "GRANDMASTER", "CHALLENGER"]) {
    for (const lp of [0, 213, 1500]) grid.push({ tier, division: "I", lp });
  }
  let mismatches = 0;
  for (const g of grid) {
    const res = await db.query<{ v: number }>("SELECT lol_lp_absolute($1, $2, $3) AS v", [
      g.tier, g.division, g.lp,
    ]);
    const ts = lpAbsolute({ tier: g.tier, division: g.division, leaguePoints: g.lp });
    if (res.rows[0].v !== ts) {
      mismatches++;
      if (mismatches <= 3) console.log(`      ${g.tier} ${g.division} ${g.lp}: SQL=${res.rows[0].v} TS=${ts}`);
    }
  }
  check(`${grid.length}개 조합 전부 일치`, mismatches === 0, mismatches ? `${mismatches}개 불일치` : "");

  const unranked = await db.query<{ v: number | null }>("SELECT lol_lp_absolute(NULL, NULL, NULL) AS v");
  check("언랭은 NULL", unranked.rows[0].v === null);

  console.log("\n▸ 제약 — 잘못된 데이터를 실제로 거부한다");
  const s1 = await streamers.createStreamer({ slug: "alpha", display_name: "알파", platform_user_id: "alpha" });
  const s2 = await streamers.createStreamer({ slug: "beta", display_name: "베타", platform_user_id: "beta" });
  check("스트리머가 생성된다", Boolean(s1.id && s2.id));

  await expectReject(
    "같은 slug 는 거부한다",
    () => streamers.createStreamer({ slug: "alpha", display_name: "중복" }),
    "duplicate key",
  );

  await expectReject(
    "근거 없는 계정 매핑은 거부한다",
    () => streamers.linkAccount({
      streamer_id: s1.id, puuid: "p".repeat(78), confidence: "likely", evidence: {},
    }),
    "근거",
  );

  const puuidA = "a".repeat(78);
  const puuidB = "b".repeat(78);
  await streamers.upsertRiotAccount({ puuid: puuidA, game_name: "알파본계", tag_line: "KR1" });
  await streamers.upsertRiotAccount({ puuid: puuidB, game_name: "베타본계", tag_line: "KR1" });
  await streamers.linkAccount({
    streamer_id: s1.id, puuid: puuidA, is_main: true, confidence: "verified",
    evidence: { source: "broadcast_notice", url: "https://example.com/proof" },
  });
  await streamers.linkAccount({
    streamer_id: s2.id, puuid: puuidB, is_main: true, confidence: "likely",
    evidence: { note: "방송에서 본인이 화면에 띄움" },
  });
  check("근거가 있으면 매핑된다", true);

  await expectReject(
    "한 계정을 두 스트리머가 동시에 못 가진다",
    () => streamers.linkAccount({
      streamer_id: s2.id, puuid: puuidA, confidence: "unverified",
      evidence: { note: "잘못된 매핑 시도" },
    }),
    "streamer_account_one_owner_idx",
  );

  const cursors = await sqlClient()`SELECT puuid FROM ingest_cursor ORDER BY puuid`;
  check("매핑하면 백필 대기열에 자동 등록된다", cursors.length === 2, `${cursors.length}건`);

  console.log("\n▸ streamer_encounter — 쌍 정규화");
  await sqlClient()`
    INSERT INTO match (match_id, platform_id, game_id, queue_id, game_creation, winning_team)
    VALUES ('KR_1', 'KR', 1, 420, now(), 100)
  `;
  const [lo, hi] = [s1.id, s2.id].sort();
  await sqlClient()`
    INSERT INTO streamer_encounter
      (match_id, streamer_a_id, streamer_b_id, a_puuid, b_puuid, relation,
       a_win, b_win, queue_id, source, game_creation)
    VALUES ('KR_1', ${lo}::uuid, ${hi}::uuid, ${puuidA}, ${puuidB}, 'opponent',
            true, false, 420, 'public_queue', now())
  `;
  check("정렬된 쌍은 저장된다", true);

  await expectReject(
    "역순 쌍(a > b)은 CHECK 가 거부한다",
    async () => {
      await sqlClient()`
        INSERT INTO streamer_encounter
          (match_id, streamer_a_id, streamer_b_id, a_puuid, b_puuid, relation,
           a_win, b_win, queue_id, source, game_creation)
        VALUES ('KR_1', ${hi}::uuid, ${lo}::uuid, ${puuidB}, ${puuidA}, 'opponent',
                false, true, 420, 'public_queue', now())
      `;
    },
    "encounter_ordered",
  );

  console.log("\n▸ 관리자 질의가 실제로 돈다");
  const counts = await streamers.adminCounts();
  check("adminCounts", counts.streamers === 2 && counts.accounts === 2 && counts.encounters === 1,
    JSON.stringify(counts));

  const list = await streamers.listStreamers();
  check("listStreamers", list.length === 2 && list.every((s) => s.account_count === 1),
    list.map((s) => `${s.display_name}:${s.account_count}`).join(" "));

  const searched = await streamers.listStreamers({ q: "알파" });
  check("listStreamers 검색(한글)", searched.length === 1 && searched[0].slug === "alpha");

  const accounts = await streamers.listStreamerAccounts(s1.id);
  check("listStreamerAccounts", accounts.length === 1 && accounts[0].is_main === true &&
    accounts[0].game_name === "알파본계" && accounts[0].evidence.url === "https://example.com/proof");

  await sqlClient()`
    INSERT INTO rank_snapshot (puuid, queue_type, snapshot_date, tier, division, league_points)
    VALUES (${puuidA}, 'RANKED_SOLO_5x5', current_date, 'DIAMOND', 'I', 42)
  `;
  const withRank = await streamers.listStreamerAccounts(s1.id);
  check("최신 티어가 조인된다 (생성 컬럼 포함)",
    withRank[0].tier === "DIAMOND" && withRank[0].lp_absolute === 2400 + 300 + 42,
    `lp_absolute=${withRank[0].lp_absolute}`);

  await streamers.addCareerEvent({ streamer_id: s1.id, title: "2026 SOOP 멸망전", placement: "준우승" });
  const career = await streamers.listCareerEvents(s1.id);
  check("커리어 수기 입력", career.length === 1 && career[0].placement === "준우승");

  const updated = await streamers.updateStreamer(s1.id, { visibility: "hidden" });
  check("updateStreamer 가 RETURNING 으로 확인한다", updated?.visibility === "hidden");
  const ghost = await streamers.updateStreamer("00000000-0000-0000-0000-000000000000", { note: "x" });
  check("없는 행을 고치면 null 을 돌려준다", ghost === null);
} finally {
  await closeDb();
  await server.stop();
  await db.close();
}

console.log(failures === 0 ? "\n전부 통과.\n" : `\n${failures}건 실패.\n`);
process.exit(failures === 0 ? 0 : 1);
