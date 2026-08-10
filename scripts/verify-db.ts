/**
 * 스키마와 질의를 **실제로 실행해서** 검증한다.
 *
 * PGlite(WASM Postgres)를 소켓 서버로 띄우고, 거기에 db/migrations 를 전부 적용한 뒤
 * packages/core 의 **진짜 질의 함수**를 그대로 호출한다.
 * "SQL 을 눈으로 읽어 맞는 것 같다"가 아니라 돌려보고 확인하기 위한 것이다.
 *
 *   npm run verify:db
 *
 * 로컬 Postgres 도 도커도 필요 없다. Supabase 프로젝트가 준비되기 전에도 돈다.
 */

import { join } from "node:path";

import { applyAll } from "./lib/migrations.ts";

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
const tournaments = await import("../packages/core/lib/db/tournaments.ts");
const ingestDb = await import("../packages/core/lib/db/ingest.ts");
const { lpAbsolute } = await import("../packages/core/lib/metrics/lp.ts");

try {
  console.log("\n▸ 스키마 적용");
  const applied = await applyAll((sql) => db.exec(sql), ROOT);
  check(`db/migrations 가 순서대로 적용된다 (${applied.length}건)`, true,
    applied.map((m) => m.version).join(" "));

  const tables = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const names = tables.rows.map((r) => r.tablename);
  const expected = [
    "account_candidate", "career_event", "champion_stat", "dead_match", "event",
    "ingest_cursor", "job_run", "match", "match_participant", "rank_snapshot",
    "riot_account", "season_record", "streamer", "streamer_account", "streamer_channel",
    "streamer_encounter",
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
  const s1 = await streamers.createStreamer({ slug: "alpha", display_name: "알파", channel: { channel_id: "alpha" } });
  const s2 = await streamers.createStreamer({ slug: "beta", display_name: "베타", channel: { channel_id: "beta" } });
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
  // 참가자는 10인 전원을 저장한다 — 스트리머 2명 + 일반인.
  // core_public 이 일반인 puuid 를 걸러내는지 확인하려면 실제로 섞여 있어야 한다.
  await sqlClient()`
    INSERT INTO match_participant
      (match_id, puuid, participant_id, team_id, champion_id, win, kills, deaths, assists)
    VALUES ('KR_1', ${puuidA}, 1, 100, 157, true,  5, 2, 7),
           ('KR_1', ${puuidB}, 6, 200, 238, false, 2, 5, 3),
           ('KR_1', ${"n".repeat(78)}, 2, 100, 64, true, 1, 1, 1)
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

  console.log("\n▸ 방송 채널 — 1:N (라이엇 계정과 완전히 별개다)");
  await streamers.upsertStreamerChannel({
    streamer_id: s2.id, platform: "chzzk", channel_id: "beta-chzzk", label: "치지직",
  });
  const chans = await streamers.listStreamerChannels(s2.id);
  check("한 스트리머가 여러 플랫폼 채널을 가진다", chans.length === 2,
    chans.map((c) => `${c.platform}:${c.channel_id}`).join(" "));
  check("대표 채널은 하나뿐이다", chans.filter((c) => c.is_primary).length === 1);
  check("채널 URL 이 플랫폼별로 만들어진다",
    chans.find((c) => c.platform === "chzzk")?.channel_url === "https://chzzk.naver.com/beta-chzzk");

  await expectReject(
    "다른 스트리머의 채널을 조용히 뺏어오지 못한다",
    () => streamers.upsertStreamerChannel({ streamer_id: s1.id, platform: "chzzk", channel_id: "beta-chzzk" }),
    "이미 다른 스트리머",
  );

  console.log("\n▸ core_public — 모듈이 보는 면 (숨긴 데이터가 새면 안 된다)");
  // s1(알파)은 위에서 visibility='hidden' 으로 바뀌었다.
  const pubStreamers = await sqlClient()<{ slug: string }[]>`SELECT slug FROM core_public.streamer ORDER BY slug`;
  check("숨긴 스트리머는 core_public 에서 사라진다",
    pubStreamers.length === 1 && pubStreamers[0].slug === "beta",
    pubStreamers.map((p) => p.slug).join(","));

  const pubAcc = await sqlClient()`SELECT * FROM core_public.streamer_account`;
  check("숨긴 스트리머의 계정도 안 보인다", pubAcc.length === 1, `${pubAcc.length}건`);
  check("★ evidence 는 core_public 에 아예 컬럼이 없다",
    pubAcc.length > 0 && !("evidence" in pubAcc[0]), Object.keys(pubAcc[0] ?? {}).join(","));

  const pubEnc = await sqlClient()`SELECT * FROM core_public.streamer_encounter`;
  check("한쪽이라도 숨겨지면 조우가 사라진다", pubEnc.length === 0, `${pubEnc.length}건`);

  const pubMp = await sqlClient()`SELECT * FROM core_public.match_participant`;
  check("일반인 참가자는 core_public 에 노출되지 않는다", pubMp.length === 1, `${pubMp.length}건`);

  console.log("\n▸ 대회(내전) 기록 — Riot API 로 못 얻는 경기를 수기로 넣는다");
  // 공개 큐 매치는 Riot 이 준 값이 반드시 있어야 한다.
  await expectReject(
    "공개 큐 매치는 game_id 없이 못 들어간다",
    async () => {
      await sqlClient()`
        INSERT INTO match (match_id, queue_id, game_creation, source)
        VALUES ('BAD_1', 420, now(), 'public_queue')
      `;
    },
    "match_public_queue_has_riot_ids",
  );

  const eventId = await tournaments.upsertEvent({
    slug: "verify-cup", name: "검증컵", organizer: "테스트",
    source_url: "https://example.com/tournament",
  });
  check("대회가 등록된다", Boolean(eventId));

  const puuids = await tournaments.mainPuuidsBySlug(["alpha", "beta"]);
  check("slug → 대표 puuid 해석", puuids.size === 2, [...puuids.keys()].join(","));

  await tournaments.saveTournamentGame({
    match_id: "verify-cup:f1",
    event_id: eventId,
    played_at: new Date("2026-08-01T12:00:00Z"),
    duration: 2100,
    source_url: "https://example.com/vod",
    winning_team: 100,
    participants: [
      { puuid: puuids.get("alpha")!, team_id: 100, position: "MIDDLE", champion_id: 157 },
      { puuid: puuids.get("beta")!,  team_id: 200, position: "MIDDLE", champion_id: 238 },
    ],
  });
  check("대회 경기가 game_id 없이 저장된다 (없는 값을 지어내지 않는다)", true);

  const derived = await ingestDb.rederiveEncounters(["verify-cup:f1"]);
  check("★ 대회 경기에서도 조우가 파생된다 — 공개 큐와 같은 경로", derived === 1, `${derived}쌍`);

  const tEnc = await sqlClient()<{ source: string; is_lane_matchup: boolean; relation: string }[]>`
    SELECT source, is_lane_matchup, relation FROM streamer_encounter WHERE match_id = 'verify-cup:f1'
  `;
  check("대회 조우는 source='manual' 로 공개 큐와 분리된다",
    tEnc[0]?.source === "manual", JSON.stringify(tEnc[0]));
  // 대회 경기는 큐가 커스텀(0)이지만 협곡 5v5 이고, 포지션이 Riot 추론값이 아니라
  // 주최측 로스터라 맞라인으로 센다. 같은 MIDDLE 끼리 붙었으니 참이어야 한다.
  check("★ 대회 경기도 포지션이 명시돼 있으면 맞라인으로 센다",
    tEnc[0]?.is_lane_matchup === true, JSON.stringify(tEnc[0]));
  check("반대 팀이면 opponent", tEnc[0]?.relation === "opponent");

  await tournaments.saveTournamentGame({
    match_id: "verify-cup:nopos",
    event_id: eventId,
    played_at: new Date("2026-08-01T13:00:00Z"),
    duration: 1900,
    source_url: "https://example.com/vod",
    winning_team: 100,
    participants: [
      { puuid: puuids.get("alpha")!, team_id: 100 },
      { puuid: puuids.get("beta")!, team_id: 200 },
    ],
  });
  await ingestDb.rederiveEncounters(["verify-cup:nopos"]);
  const noPos = await sqlClient()<{ is_lane_matchup: boolean }[]>`
    SELECT is_lane_matchup FROM streamer_encounter WHERE match_id = 'verify-cup:nopos'
  `;
  check("포지션을 모르는 대회 경기는 맞라인으로 세지 않는다 (§11-10 — 애매하면 판정하지 않는다)",
    noPos[0]?.is_lane_matchup === false, JSON.stringify(noPos[0]));

  // ── 다전제: 세트와 매치를 나눠 셀 수 있는가 (마이그레이션 0007) ──────
  //
  // 3판 2선승을 2:1 로 이기면 **세트 2승 1패 · 매치 1승 0패** 다. 이 둘이 한 질의에서
  // 같이 나와야 한다. 하나로 뭉치면 둘 다 틀린다 — 세트만 세면 다전제 한 판이
  // 단판 세 번과 같아지고, 매치만 세면 진 쪽이 딴 세트가 사라진다.
  const setWinners: (100 | 200)[] = [100, 200, 100]; // alpha 팀이 2:1 로 이긴 시리즈
  for (const [i, w] of setWinners.entries()) {
    await tournaments.saveTournamentGame({
      match_id: `verify-cup:bo3s${i + 1}`,
      event_id: eventId,
      played_at: new Date(`2026-08-0${2 + i}T12:00:00Z`),
      duration: 1800,
      source_url: "https://example.com/vod",
      series_id: "verify-cup:bo3",
      series_game_no: i + 1,
      winning_team: w,
      participants: [
        { puuid: puuids.get("alpha")!, team_id: 100, position: "MIDDLE", champion_id: 157 },
        { puuid: puuids.get("beta")!, team_id: 200, position: "MIDDLE", champion_id: 238 },
      ],
    });
  }
  await ingestDb.rederiveEncounters(setWinners.map((_, i) => `verify-cup:bo3s${i + 1}`));

  // 앞에서 알파를 hidden 으로 바꿔놨다(그 자체가 다른 검사다). core_public 은 숨은
  // 스트리머를 안 보여주는 게 맞으므로, 집계 의미를 보려면 잠깐 되돌렸다가 다시 숨긴다.
  await sqlClient()`UPDATE streamer SET visibility = 'public' WHERE slug = 'alpha'`;

  const bo3 = await sqlClient()<{ sets: number; set_wins: number; matches: number; match_wins: number }[]>`
    WITH e AS (
      -- 쌍은 streamer_id 순으로 정규화돼 있어서 a 가 알파라는 보장이 없다.
      -- '알파 기준' 으로 보려면 어느 쪽이 알파인지 확인하고 골라야 한다.
      SELECT se.series_key,
             CASE WHEN sa.slug = 'alpha' THEN se.a_win ELSE se.b_win END AS alpha_win
        FROM core_public.streamer_encounter se
        JOIN core_public.streamer sa ON sa.streamer_id = se.streamer_a_id
       WHERE se.match_id LIKE 'verify-cup:bo3s%'
    ), s AS (
      SELECT series_key, count(*)::int AS sets, count(*) FILTER (WHERE alpha_win)::int AS a_sets
        FROM e GROUP BY series_key
    )
    SELECT (SELECT count(*) FROM e)::int                             AS sets,
           (SELECT count(*) FILTER (WHERE alpha_win) FROM e)::int    AS set_wins,
           count(*)::int                                             AS matches,
           count(*) FILTER (WHERE a_sets * 2 > sets)::int            AS match_wins
      FROM s
  `;
  check("★ 다전제 2:1 은 세트로 2승 1패 (3세트)",
    bo3[0]?.sets === 3 && bo3[0]?.set_wins === 2, JSON.stringify(bo3[0]));
  check("★ 같은 다전제가 매치로는 1승 0패 (1경기)",
    bo3[0]?.matches === 1 && bo3[0]?.match_wins === 1, JSON.stringify(bo3[0]));

  const single = await sqlClient()<{ n: number }[]>`
    SELECT count(DISTINCT series_key)::int AS n
      FROM core_public.streamer_encounter WHERE match_id = 'verify-cup:f1'
  `;
  check("단판은 자기 자신이 곧 시리즈다 — 공개 큐도 같은 식으로 집계된다",
    single[0]?.n === 1, JSON.stringify(single[0]));

  await sqlClient()`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'alpha'`;
  const hiddenAgain = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM core_public.streamer_encounter WHERE match_id LIKE 'verify-cup:%'
  `;
  check("숨긴 스트리머의 다전제도 core_public 에서 통째로 사라진다",
    hiddenAgain[0]?.n === 0, JSON.stringify(hiddenAgain[0]));

  let seriesRejected = false;
  try {
    await sqlClient()`
      INSERT INTO match (match_id, queue_id, game_creation, winning_team, source, series_id)
      VALUES ('verify-cup:halfseries', 0, now(), 100, 'manual', 'verify-cup:x')
    `;
  } catch {
    seriesRejected = true;
  }
  check("series_id 만 있고 세트 번호가 없으면 거부한다 (집계가 조용히 틀어진다)", seriesRejected);

  const bySource = await sqlClient()<{ source: string; n: number }[]>`
    SELECT source, count(*)::int AS n FROM streamer_encounter GROUP BY source ORDER BY source
  `;
  check("조우를 source 로 항상 가를 수 있다 (§11-7)",
    bySource.length === 2, bySource.map((b) => `${b.source}:${b.n}`).join(" "));

  const again = await ingestDb.rederiveEncounters(["verify-cup:f1"]);
  check("다시 파생해도 늘지 않는다 (멱등)", again === 1);
} finally {
  await closeDb();
  await server.stop();
  await db.close();
}

console.log(failures === 0 ? "\n전부 통과.\n" : `\n${failures}건 실패.\n`);
process.exit(failures === 0 ? 0 : 1);
