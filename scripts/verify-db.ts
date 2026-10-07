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
import { verifyReviewRecordUpgrade } from "./lib/verify-review-record-migration.ts";
import { verifyPuuidMoveDb } from "./lib/verify-puuid-move-db.ts";
import { verifyScheduleDb } from "./lib/verify-schedule-db.ts";

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
const publicDb = await import("../packages/core/lib/db/public.ts");
const personalDb = await import("../packages/core/lib/db/personal.ts");
const ck = await import("../packages/core/lib/db/ck.ts");
const { ensureMatchSeries } = await import("../packages/core/lib/db/series.ts");
const { lpAbsolute } = await import("../packages/core/lib/metrics/lp.ts");
const { MATCH_CATEGORIES, matchCategory } = await import("../packages/core/lib/metrics/category.ts");

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
    "match_series", "review_record", "riot_account", "streamer", "streamer_account", "streamer_channel",
    "streamer_encounter",
  ];
  const missing = expected.filter((t) => !names.includes(t));
  check(`테이블 ${expected.length}개가 모두 생성된다`, missing.length === 0, missing.join(", "));
  await verifyReviewRecordUpgrade();

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

  // ── 경기 분류 ───────────────────────────────────────────────────
  //   화면 필터(전체 / 솔로랭크 / 내전 / 대회 …)의 기준이라, SQL 과 TS 가 어긋나면
  //   "내전만" 을 눌렀는데 대회가 섞여 나오는 식으로 **조용히** 거짓말을 한다.
  //   lp_absolute 와 같은 이유로 전 조합을 대조한다.
  console.log("\n▸ match_category — SQL 과 TS 가 같은 값을 낸다");
  const sources = ["public_queue", "tournament_code", "manual", "??"];
  const queues = [420, 440, 450, 2400, 400, 430, 480, 490, 700, 3130, 0, 1700, 1750, 900, null];
  const kinds = [null, "ck", "land", "scrim", "tournament", "showmatch", "other", "??"];
  let catMismatch = 0, catCombos = 0;
  for (const source of sources) {
    for (const queue_id of queues) {
      for (const event_kind of kinds) {
       for (const game_mode of [null, "CUSTOM", "CLASSIC", "ARAM", "CHERRY", "URF"]) {
        catCombos++;
        const res = await db.query<{ v: string }>(
          "SELECT lol_match_category($1, $2, $3, $4) AS v", [source, queue_id, event_kind, game_mode]);
        const ts = matchCategory({ source, queue_id, event_kind, game_mode });
        if (res.rows[0].v !== ts) {
          catMismatch++;
          if (catMismatch <= 3) {
            console.log(`      ${source}/${queue_id}/${event_kind}: SQL=${res.rows[0].v} TS=${ts}`);
          }
        }
      }
    }
  }
  }
  check(`${catCombos}개 조합 전부 일치`, catMismatch === 0, catMismatch ? `${catMismatch}개 불일치` : "");
  // 분류값이 우리가 아는 목록 안에 있어야 한다 — SQL 이 오타로 새 값을 내면 필터에서 통째로 사라진다.
  const known = new Set(MATCH_CATEGORIES.map((c) => c.key));
  const stray = await db.query<{ v: string }>(
    `SELECT DISTINCT lol_match_category(s, q, k) AS v
       FROM unnest(ARRAY['public_queue','tournament_code','manual']) s,
            unnest(ARRAY[420,440,450,400,430,490,700,3130,0]) q,
            unnest(ARRAY[NULL,'ck','land','scrim','tournament','showmatch','other']) k`);
  check("SQL 이 내는 값이 전부 알려진 분류다",
    stray.rows.every((r) => known.has(r.v as never) && r.v !== "all"),
    stray.rows.map((r) => r.v).join(","));

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
    INSERT INTO match (match_id, game_code, platform_id, riot_game_id, queue_id, mode_key,
                       game_creation, winning_team)
    VALUES ('KR_1', 'lol', 'KR', 1, 420, '420', now(), 100)
  `;
  // 참가자는 10인 전원을 저장한다 — 스트리머 2명 + 일반인.
  // core_public 이 일반인 puuid 를 걸러내는지 확인하려면 실제로 섞여 있어야 한다.
  await sqlClient()`
    INSERT INTO match_participant
      (match_id, puuid, participant_id, team_id, champion_id, outcome, kills, deaths, assists)
    VALUES ('KR_1', ${puuidA}, 1, 100, 157, 'win',  5, 2, 7),
           ('KR_1', ${puuidB}, 6, 200, 238, 'loss', 2, 5, 3),
           ('KR_1', ${"n".repeat(78)}, 2, 100, 64, 'win', 1, 1, 1)
  `;
  const [lo, hi] = [s1.id, s2.id].sort();
  await sqlClient()`
    INSERT INTO streamer_encounter
      (match_id, streamer_a_id, streamer_b_id, a_puuid, b_puuid, relation,
       a_outcome, b_outcome, game_code, queue_id, mode_key, source, game_creation)
    VALUES ('KR_1', ${lo}::uuid, ${hi}::uuid, ${puuidA}, ${puuidB}, 'opponent',
            'win', 'loss', 'lol', 420, '420', 'public_queue', now())
  `;
  check("정렬된 쌍은 저장된다", true);

  await expectReject(
    "역순 쌍(a > b)은 CHECK 가 거부한다",
    async () => {
      await sqlClient()`
        INSERT INTO streamer_encounter
          (match_id, streamer_a_id, streamer_b_id, a_puuid, b_puuid, relation,
           a_outcome, b_outcome, game_code, queue_id, mode_key, source, game_creation)
        VALUES ('KR_1', ${hi}::uuid, ${lo}::uuid, ${puuidB}, ${puuidA}, 'opponent',
                'loss', 'win', 'lol', 420, '420', 'public_queue', now())
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

  const betaSoop = chans.find((c) => c.platform === "soop");
  const vodHint = betaSoop
    ? await streamers.setStreamerChannelVodAvailability(betaSoop.id, "usually_unavailable")
    : null;
  check("VOD 보존 성향은 사람 메모가 아니라 채널별 운영 힌트로 남는다",
    vodHint?.vod_availability === "usually_unavailable" && vodHint.vod_availability_checked_at !== null,
    JSON.stringify(vodHint));

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

  const pubChannels = await sqlClient()`SELECT * FROM core_public.streamer_channel`;
  check("VOD 보존 성향은 내부 조사 힌트라 core_public 에 노출되지 않는다",
    pubChannels.length > 0 && pubChannels.every((c) => !("vod_availability" in c)),
    Object.keys(pubChannels[0] ?? {}).join(","));

  const pubEnc = await sqlClient()`SELECT * FROM core_public.streamer_encounter`;
  check("한쪽이라도 숨겨지면 조우가 사라진다", pubEnc.length === 0, `${pubEnc.length}건`);

  const pubMp = await sqlClient()`SELECT * FROM core_public.match_participant`;
  check("일반인 참가자는 core_public 에 노출되지 않는다", pubMp.length === 1, `${pubMp.length}건`);
  check("공개 참가자에 빌드 칸(아이템·스펠·핵심 룬)이 있다 — 룬 원본 JSON 은 없다(0069)",
    pubMp.length > 0 && ["items", "summoner1_id", "keystone_id", "sub_style_id"].every((k) => k in pubMp[0]) && !("perks" in pubMp[0]),
    Object.keys(pubMp[0] ?? {}).join(","));

  // 0069: 10자리 라인업 — 신원 칸이 아예 없고, 숨긴 사람·일반인 자리는 익명(streamer_id 없음)
  const lineup = await sqlClient()<{ streamer_id: string | null }[]>`SELECT * FROM core_public.match_lineup`;
  check("★ 라인업에는 puuid·인게임명 칸이 아예 없다",
    lineup.length > 0 && !("puuid" in lineup[0]) && !("observed_name" in lineup[0]), Object.keys(lineup[0] ?? {}).join(","));
  const hiddenIds = (await sqlClient()<{ id: string }[]>`SELECT id FROM streamer WHERE visibility <> 'public'`).map((r) => r.id);
  check("★ 숨긴 스트리머 자리는 라인업에서 익명이다(streamer_id 없음)",
    lineup.every((r) => r.streamer_id == null || !hiddenIds.includes(r.streamer_id)), `${lineup.length}자리`);

  console.log("\n▸ 대회(내전) 기록 — Riot API 로 못 얻는 경기를 수기로 넣는다");
  // 공개 큐 매치는 Riot 이 준 값이 반드시 있어야 한다.
  await expectReject(
    "공개 큐 매치는 riot_game_id 없이 못 들어간다",
    async () => {
      await sqlClient()`
        INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, source)
        VALUES ('BAD_1', 'lol', 420, '420', now(), 'public_queue')
      `;
    },
    "match_public_queue_has_riot_ids",
  );

  const eventId = await tournaments.ensureEvent({
    slug: "verify-cup", name: "검증컵", kind: "tournament", organizer: "테스트",
    source_url: "https://example.com/tournament",
  });
  check("대회가 등록된다", Boolean(eventId));

  const puuids = await tournaments.mainPuuidsBySlug(["alpha", "beta"]);
  check("slug → 대표 puuid 해석", puuids.size === 2, [...puuids.keys()].join(","));

  await tournaments.saveTournamentGame({
    match_id: "verify-cup:f1",
    event_id: eventId,
    series_id: "verify-cup:f1", series_game_no: 1, played_at_precision: "datetime",
    played_at: new Date("2026-08-01T12:00:00Z"),
    duration: 2100,
    source_url: "https://example.com/vod",
    winning_team: 100,
    participants: [
      { puuid: puuids.get("alpha")!, team_id: 100, position: "MIDDLE", champion_id: 157 },
      { puuid: puuids.get("beta")!,  team_id: 200, position: "MIDDLE", champion_id: 238 },
    ],
  });
  check("대회 경기가 riot_game_id 없이 저장된다 (없는 값을 지어내지 않는다)", true);

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
    series_id: "verify-cup:nopos", series_game_no: 1, played_at_precision: "datetime",
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

  // ── 무승부: 2세트제 조별리그(2014~2017)는 1:1 로 끝나는 경기가 있다 ──
  //
  // 세트 단위로는 무승부가 없다(각 세트는 누군가 이긴다). 시리즈로 접었을 때만 생긴다.
  // 이걸 패로 세면 2014~2017 전적이 통째로 틀어진다.
  for (const [i, w] of ([100, 200] as const).entries()) {
    await tournaments.saveTournamentGame({
      match_id: `verify-cup:draw${i + 1}`,
      event_id: eventId,
      played_at: new Date(`2026-08-1${i}T12:00:00Z`),
      duration: 1800,
      source_url: "https://example.com/vod",
      series_id: "verify-cup:draw",
      series_game_no: i + 1,
      played_at_precision: "datetime",
      winning_team: w,
      participants: [
        { puuid: puuids.get("alpha")!, team_id: 100, position: "MIDDLE" },
        { puuid: puuids.get("beta")!, team_id: 200, position: "MIDDLE" },
      ],
    });
  }
  await ingestDb.rederiveEncounters(["verify-cup:draw1", "verify-cup:draw2"]);

  await sqlClient()`UPDATE streamer SET visibility = 'public' WHERE slug = 'alpha'`;
  const drawRow = await sqlClient()<{ sets: number; wins: number; draws: number }[]>`
    WITH e AS (
      SELECT se.series_key,
             CASE WHEN sa.slug = 'alpha' THEN se.a_outcome ELSE se.b_outcome END = 'win' AS alpha_win
        FROM core_public.streamer_encounter se
        JOIN core_public.streamer sa ON sa.streamer_id = se.streamer_a_id
       WHERE se.match_id LIKE 'verify-cup:draw%'
    ), s AS (
      SELECT series_key, count(*)::int AS sets, count(*) FILTER (WHERE alpha_win)::int AS a_sets
        FROM e GROUP BY series_key
    )
    SELECT sum(sets)::int AS sets,
           count(*) FILTER (WHERE a_sets * 2 > sets)::int AS wins,
           count(*) FILTER (WHERE a_sets * 2 = sets)::int AS draws
      FROM s
  `;
  check("★ 1:1 로 끝난 다전제는 무승부다 (패로 세지 않는다)",
    drawRow[0]?.sets === 2 && drawRow[0]?.wins === 0 && drawRow[0]?.draws === 1,
    JSON.stringify(drawRow[0]));
  // 개인 기록은 조우 상대 수와 무관하게 경기 하나를 한 번만 센다.
  const personalRows = await personalDb.listPersonalMatches(s1.id, {category: "tournament", year: 2026});
  const personalStats = await personalDb.listPersonalRecords(s1.id, {category: "tournament", year: 2026});
  check("개인 기록: 대회 4세트를 3경기로 집계하고 무승부를 보존한다",
    personalRows.length === 3 && personalStats[0]?.matches === 3 && personalStats[0]?.sets === 4
      && personalStats[0]?.wins === 2 && personalStats[0]?.draws === 1 && personalStats[0]?.losses === 0,
    JSON.stringify(personalStats));
  const latestPersonal = await personalDb.listPersonalMatches(s1.id, {category: "tournament", limit: 1});
  const nextPersonal = await personalDb.listPersonalMatches(s1.id, {category: "tournament", limit: 1, offset: 1});
  check("개인 기록: LIMIT이 다전제 세트를 자르지 않고 페이지가 중복되지 않는다",
    latestPersonal[0]?.sets === 2 && latestPersonal[0]?.set_wins === 1
      && latestPersonal[0]?.series_key !== nextPersonal[0]?.series_key);
  check("개인 히스토리: 로스터를 조회할 세트 ID를 경기마다 한 번씩 보존한다",
    personalRows.every((game) => game.match_ids.length === game.sets
      && new Set(game.match_ids).size === game.sets)
      && latestPersonal[0]?.match_ids.length === 2
      && !latestPersonal[0]?.match_ids.some((id) => nextPersonal[0]?.match_ids.includes(id)));
  const publicContract = await import("../packages/core/lib/contract/index.ts");
  const pairEncounters = await publicContract.listEncountersBetween(s1.id, s2.id);
  const laneCount = pairEncounters.filter((g) => g.relation === "opponent" && g.is_lane_matchup).length;
  const lanePairs = await publicContract.listPublicPairs(20, true);
  const lanePair = lanePairs.find((p) => [p.a_slug, p.b_slug].includes("alpha") && [p.a_slug, p.b_slug].includes("beta"));
  check("자주 만난 매치업: 검색한 스트리머가 저장된 쌍의 어느 쪽이든 본인의 상대를 찾는다",
    (await publicContract.listPublicPairs(1, true, "alpha"))[0]?.lane_sets === laneCount
      && (await publicContract.listPublicPairs(1, true, "beta"))[0]?.lane_sets === laneCount);
  const noEncounters = await streamers.createStreamer({ slug: "no-encounters", display_name: "기록 없음" });
  try {
    check("자주 만난 매치업: 검색한 스트리머의 기록이 없으면 전체 인기 쌍으로 대체하지 않는다",
      (await publicContract.listPublicPairs(1, true, "no-encounters")).length === 0);
  } finally {
    await sqlClient()`DELETE FROM streamer WHERE id = ${noEncounters.id}::uuid`;
  }
  check("자주 만난 매치업: 포지션 불명·다른 라인·같은 팀 세트를 집계에서 제외한다",
    laneCount > 0 && laneCount < pairEncounters.length
      && lanePair?.sets === laneCount && lanePair.vs_sets === laneCount && lanePair.lane_sets === laneCount);
  const laneMatchIds = pairEncounters.filter((g) => g.is_lane_matchup).map((g) => g.match_id);
  try {
    await sqlClient()`UPDATE streamer_encounter SET is_lane_matchup = false WHERE match_id = ANY(${laneMatchIds})`;
    check("자주 만난 매치업: 맞라인 기록이 없는 쌍은 제외하지만 일반 맞대결 목록에는 남는다",
      !(await publicContract.listPublicPairs(20, true)).some((p) => [p.a_slug, p.b_slug].includes("alpha") && [p.a_slug, p.b_slug].includes("beta"))
        && (await publicContract.listPublicPairs()).some((p) => [p.a_slug, p.b_slug].includes("alpha") && [p.a_slug, p.b_slug].includes("beta")));
  } finally {
    await ingestDb.rederiveEncounters(laneMatchIds);
  }
  const [opponentVisibility] = await sqlClient()`SELECT visibility FROM streamer WHERE slug = 'beta'`;
  await sqlClient()`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'beta'`;
  const withoutPublicOpponent = await personalDb.listPersonalMatches(s1.id, {category: "tournament", year: 2026});
  const personalRosters = await publicContract.listMatchRosters(withoutPublicOpponent.flatMap((game) => game.match_ids));
  check("개인 히스토리: 상대가 비공개여도 본인 경기는 남고 상대 이름은 로스터에서 제외한다",
    withoutPublicOpponent.length === personalRows.length && personalRosters.every((player) => player.streamer_id !== s2.id));
  await sqlClient()`UPDATE streamer SET visibility = ${opponentVisibility.visibility} WHERE slug = 'beta'`;
  check("개인 기록: CK 필터는 대회 기록을 포함하지 않는다",
    (await personalDb.listPersonalRecords(s1.id, {category: "ck"})).length === 0);
  check("개인 기록: 빈 연도는 기록 없음으로 반환한다",
    (await personalDb.listPersonalMatches(s1.id, {year: 1999})).length === 0);
  check("개인 기록: 경기 연도를 찾는다", (await personalDb.listPersonalYears(s1.id)).includes(2026));
  await sqlClient()`UPDATE match SET game_creation = '2025-12-31T16:00:00Z' WHERE match_id = 'verify-cup:f1'`;
  await ingestDb.rederiveEncounters(["verify-cup:f1"]);
  check("개인 기록·상대 목록은 한국 시간 연도 경계를 공유한다",
    (await personalDb.listPersonalMatches(s1.id, {year: 2026})).some((m) => m.series_key === "verify-cup:f1")
      && !(await personalDb.listPersonalMatches(s1.id, {year: 2025})).some((m) => m.series_key === "verify-cup:f1")
      && (await publicDb.listOpponentGames(s1.id, 2026)).some((m) => m.match_id === "verify-cup:f1")
      && (await publicDb.listOpponents(s1.id, {year: 2026, category: "tournament"}))[0]?.vs_sets === 4);
  await sqlClient()`UPDATE match SET game_creation = '2026-08-01T12:00:00Z' WHERE match_id = 'verify-cup:f1'`;
  await ingestDb.rederiveEncounters(["verify-cup:f1"]);
  check("상대 목록: CK 필터와 상세 이력의 범위가 같다",
    (await publicDb.listOpponents(s1.id, {category: "ck"})).length === 0
      && (await publicDb.listOpponentGames(s1.id, undefined, "ck")).length === 0);
  await sqlClient()`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'alpha'`;
  check("개인 기록: 숨긴 스트리머의 통계·이력은 노출하지 않는다",
    (await personalDb.listPersonalRecords(s1.id)).length === 0
      && (await personalDb.listPersonalMatches(s1.id)).length === 0);

  // ── 대회 팀 (마이그레이션 0008) ──────────────────────────────────────
  const teamIds = await tournaments.saveEventTeams(eventId, [
    { name: "알파팀", members: [{ streamer_id: s1.id, position: "MIDDLE" }] },
    { name: "베타팀", members: [{ streamer_id: s2.id, position: "MIDDLE" }] },
  ]);
  check("대회 팀과 명단이 저장된다", teamIds.size === 2, [...teamIds.keys()].join(","));

  // 한 사람이 한 대회에서 두 팀에 속하면 대회 성적이 두 줄로 갈라진다. 못 하게 막혀 있어야 한다.
  let twoTeamsRejected = false;
  try {
    await sqlClient()`
      INSERT INTO event_team_member (event_id, event_team_id, streamer_id)
      VALUES (${eventId}::uuid, ${teamIds.get("베타팀")!}::uuid, ${s1.id}::uuid)
    `;
  } catch {
    twoTeamsRejected = true;
  }
  check("★ 한 사람이 한 대회에서 두 팀에 속할 수 없다", twoTeamsRejected);

  // 다른 대회의 팀에 붙이는 것도 막혀야 한다 (event_id 가 어긋나면 성적이 엉뚱한 대회로 간다)
  const otherEventId = await tournaments.ensureEvent({
    slug: "verify-cup-2", name: "검증컵 2회", kind: "tournament", source_url: "https://example.com/2",
  });
  let crossEventRejected = false;
  try {
    await sqlClient()`
      INSERT INTO event_team_member (event_id, event_team_id, streamer_id)
      VALUES (${otherEventId}::uuid, ${teamIds.get("알파팀")!}::uuid, ${s2.id}::uuid)
    `;
  } catch {
    crossEventRejected = true;
  }
  check("다른 대회의 팀에 명단을 붙일 수 없다", crossEventRejected);

  const teamsAfter = await tournaments.saveEventTeams(eventId, [
    { name: "알파팀", members: [{ streamer_id: s1.id, position: "MIDDLE" }] },
  ]);
  const remaining = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM event_team WHERE event_id = ${eventId}::uuid
  `;
  check("이번 시드에 없는 팀은 지운다 (시드가 그 대회의 전부다)",
    teamsAfter.size === 1 && remaining[0]?.n === 1, JSON.stringify(remaining[0]));

  // 성적 조회가 팀명을 붙여서 돌려주는지
  await tournaments.saveEventTeams(eventId, [
    { name: "알파팀", members: [{ streamer_id: s1.id, position: "MIDDLE" }] },
    { name: "베타팀", members: [{ streamer_id: s2.id, position: "MIDDLE" }] },
  ]);
  const evRecords = await publicDb.listStreamerEvents(s2.id);
  check("★ 스트리머별 대회 성적이 팀명과 함께 나온다",
    evRecords.length >= 1 && evRecords[0]?.team_name === "베타팀", JSON.stringify(evRecords[0]));

  const filtered = await publicDb.listStreamerEvents(s2.id, 1999);
  check("연도 필터가 걸린다", filtered.length === 0, `${filtered.length}건`);

  // ── 순위 (마이그레이션 0010) ────────────────────────────────────────
  await tournaments.saveEventTeams(eventId, [
    { name: "알파팀", placement: "우승", placement_rank: 1,
      members: [{ streamer_id: s1.id, position: "MIDDLE" }] },
    { name: "베타팀", placement: "4강", placement_rank: 4,
      members: [{ streamer_id: s2.id, position: "MIDDLE" }] },
  ]);
  const withPlace = await publicDb.listStreamerEvents(s2.id);
  check("대회 성적에 순위가 함께 나온다",
    withPlace[0]?.placement === "4강" && withPlace[0]?.placement_rank === 4,
    JSON.stringify(withPlace[0]));

  const tally = await publicDb.summarizePlacements(s2.id);
  const semi = tally.buckets.find((b) => b.key === "semi");
  check("★ 순위별 횟수가 집계된다", semi?.count === 1 && tally.total === 1, JSON.stringify(tally));

  // 순위를 모르는 대회는 합계에 슬쩍 섞이면 안 된다
  await tournaments.saveEventTeams(otherEventId, [
    { name: "무명팀", members: [{ streamer_id: s2.id }] },
  ]);
  const tally2 = await publicDb.summarizePlacements(s2.id);
  check("★ 순위를 모르는 대회는 따로 센다 (합계에 섞지 않는다)",
    tally2.unknown === 1 && tally2.total === 2 &&
      tally2.buckets.reduce((n, b) => n + b.count, 0) === 1,
    JSON.stringify(tally2));

  // ★ 예선에서 떨어져 **한 경기도 안 한** 참가도 성적이다.
  //
  //   멸망전은 예선 참가팀이 30~40개인데 본선에 오르는 건 8~12개다. 한때 결과표에
  //   나온 팀만 적재했더니 예선 탈락한 회차가 통째로 사라졌고, 화면에서는 그 사람이
  //   아예 출전하지 않은 것처럼 보였다. 0경기는 '기록 없음' 이 아니라 '떨어졌다' 다.
  await tournaments.saveEventTeams(otherEventId, [
    { name: "예선팀", placement: "1차예선 탈락", placement_rank: 99,
      members: [{ streamer_id: s2.id }] },
  ]);
  const noGame = (await publicDb.listStreamerEvents(s2.id)).find((r) => r.team_name === "예선팀");
  check("★ 경기가 0건이어도 예선 탈락한 회차는 성적에 남는다",
    // 저장할 때 표기를 통일한다('1차예선' → '1차 예선', normalizePlacement)
    noGame?.placement === "1차 예선 탈락" && noGame?.matches === 0 && noGame?.sets === 0,
    JSON.stringify(noGame));

  const tally3 = await publicDb.summarizePlacements(s2.id);
  check("★ 예선 탈락도 횟수로 집계된다",
    tally3.buckets.find((b) => b.key === "qualifier")?.count === 1 && tally3.unknown === 0,
    JSON.stringify(tally3));

  // ★ 올스타전·이벤트 매치는 우승 숫자에서 뺀다(0052). 참가 수에는 넣고, 따로 센다.
  await db.query("UPDATE event SET counts_toward_titles = false WHERE id = $1::uuid", [otherEventId]);
  await tournaments.saveEventTeams(otherEventId, [
    { name: "올스타팀", placement: "우승", placement_rank: 1, members: [{ streamer_id: s2.id }] },
  ]);
  const tally4 = await publicDb.summarizePlacements(s2.id);
  check("★ 올스타전·이벤트전 우승은 우승 숫자에 안 들어가고 따로 센다(참가 수에는 들어간다)",
    tally4.buckets.find((b) => b.key === "champion")?.count === 0 && tally4.exhibition.champion === 1 && tally4.total === 2,
    JSON.stringify(tally4));
  check("대회 성적 목록에는 그대로 나오고 표시 칸이 있다",
    (await publicDb.listStreamerEvents(s2.id)).some((r) => r.team_name === "올스타팀" && r.counts_toward_titles === false));
  await db.query("UPDATE event SET counts_toward_titles = true WHERE id = $1::uuid", [otherEventId]);

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
      played_at_precision: "datetime",
      best_of: 3,
      best_of_evidence: "검증컵 규정 Bo3",
      winning_team: w,
      participants: [
        { puuid: puuids.get("alpha")!, team_id: 100, position: "MIDDLE", champion_id: 157 },
        { puuid: puuids.get("beta")!, team_id: 200, position: "MIDDLE", champion_id: 238 },
      ],
    });
  }
  await ingestDb.rederiveEncounters(setWinners.map((_, i) => `verify-cup:bo3s${i + 1}`));

  const [bo3Format] = await sqlClient()<{
    event_id: string | null; best_of: number | null; best_of_evidence: string | null;
  }[]>`
    SELECT event_id, best_of, best_of_evidence FROM match_series WHERE id='verify-cup:bo3'
  `;
  check("★ best_of는 세트마다 복제되지 않고 시리즈 한 행에 저장된다",
    bo3Format?.event_id === eventId && bo3Format.best_of === 3
      && bo3Format.best_of_evidence === "검증컵 규정 Bo3", JSON.stringify(bo3Format));
  const publicBo3 = await sqlClient()<{ n: number; best_of: number | null }[]>`
    SELECT count(*)::int AS n, min(best_of)::int AS best_of
      FROM core_public.match WHERE series_id='verify-cup:bo3'
  `;
  check("★ 공개 계약은 같은 시리즈의 모든 세트에 best_of를 실어 준다",
    publicBo3[0]?.n === 3 && publicBo3[0]?.best_of === 3, JSON.stringify(publicBo3[0]));
  await expectReject("짝수 best_of는 DB가 거부한다", async () => {
    await sqlClient()`INSERT INTO match_series (id, game_code, best_of, best_of_evidence)
      VALUES ('verify:bad-even', 'lol', 2, '잘못된 fixture')`;
  }, "match_series_best_of_check");
  await expectReject("근거 없는 best_of는 DB가 거부한다", async () => {
    await sqlClient()`INSERT INTO match_series (id, game_code, best_of)
      VALUES ('verify:bad-evidence', 'lol', 3)`;
  }, "match_series_best_of_has_evidence");
  await expectReject("같은 시리즈의 best_of를 다른 값으로 조용히 덮지 않는다", async () => {
    await tournaments.saveTournamentGame({
      match_id: "verify-cup:bo3-conflict", event_id: eventId,
      played_at: new Date("2026-08-05T12:00:00Z"), duration: 1800,
      source_url: "https://example.com/vod", series_id: "verify-cup:bo3", series_game_no: 4,
      played_at_precision: "datetime",
      best_of: 5, best_of_evidence: "상충하는 fixture", winning_team: 100,
      participants: [
        { puuid: puuids.get("alpha")!, team_id: 100, position: "MIDDLE" },
        { puuid: puuids.get("beta")!, team_id: 200, position: "MIDDLE" },
      ],
    });
  }, "이미 3");
  await sqlClient()`INSERT INTO match_series (id, game_code) VALUES ('verify:fco-series', 'fconline')`;
  await expectReject("다른 게임의 시리즈에 LoL 세트를 넣을 수 없다", async () => {
    await sqlClient()`
      INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, source, origin,
                         series_id, series_game_no)
      VALUES ('verify:wrong-game-series', 'lol', 0, '0', now(), 'manual', 'admin',
              'verify:fco-series', 1)
    `;
  }, "match_series_fk");

  // 앞에서 알파를 hidden 으로 바꿔놨다(그 자체가 다른 검사다). core_public 은 숨은
  // 스트리머를 안 보여주는 게 맞으므로, 집계 의미를 보려면 잠깐 되돌렸다가 다시 숨긴다.
  await sqlClient()`UPDATE streamer SET visibility = 'public' WHERE slug = 'alpha'`;

  const bo3 = await sqlClient()<{ sets: number; set_wins: number; matches: number; match_wins: number }[]>`
    WITH e AS (
      -- 쌍은 streamer_id 순으로 정규화돼 있어서 a 가 알파라는 보장이 없다.
      -- '알파 기준' 으로 보려면 어느 쪽이 알파인지 확인하고 골라야 한다.
      SELECT se.series_key,
             CASE WHEN sa.slug = 'alpha' THEN se.a_outcome ELSE se.b_outcome END = 'win' AS alpha_win
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
      INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, winning_team,
                         source, series_id)
      VALUES ('verify-cup:halfseries', 'lol', 0, '0', now(), 100, 'manual', 'verify-cup:x')
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

  console.log("\n▸ CK 조사 — VOD 스캔 단서·근거 프레임 (0019)");

  // 앞 절이 alpha 를 숨겨 뒀다. 이 절은 공개면 필터를 재므로 되돌려 놓는다.
  await sqlClient()`UPDATE streamer SET visibility = 'public' WHERE slug = 'alpha'`;

  const leadId = await ck.upsertEventLead({
    source: "vod_title", source_key: "vod:9990001",
    title: "검증배 CK", channel_id: "alpha_ch", observed_at: new Date("2026-09-20T20:00:00Z"),
    raw: { whisper_hint: "1세트 알파팀 승" }, state: "new",
  });
  check("VOD 스캔 단서가 쌓인다", Boolean(leadId));

  const leadIdAgain = await ck.upsertEventLead({
    source: "vod_title", source_key: "vod:9990001",
    title: "검증배 CK(갱신)", channel_id: "alpha_ch", observed_at: new Date("2026-09-20T20:00:00Z"),
    raw: { whisper_hint: "1세트 알파팀 승" }, state: "confirmed",
  });
  check("같은 VOD를 다시 스캔해도 새 행이 안 생긴다 (source+source_key 중복 방지)", leadIdAgain === leadId);

  // ── 스캔 실행 기록 — 재시도·누락 방지용. 승인 게이트가 아니다
  //   ★ 요청 범위 · 대표 샘플 · 실제 연 지점 · 못 본 구간을 **따로** 적는다 (계획 §5).
  await ck.markLeadScan(leadId, {
    status: "done",
    requested: [[0, 18000]],
    sampled: [[0, 18000]],
    probes: { planned: [0, 600, 1200], extra: [640] },
    opened: [0, 600, 640],
    transcript_read: [[600, 900]],
    failed: [[17000, 18000]],
    signals: ["pixel", "asr"],
    version: "v1",
  });
  const scanned = await ck.getEventLead(leadId);
  check("★ raw.scan 은 병합된다 — 다른 경로가 적어 둔 단서를 덮지 않는다",
    scanned?.raw.scan?.status === "done" && scanned?.raw.whisper_hint === "1세트 알파팀 승",
    JSON.stringify(scanned?.raw.whisper_hint));
  check("★★ 대표 샘플과 실제로 연 지점을 따로 적는다 (샘플 몇 장이 '전체 정밀 확인'으로 읽히면 안 된다)",
    scanned?.raw.scan?.sampled?.length === 1 && scanned?.raw.scan?.opened?.length === 3
      && scanned?.raw.scan?.probes?.extra?.length === 1,
    JSON.stringify({ sampled: scanned?.raw.scan?.sampled, opened: scanned?.raw.scan?.opened }));
  check("★ 실제로 본문을 읽은 전사 구간이 따로 남는다 (파일 생성·키워드 검색은 읽은 게 아니다)",
    scanned?.raw.scan?.transcript_read?.length === 1);

  // ★ 단서를 다시 긁어도 스캔 기록이 살아 있어야 한다. 덮으면 "다시 처리해야 하나" 의
  //   근거가 사라진다 — raw 를 통째로 대입하던 판에서 실제로 지워졌다.
  await ck.upsertEventLead({
    source: "vod_title", source_key: "vod:9990001",
    title: "검증배 CK(제목만 갱신)", channel_id: "alpha_ch",
    observed_at: new Date("2026-09-20T20:00:00Z"), state: "confirmed",
  });
  const afterReupsert = await ck.getEventLead(leadId);
  check("★★ 단서를 다시 긁어도 raw.scan(실행 기록)이 살아남는다",
    afterReupsert?.raw.scan?.status === "done" && afterReupsert?.title === "검증배 CK(제목만 갱신)",
    JSON.stringify(afterReupsert?.raw));

  // ── 프레임: VOD 하나에 경기가 여럿이다
  const frames = await ck.recordEvidenceFrames(leadId, [
    { frame_path: "out/ck/2026-09-20/f1.jpg", at_sec: 120, kind: "roster", note: "1경기 로딩화면", read: true },
    { frame_path: "out/ck/2026-09-20/f2.jpg", at_sec: 340, kind: "result", note: "1경기 결과창", read: true },
    { frame_path: "out/ck/2026-09-20/f3.jpg", at_sec: 4200, kind: "result", note: "2경기 결과창", read: true },
    // 뽑기만 하고 안 읽은 프레임
    { frame_path: "out/ck/2026-09-20/f4.jpg", at_sec: 5000, kind: "other" },
    // 메모는 있는데 열어 봤다는 표시(read)가 없다 — 메모가 읽음을 켜면 안 된다
    { frame_path: "out/ck/2026-09-20/f5.jpg", at_sec: 5100, kind: "other", note: "제목만 보고 적은 메모" },
  ]);
  check("프레임을 기록하면 만든 행(id)을 돌려준다 — 그 id 로 경기에 잇는다",
    frames.length === 5 && frames.every((f) => Boolean(f.id) && f.match_id === null));
  check("★★ 메모는 읽음을 켜지 않는다 — 열어 봤는지는 read 가 따로 말한다",
    frames[4].read_at === null, JSON.stringify(frames[4].read_at));
  // 이후 절은 이 VOD 의 프레임을 4장으로 센다 — 메모 시험용 프레임은 지운다.
  await sqlClient()`DELETE FROM match_evidence_frame WHERE id = ${frames[4].id}::uuid`;
  frames.pop();

  check("★★ 뽑은 것과 읽은 것이 다르다 — 추출만 된 프레임은 '읽음'이 아니다",
    frames[1].read_at !== null && frames[3].read_at === null,
    JSON.stringify(frames.map((f) => [f.at_sec, f.read_at !== null])));

  const reread = await ck.recordEvidenceFrames(leadId, [
    { frame_path: "out/ck/2026-09-20/f4.jpg", at_sec: 5000, kind: "other" },
  ]);
  const framesAfterRerun = await ck.listEvidenceFrames(leadId);
  check("★ 같은 프레임을 다시 기록해도 행이 늘지 않는다 (재실행이 근거를 중복 생성하지 않는다)",
    framesAfterRerun.length === 4 && reread[0].id === frames[3].id, `${framesAfterRerun.length}장`);

  await ck.recordEvidenceFrames(leadId, [
    { frame_path: "out/ck/2026-09-20/f4.jpg", at_sec: 5000, kind: "other", note: "열어 봤더니 로비 화면", read: true },
  ]);
  const afterRead = await ck.listEvidenceFrames(leadId);
  check("★ 판독한 쪽이 read 로 '읽음'을 표시한다 (ck:merge 는 scan.opened 로 채운다)",
    afterRead.find((f) => f.id === frames[3].id)?.read_at !== null);

  // ── 후보: 경기가 안 된 조사 결과도 남는다 (계획 §5)
  const cands = await ck.mergeLeadCandidates(leadId, [
    {
      // 경기가 아직 없어 결론은 미해결이다 — '경기 반영' 은 어느 경기인지 있어야 적는다.
      id: "c1", at: [100, 400], conclusion: "unresolved",
      observed: "로딩화면 10명 + 결과창 점수판", why: "결과창에서 승패·챔피언을 다 읽었다",
      evidence_frame_ids: [frames[0].id, frames[1].id],
    },
    {
      id: "c2", at: [4000, 4400], conclusion: "unresolved",
      observed: "결과창이 그래프 탭이라 승패만 보인다",
      why: "로스터를 못 읽어 경기로 못 넣었다",
      open_questions: ["다른 참가자 시점에 점수판이 있는지"],
    },
    {
      id: "c3", at: [9000, 9600], conclusion: "not_target",
      observed: "LCK 중계 오버레이 · 프로 선수 이름", why: "시청 구간이다",
    },
  ]);
  check("★★ 후보 결론이 남는다 — 경기가 안 된 것도 조사 결과다", cands.candidates.length === 3);
  check("후보는 시각 순으로 정렬된다 (타임라인이 그대로 쓴다)",
    cands.candidates.map((c) => c.id).join(",") === "c1,c2,c3", cands.candidates.map((c) => c.id).join(","));
  const leadReviews = await sqlClient()<{
    type: string; body: string; candidate_id: string | null; frame_id: string | null;
  }[]>`
    SELECT type, body, candidate_id, frame_id FROM review_record
     WHERE lead_id=${leadId}::uuid ORDER BY type, body
  `;
  check("★★ 프레임·후보의 서술 기록이 review_record 한 표에 모인다",
    leadReviews.some((r) => r.frame_id === frames[0].id && r.type === "observation")
      && leadReviews.some((r) => r.candidate_id === "c2" && r.type === "assessment")
      && leadReviews.some((r) => r.candidate_id === "c2" && r.type === "question"),
    `${leadReviews.length}건`);
  const beforeAnyMatch = await ck.getLeadWorkspace(leadId);
  check("★ 아직 경기가 하나도 없어도 조사 기록만으로 검수 화면을 열 수 있다",
    beforeAnyMatch?.matches.length === 0 && beforeAnyMatch.reviews.length === leadReviews.length,
    `경기 ${beforeAnyMatch?.matches.length ?? -1} · 기록 ${beforeAnyMatch?.reviews.length ?? -1}`);

  const remerged = await ck.mergeLeadCandidates(leadId, [
    { id: "c2", at: [4000, 4400], conclusion: "not_target", why: "다른 시점에서 보니 연습 게임이었다" },
  ]);
  // 관찰은 후보 JSON 이 아니라 정본(review_record)에 있다(0040). 이번 병합에 없던 관찰은 그대로 남아야 한다.
  const [c2Observed] = await sqlClient()<{ body: string }[]>`
    SELECT body FROM review_record WHERE lead_id=${leadId}::uuid AND candidate_id='c2' AND type='observation'
  `;
  const c2 = remerged.candidates.find((c) => c.id === "c2");
  check("★★ 후보는 id 로 병합된다 — 다시 반영해도 앞서 적은 후보·관찰이 안 지워진다",
    remerged.candidates.length === 3 && c2?.conclusion === "not_target"
      && c2Observed?.body === "결과창이 그래프 탭이라 승패만 보인다",
    JSON.stringify({ c2, observed: c2Observed?.body }));
  check("★★ 후보 JSON 에는 서술이 남지 않는다 — 관찰·해석·질문은 review_record 에만 있다(0040)",
    remerged.candidates.every((c) => !("observed" in c) && !("why" in c) && !("open_questions" in c)),
    JSON.stringify(remerged.candidates));
  await expectReject("★★ 남은 질문을 문자열 하나로 보내면 거부한다 — 글자마다 질문이 되던 사고",
    () => ck.mergeLeadCandidates(leadId, [
      { id: "c-bad-q", at: [9000, 9100], conclusion: "unresolved", open_questions: "한 문장 질문" as unknown as string[] },
    ]), "문자열 배열");
  // 뒤 테스트가 '미해결 1건' 을 기대하므로 c2 를 되돌린다
  await ck.mergeLeadCandidates(leadId, [{ id: "c2", at: [4000, 4400], conclusion: "unresolved" }]);

  const alphaPuuid = puuids.get("alpha")!;
  const betaPuuid = puuids.get("beta")!;

  await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:ck1",
    played_at: new Date("2026-09-20T20:15:00Z"), duration: 1800,
    source_url: "https://vod.example.com/9990001", result_evidence: "0:05:40 결과창 점수판",
    winning_team: 100,
    evidence_frame_ids: [frames[0].id, frames[1].id],
    participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, team_position: "MIDDLE", champion_id: 157, champion_name: "Yasuo", kills: 5, deaths: 1, assists: 3 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, team_position: "MIDDLE", champion_id: 238, champion_name: "Zed", kills: 1, deaths: 5, assists: 0 },
    ],
  });

  await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:ck2",
    played_at: new Date("2026-09-20T21:10:00Z"), duration: 1500,
    source_url: "https://vod.example.com/9990001", result_evidence: "1:10:00 결과창 그래프탭",
    winning_team: 200,
    evidence_frame_ids: [frames[2].id],
    participants: [
      // 결과창이 그래프 탭이라 승패만 읽혔다 — KDA 를 0 으로 채우지 않는다
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, team_position: "MIDDLE", champion_id: 157, champion_name: "Yasuo" },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, team_position: "MIDDLE", champion_id: 238, champion_name: "Zed" },
      // 이름은 읽었지만 누군지 모르는 자리 (0020)
      { participant_id: 3, observed_name: "난벌레팡이다", team_id: 200, team_position: "TOP", champion_id: 86 },
    ],
  });

  const ck1 = await ck.getMatchDetail("verify-cup:ck1");
  const ck2 = await ck.getMatchDetail("verify-cup:ck2");

  check("★★ 프레임은 **명시한 것만** 붙는다 — VOD 하나에 경기가 여럿이라 첫 경기가 다 삼키면 안 된다",
    ck1?.evidence_frames.length === 2 && ck2?.evidence_frames.length === 1,
    `ck1=${ck1?.evidence_frames.length} ck2=${ck2?.evidence_frames.length}`);

  check("스캔 매치는 origin='vod_scan' 으로 소유가 표시된다", ck1?.match.origin === "vod_scan", ck1?.match.origin ?? "null");
  check("스캔 직후 즉시 확정이고 공개다 (초안 단계 없음)",
    ck1?.match.visibility === "public" && ck1?.match.reviewed_at === null);

  check("★ 못 읽은 KDA 는 NULL 이다 — 0 으로 채우면 '딜 안 하고 안 죽은 사람'이 남는다",
    ck2?.participants[0].kills === null && ck2?.participants[0].deaths === null,
    JSON.stringify(ck2?.participants[0]));

  check("★ 인물이 미확정인 자리도 저장된다 (화면 이름만 들고) — '못 읽은 자리'와 '없던 자리'는 다르다",
    ck2?.participants[2].observed_name === "난벌레팡이다"
      && ck2?.participants[2].streamer_id === null && ck2?.participants[2].puuid === null,
    JSON.stringify(ck2?.participants[2]));

  const evidenceRecords = await sqlClient()<{ match_id: string; body: string }[]>`
    SELECT match_id, body FROM review_record
     WHERE match_id IN ('verify-cup:ck1','verify-cup:ck2') AND type='final_evidence'
     ORDER BY match_id
  `;
  check("★★ 자동 판독의 최종 결과 근거도 review_record에 저장된다",
    evidenceRecords.length === 2
      && evidenceRecords[0].body === "0:05:40 결과창 점수판"
      && evidenceRecords[1].body === "1:10:00 결과창 그래프탭",
    JSON.stringify(evidenceRecords));

  const ck1Enc = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM streamer_encounter WHERE match_id = 'verify-cup:ck1'
  `;
  check("★ 스캔 저장이 조우까지 한 트랜잭션에서 파생한다 (따로 부르지 않아도 된다)",
    ck1Enc[0]?.n === 1, `${ck1Enc[0]?.n}쌍`);

  const ck1Stat = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM champion_stat WHERE streamer_id = (SELECT id FROM streamer WHERE slug='alpha')
  `;
  check("★ 스캔 저장이 챔피언 통계까지 갱신한다 (champion_stat 은 뷰가 아니라 테이블이다)",
    (ck1Stat[0]?.n ?? 0) > 0, `${ck1Stat[0]?.n}행`);

  console.log("\n▸ 검수 어드민 — 고칠 수 있어야 하는 것 (0020)");

  // ── 승자 정정: outcome 과 조우까지 따라가야 한다
  const flipped = await ck.applyMatchReview("verify-cup:ck1", { match: { changes: { winning_team: 200 }, expect: { winning_team: 100 } } });
  check("승자를 고치면 참가자 outcome 이 따라간다",
    flipped?.participants.find((p) => p.team_id === 100)?.outcome === "loss"
      && flipped?.participants.find((p) => p.team_id === 200)?.outcome === "win",
    JSON.stringify(flipped?.participants.map((p) => [p.team_id, p.outcome])));

  // ★ "둘이 다르다"로는 약하다 — 둘 다 반대로 뒤집혀도 통과한다.
  //   조우의 승패가 **실제 승리 팀과 일치하는지**를 본다. 그게 0015 의 불변식이다.
  const encAfterFlip = await sqlClient()<{ a_ok: boolean; b_ok: boolean; winning_team: number }[]>`
    SELECT (se.a_outcome = 'win') = (pa.team_id = m.winning_team) AS a_ok,
           (se.b_outcome = 'win') = (pb.team_id = m.winning_team) AS b_ok,
           m.winning_team
      FROM streamer_encounter se
      JOIN match m ON m.match_id = se.match_id
      JOIN match_participant pa ON pa.match_id = se.match_id
      JOIN streamer_account saa ON saa.puuid = pa.puuid AND saa.streamer_id = se.streamer_a_id
                               AND saa.active_to IS NULL
      JOIN match_participant pb ON pb.match_id = se.match_id
      JOIN streamer_account sab ON sab.puuid = pb.puuid AND sab.streamer_id = se.streamer_b_id
                               AND sab.active_to IS NULL
     WHERE se.match_id = 'verify-cup:ck1'
  `;
  check("★★ 승자를 고치면 **조우의 승패가 승리 팀과 일치한다** — 0015 가 막으려던 '승자 반대로' 사고",
    encAfterFlip.length === 1 && encAfterFlip[0].a_ok === true && encAfterFlip[0].b_ok === true,
    JSON.stringify(encAfterFlip[0]));
  check("검수하면 reviewed_at 이 찍힌다", flipped?.match.reviewed_at !== null);

  await sqlClient()`
    INSERT INTO match_series (id, game_code, event_id) VALUES ('verify-cup:admin-format', 'lol', ${eventId}::uuid)
  `;
  await sqlClient()`
    INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, winning_team,
                       source, origin, series_id, series_game_no)
    VALUES ('verify-cup:admin-format-s1', 'lol', 0, '0', now(), 100,
            'manual', 'admin', 'verify-cup:admin-format', 1)
  `;
  const formatted = await ck.applyMatchReview("verify-cup:admin-format-s1", {
    match: {
      changes: { best_of: 5, best_of_evidence: "어드민에서 확인한 Bo5 규정" },
      expect: { best_of: null, best_of_evidence: null },
    },
  });
  check("★ 어드민은 best_of와 근거를 시리즈 정본에 한 묶음으로 저장한다",
    formatted?.match.best_of === 5 && formatted.match.best_of_evidence === "어드민에서 확인한 Bo5 규정",
    JSON.stringify({ best_of: formatted?.match.best_of, evidence: formatted?.match.best_of_evidence }));
  await sqlClient()`DELETE FROM match WHERE match_id='verify-cup:admin-format-s1'`;
  await sqlClient()`DELETE FROM match_series WHERE id='verify-cup:admin-format'`;

  // ★ 폼이 안 채운 칸(undefined)을 NULL 로 써 버리면 근거가 조용히 지워진다.
  //   postgres.js 가 undefined 를 NULL 로 보내기 때문에 실제로 그럴 수 있었다.
  const untouched = await ck.applyMatchReview("verify-cup:ck1", {
    match: { changes: { series_id: undefined, game_duration: 1900 }, expect: { game_duration: flipped!.match.game_duration } },
  });
  check("★★ patch 의 undefined 는 무시한다 — 안 채운 칸이 기존 값을 지우지 않는다",
    untouched?.match.series_id === flipped!.match.series_id && untouched?.match.game_duration === 1900
      && untouched?.match.result_evidence === "0:05:40 결과창 점수판",
    JSON.stringify({ series: untouched?.match.series_id, ev: untouched?.match.result_evidence, dur: untouched?.match.game_duration }));
  check("명시적으로 null 을 넘기면 지워진다 (지우는 길은 남아 있다)",
    (await ck.applyMatchReview("verify-cup:ck1", { match: { changes: { series_id: null, series_game_no: null }, expect: { series_id: untouched!.match.series_id, series_game_no: untouched!.match.series_game_no } } }))
      ?.match.series_id === null);

  // ── 참가자 추가·삭제·식별
  const identified = await ck.applyMatchReview("verify-cup:ck2", {
    participants: { patch: [{participant_id: 3, changes: {streamer_id:s2.id}, expect:{streamer_id:null}}] },
  });
  check("미확정 자리에 사람을 붙일 수 있다 (identify)",
    identified?.participants.find((p) => p.participant_id === 3)?.streamer_id === s2.id);

  const removed = await ck.applyMatchReview("verify-cup:ck2", { participants: { remove: [3] } });
  check("잘못 읽어 넣은 참가자를 지울 수 있다",
    removed?.participants.length === 2 && !removed.participants.some((p) => p.participant_id === 3));

  // 아예 없던 자리를 새로 만든다 (판독 때 통째로 놓친 사람)
  const added = await ck.applyMatchReview("verify-cup:ck2", {
    participants: {
      add: [{ participant_id: 7, observed_name: "뒤늦게찾은사람", team_id: 100, team_position: "JUNGLE" }],
    },
  });
  check("판독에서 놓친 자리를 새로 넣을 수 있다",
    added?.participants.some((p) => p.participant_id === 7 && p.observed_name === "뒤늦게찾은사람") === true,
    JSON.stringify(added?.participants.map((p) => p.participant_id)));
  await ck.applyMatchReview("verify-cup:ck2", { participants: { remove: [7] } });

  // ── 챔피언 이름·ID 일관성
  const beforeChamp = (await ck.getMatchDetail("verify-cup:ck2"))!.participants.find(p=>p.participant_id===1)!;
  const champFixed = await ck.applyMatchReview("verify-cup:ck2", {
    participants: { patch: [{ participant_id:1, changes:{champion_name:"리 신"}, expect:{champion_name:beforeChamp.champion_name,champion_id:beforeChamp.champion_id} }] },
  });
  check("★ 챔피언 이름을 고치면 ID 가 따라온다 (집계는 ID 로 묶는다)",
    champFixed?.participants.find((p) => p.participant_id === 1)?.champion_id === 64
      && champFixed?.participants.find((p) => p.participant_id === 1)?.champion_name === "LeeSin",
    JSON.stringify(champFixed?.participants.find((p) => p.participant_id === 1)));

  // ── 계정과 사람이 어긋나면 거부한다
  await expectReject(
    "★★ 계정의 주인과 다른 사람을 지정하면 거부한다 — 조용히 저장되면 고친 대로 계산되지 않는다",
    () => ck.applyMatchReview("verify-cup:ck2", {
      participants: { patch: [{ participant_id: 2, changes: { streamer_id: s1.id }, expect: {streamer_id: null} }] },
    }),
    "조우 파생은 계정을 먼저 보므로",
  );

  // ── 제외: 「기본 공개, 뺄 것만 제외」의 '제외'
  //
  // ⚠ 행 수로 재면 안 된다 — ck1 과 ck2 는 대회가 없어 category='other' 로 **같은 키에
  //   합산된다.** 하나를 빼도 행은 남고 games 만 줄어든다. 그래서 games 를 본다.
  const alphaGames = async () => {
    const rows = await sqlClient()<{ games: number }[]>`
      SELECT games FROM champion_stat
       WHERE streamer_id = (SELECT id FROM streamer WHERE slug = 'alpha')
         AND champion_id = 157 AND queue_id = 0 AND season = 'ALL' AND category = 'other'
    `;
    return rows[0]?.games ?? 0;
  };
  const gamesBeforeHide = await alphaGames();
  await ck.setMatchVisibility("verify-cup:ck1", "hidden");

  const pubMatch = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM core_public.match WHERE match_id = 'verify-cup:ck1'
  `;
  const pubPart = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM core_public.match_participant WHERE match_id = 'verify-cup:ck1'
  `;
  const pubEncH = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM core_public.streamer_encounter WHERE match_id = 'verify-cup:ck1'
  `;
  check("★ 제외한 경기는 core_public.match 에서 사라진다", pubMatch[0]?.n === 0, `${pubMatch[0]?.n}건`);
  check("★ 제외한 경기의 참가자도 사라진다", pubPart[0]?.n === 0, `${pubPart[0]?.n}건`);
  check("★ 제외한 경기의 조우도 사라진다 (이 사이트의 심장)", pubEncH[0]?.n === 0, `${pubEncH[0]?.n}건`);

  const rawStillThere = await sqlClient()<{ visibility: string }[]>`
    SELECT visibility FROM match WHERE match_id = 'verify-cup:ck1'
  `;
  check("★ 제외는 삭제가 아니다 — 행은 남아 있어 되살릴 수 있다",
    rawStillThere[0]?.visibility === "hidden", JSON.stringify(rawStillThere[0]));

  const gamesAfterHide = await alphaGames();
  // ⚠ 절대값으로 재지 않는다 — 앞 테스트가 챔피언을 고치면 기여하는 경기 수가 바뀐다.
  //   불변식은 "제외한 경기 한 판만큼 줄어든다" 다.
  check("★ 제외가 champion_stat 에도 반영된다 (테이블이라 뷰 필터로는 안 된다)",
    gamesBeforeHide > 0 && gamesAfterHide === gamesBeforeHide - 1,
    `games ${gamesBeforeHide} → ${gamesAfterHide}`);

  await ck.setMatchVisibility("verify-cup:ck1", "public");
  const pubMatchBack = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM core_public.match WHERE match_id = 'verify-cup:ck1'
  `;
  check("★ 되살리면 그대로 돌아온다", pubMatchBack[0]?.n === 1);

  // 숨김 조인이 살아 있는지 — 0016 에서 한 번 빠뜨린 자리다
  await sqlClient()`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'alpha'`;
  const pubEncHiddenStreamer = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM core_public.streamer_encounter WHERE match_id = 'verify-cup:ck1'
  `;
  check("★★ 경기 숨김을 더해도 **스트리머 숨김이 그대로 살아 있다** (계약 5조)",
    pubEncHiddenStreamer[0]?.n === 0, `${pubEncHiddenStreamer[0]?.n}건`);
  await sqlClient()`UPDATE streamer SET visibility = 'public' WHERE slug = 'alpha'`;

  // ── 프레임 재연결
  const relinked = await ck.relinkEvidenceFrame(frames[2].id, "verify-cup:ck1");
  check("잘못 붙인 프레임을 다른 경기로 옮길 수 있다", relinked?.match_id === "verify-cup:ck1");
  await ck.relinkEvidenceFrame(frames[2].id, "verify-cup:ck2");

  // ── 기각했던 후보를 되살린다: 연결 안 된 프레임에서 경기를 새로 만든다
  const orphan = await ck.recordEvidenceFrames(leadId, [
    { frame_path: "out/ck/2026-09-20/f9.jpg", at_sec: 9000, kind: "result", note: "처음에 기각한 구간" },
  ]);
  await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:ckAdmin", origin: "admin",
    played_at: new Date("2026-09-20T23:30:00Z"), winning_team: 200,
    result_evidence: "2:30:00 결과창 — 검수에서 되살림",
    evidence_frame_ids: [orphan[0].id],
    participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, champion_id: 157 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, champion_id: 238 },
    ],
  });
  const adminMade = await ck.getMatchDetail("verify-cup:ckAdmin");
  check("★ 기각한 후보를 검수에서 되살릴 수 있다 (미연결 프레임 → 새 경기, origin='admin')",
    adminMade?.match.origin === "admin" && adminMade?.evidence_frames.length === 1,
    `origin=${adminMade?.match.origin} 프레임=${adminMade?.evidence_frames.length}`);

  console.log("\n▸ 재실행 계약 — 자동 수집이 사람의 판독을 덮지 않는다 (0020)");

  // ── 검수 안 한 경기를 다시 스캔하면? 같은 것을 **중복 생성하지 않고** 갱신한다
  const lead2 = await ck.upsertEventLead({
    source: "vod_title", source_key: "vod:9990002",
    title: "같은 내전, 다른 시점", channel_id: "beta_ch",
    observed_at: new Date("2026-09-20T20:00:00Z"), state: "confirmed",
  });
  const pov2Frames = await ck.recordEvidenceFrames(lead2, [
    { frame_path: "out/ck/2026-09-20/b1.jpg", at_sec: 350, kind: "result", note: "베타 시점 결과창" },
  ]);
  const povMatch = {
    played_at_precision: "datetime" as const,
    match_id: "verify-cup:ck3", played_at: new Date("2026-09-20T22:00:00Z"),
    winning_team: 100 as const,
    participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100 as const, champion_id: 157 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200 as const, champion_id: 238 },
    ],
  };
  await ck.upsertMatchFromScan(povMatch);
  await ck.upsertMatchFromScan({ ...povMatch, evidence_frame_ids: [pov2Frames[0].id] });
  const ck3Rows = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM match WHERE match_id = 'verify-cup:ck3'
  `;
  const ck3Parts = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM match_participant WHERE match_id = 'verify-cup:ck3'
  `;
  const ck3Enc = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM streamer_encounter WHERE match_id = 'verify-cup:ck3'
  `;
  check("★ 재실행이 같은 결과를 중복 생성하지 않는다 (경기 1 · 참가자 2 · 조우 1)",
    ck3Rows[0]?.n === 1 && ck3Parts[0]?.n === 2 && ck3Enc[0]?.n === 1,
    `경기 ${ck3Rows[0]?.n} · 참가자 ${ck3Parts[0]?.n} · 조우 ${ck3Enc[0]?.n}`);

  const ck3Detail = await ck.getMatchDetail("verify-cup:ck3");
  check("★ 같은 경기를 여러 POV 가 가리킨다 — lead 는 여럿, match 는 하나",
    ck3Detail?.evidence_frames.length === 1
      && ck3Detail.evidence_frames[0].lead_id === lead2,
    `프레임 ${ck3Detail?.evidence_frames.length}장`);

  const rescan = await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:ck1", played_at: new Date("2026-09-20T20:15:00Z"),
    winning_team: 100, participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200 },
    ],
  });
  const afterRescan = await ck.getMatchDetail("verify-cup:ck1");
  check("★ 검수한 경기를 다시 스캔하면 건드리지 않고 false 를 돌려준다",
    rescan === false && afterRescan?.match.winning_team === 200,
    `rescan=${rescan} winner=${afterRescan?.match.winning_team}`);

  const reseed = await tournaments.saveTournamentGame({
    match_id: "verify-cup:ck1", event_id: eventId,
    series_id: "verify-cup:ck1", series_game_no: 1, played_at_precision: "datetime",
    played_at: new Date("2026-09-20T20:15:00Z"), duration: 1800,
    source_url: "https://example.com/vod", winning_team: 100,
    participants: [{ puuid: alphaPuuid, team_id: 100 }],
  });
  const afterReseed = await ck.getMatchDetail("verify-cup:ck1");
  check("★★ 시드 재실행도 검수한 경기를 덮지 않는다 (seed:meljang 이 판독을 날리던 자리)",
    reseed === false && afterReseed?.participants.length === 2 && afterReseed?.match.winning_team === 200,
    `reseed=${reseed} 참가자=${afterReseed?.participants.length}`);

  // VOD 조사분이 시드 event 에 섞여도 prune 이 안 지운다.
  // ★ 그리고 **시드가 만든(wiki_seed) 경기라도 사람이 검수했으면** 안 지운다 —
  //   그게 seed:meljang 이 판독을 날리던 실제 케이스다. 두 분기를 따로 세운다.
  await sqlClient()`UPDATE match SET event_id = ${eventId}::uuid WHERE match_id = 'verify-cup:ck2'`;
  await sqlClient()`
    INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, winning_team,
                       source, origin, event_id, reviewed_at)
    VALUES ('verify-cup:seedReviewed', 'lol', 0, '0', now(), 100, 'manual', 'wiki_seed', ${eventId}::uuid, now())
  `;
  await sqlClient()`
    INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, winning_team,
                       source, origin, event_id)
    VALUES ('verify-cup:seedPlain', 'lol', 0, '0', now(), 100, 'manual', 'wiki_seed', ${eventId}::uuid)
  `;
  // VOD 근거 프레임이 붙은 시드 경기 — 지우면 근거 연결이 ON DELETE SET NULL 로 소리 없이 끊긴다.
  await sqlClient()`
    INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, winning_team,
                       source, origin, event_id)
    VALUES ('verify-cup:seedEvidence', 'lol', 0, '0', now(), 100, 'manual', 'wiki_seed', ${eventId}::uuid)
  `;
  // 다른 절이 세는 검증 VOD(leadId)의 프레임 수를 흔들지 않게 따로 단서를 둔다.
  const pruneLead = await ck.upsertEventLead({
    source: "vod_title", source_key: "vod:prune-guard", title: "근거 붙은 시드 경기",
    observed_at: new Date("2026-09-20T20:00:00Z"),
  });
  await sqlClient()`
    INSERT INTO match_evidence_frame (lead_id, match_id, frame_path, kind)
    VALUES (${pruneLead}::uuid, 'verify-cup:seedEvidence', 'out/ck/verify/seed-evidence.jpg', 'result')
  `;
  await sqlClient()`INSERT INTO match_series (id, game_code, event_id) VALUES ('verify-cup:empty', 'lol', ${eventId}::uuid)`;
  const prunedCk = await tournaments.pruneEventMatches(eventId, ["verify-cup:f1"]);
  const seriesAfterPrune = await sqlClient()<{ id: string }[]>`
    SELECT id FROM match_series WHERE id IN ('verify-cup:empty', 'verify-cup:f1')`;
  check("prune 은 실제로 지운 건수를 돌려준다 (0 이면 시드가 '지운 게 없다'고 거짓말한다)",
    prunedCk >= 1, `${prunedCk}건`);
  check("★ prune 은 비어 버린 시리즈도 치운다 — 빈 시리즈에 라운드명이 들어가 아무 데도 안 보이는 일을 막는다",
    !seriesAfterPrune.some((r) => r.id === "verify-cup:empty") && seriesAfterPrune.some((r) => r.id === "verify-cup:f1"),
    seriesAfterPrune.map((r) => r.id).join(","));
  const survivors = await sqlClient()<{ match_id: string }[]>`
    SELECT match_id FROM match
     WHERE match_id IN ('verify-cup:ck1', 'verify-cup:ck2', 'verify-cup:seedReviewed', 'verify-cup:seedPlain',
                        'verify-cup:seedEvidence')
     ORDER BY match_id
  `;
  const survivorNames = survivors.map((s) => s.match_id);
  check("★★ prune 은 자기 것(wiki_seed)만 지운다 — 같은 event 의 VOD 판독분이 살아남는다",
    survivorNames.includes("verify-cup:ck1") && survivorNames.includes("verify-cup:ck2"),
    `${prunedCk}건 지움 · 생존 ${survivorNames.join(",")}`);
  check("★★ 시드가 만든 경기라도 **검수했으면** prune 이 안 지운다 (seed:meljang 사고의 실제 모양)",
    survivorNames.includes("verify-cup:seedReviewed"), survivorNames.join(","));
  check("검수 안 한 시드 경기는 평소대로 지운다 (이중 계상 방지는 살아 있다)",
    !survivorNames.includes("verify-cup:seedPlain"), survivorNames.join(","));
  check("★★ VOD 근거가 붙은 시드 경기는 prune 이 안 지운다 (근거 연결이 소리 없이 끊기지 않는다, 0035)",
    survivorNames.includes("verify-cup:seedEvidence"), survivorNames.join(","));

  // ★ 팀 쪽에도 같은 보호가 있어야 한다. match.blue_team_id 는 ON DELETE SET NULL(0008)
  //   이라, 시드가 팀을 지우면 **검수한 경기의 팀 배정이 조용히 NULL 이 된다.**
  //   VOD 판독은 그 방송의 오버레이 팀명을 쓰므로(같은 판을 참가자마다 자기 팀장 이름으로
  //   부른다) 시드 명단에 없는 팀명이 되는 게 정상이고, 그래서 흔히 걸린다.
  const povTeams = await tournaments.saveEventTeams(eventId, [
    { name: "상호팀(방송 오버레이)", members: [{ streamer_id: s1.id }] },
    { name: "성훈팀(방송 오버레이)", members: [{ streamer_id: s2.id }] },
  ]);
  await sqlClient()`
    UPDATE match SET blue_team_id = ${povTeams.get("상호팀(방송 오버레이)")!}::uuid,
                     red_team_id  = ${povTeams.get("성훈팀(방송 오버레이)")!}::uuid,
                     reviewed_at  = now()
     WHERE match_id = 'verify-cup:ck2'
  `;
  // 시드를 완전히 다른 팀 구성으로 다시 돌린다 (나무위키 팀명)
  await tournaments.saveEventTeams(eventId, [
    { name: "알파팀", members: [{ streamer_id: s1.id }] },
  ]);
  const teamsKept = await sqlClient()<{ blue_team_id: string | null; red_team_id: string | null }[]>`
    SELECT blue_team_id, red_team_id FROM match WHERE match_id = 'verify-cup:ck2'
  `;
  check("★★ 시드 재실행이 **검수한 경기의 팀 배정**을 날리지 않는다 (blue_team_id 는 SET NULL 이다)",
    teamsKept[0]?.blue_team_id !== null && teamsKept[0]?.red_team_id !== null,
    JSON.stringify(teamsKept[0]));

  await expectReject(
    "★ 수기 매치는 origin 없이 못 들어간다 — 안 그러면 영구히 prune 대상에서 빠진다",
    async () => {
      await sqlClient()`
        INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, winning_team, source)
        VALUES ('verify-cup:noOrigin', 'lol', 0, '0', now(), 100, 'manual')
      `;
    },
    "match_manual_has_origin",
  );

  // ── 범위 재계산이 전체 재빌드와 같은 값을 내나 (갈라지면 아무도 모른다)
  //
  // ⚠ 전체 키로 정렬해야 비교가 성립한다. 일부 컬럼만 고르면 같은 값이 여러 행에 있어
  //   정렬이 모호해지고, 코드가 멀쩡해도 JSON 이 달라 보인다.
  const snapshotStats = async () => sqlClient()<Record<string, unknown>[]>`
    SELECT streamer_id, champion_id, queue_id, season, category, games, wins, kills, deaths, assists
      FROM champion_stat
     ORDER BY streamer_id, champion_id, queue_id, season, category
  `;
  await ingestDb.recomputeChampionStats();
  const fullStat = await snapshotStats();

  const everyone = await sqlClient()<{ id: string }[]>`SELECT id FROM streamer`;
  await ingestDb.recomputeChampionStats(everyone.map((s) => s.id));
  const scopedStat = await snapshotStats();

  check("★★ 범위 재계산이 전체 재빌드와 같은 값을 낸다 (SQL 본문을 하나로 둔 이유)",
    JSON.stringify(fullStat) === JSON.stringify(scopedStat),
    `전체 ${fullStat.length}행 vs 범위 ${scopedStat.length}행`);

  check("★ 숨긴 경기는 재빌드에도 안 들어온다 (category 가 PK 에 들어가 충돌하지도 않는다)",
    fullStat.length > 0, `${fullStat.length}행`);

  check("빈 배열은 '아무도' 다 — 전체 재빌드로 오해하지 않는다",
    (await ingestDb.recomputeChampionStats([])) === 0);

  // ── 못 읽은 KDA 가 평균을 묽게 하지 않나 (0020 ⑧)
  //   ck2 에서 알파는 KDA 를 못 읽었다(그래프 탭). ck3 에서도 안 읽었다.
  //   그러니 그 챔피언의 kda_games 는 games 보다 작아야 하고, 하나도 없으면 0 이어야 한다.
  const kdaDenom = await sqlClient()<{ champion_id: number; games: number; kda_games: number; kills: number }[]>`
    SELECT champion_id, games, kda_games, kills FROM champion_stat
     WHERE streamer_id = (SELECT id FROM streamer WHERE slug = 'alpha') AND season = 'ALL'
     ORDER BY champion_id
  `;
  check("분모는 절대 분자보다 작은 표본을 가리키지 않는다 (kda_games ≤ games)",
    kdaDenom.length > 0 && kdaDenom.every((r) => r.kda_games <= r.games), JSON.stringify(kdaDenom));

  // 야스오(157): ck1 에서만 KDA 를 읽었고 ck3·ckAdmin 은 못 읽었다 → 분모가 games 보다 작다
  const diluted = kdaDenom.find((r) => r.champion_id === 157);
  check("★★ KDA 를 못 읽은 판은 평균의 분모에서 빠진다 — games 로 나누면 평균이 묽어진다",
    diluted !== undefined && diluted.kda_games < diluted.games && diluted.kills > 0,
    JSON.stringify(diluted));

  // 리 신(64): ck2 한 판뿐이고 그 판은 결과창이 그래프 탭이라 KDA 를 못 읽었다
  const unread = kdaDenom.find((r) => r.champion_id === 64);
  check("★ 한 판도 못 읽었으면 kda_games 가 0 이다 (화면은 평균을 내지 않고 '—' 를 그린다)",
    unread !== undefined && unread.kda_games === 0 && unread.kills === 0 && unread.games > 0,
    JSON.stringify(unread));

  // ── 멀티게임 격리 — FC 경기 한 건이 LoL 파생·공개면을 깨지 않나 (0026)
  //
  // FC 참가자에는 LoL champion_id·queue_id 가 없고, 무승부는 outcome='draw' 하나로만
  // 표현된다. 이 행이 들어온 뒤에도 champion_stat 재계산이 성공해야 하며,
  // Phase 1 공개 계약에는 섞이면 안 된다.
  const lolStatsBeforeFc = await snapshotStats();
  await sqlClient()`
    INSERT INTO match (match_id, game_code, mode_key, game_creation, game_duration, source)
    VALUES ('fco:verify-draw', 'fconline', '60', '2024-01-01T00:00:00Z', 600, 'provider_api')
  `;
  await sqlClient()`
    INSERT INTO match_participant
      (match_id, streamer_id, participant_id, side_no, outcome)
    VALUES ('fco:verify-draw', ${s1.id}::uuid, 1, 1, 'draw'),
           ('fco:verify-draw', ${s2.id}::uuid, 2, 2, 'draw')
  `;
  const madeFcEncounters = await ingestDb.rederiveEncounters(['fco:verify-draw']);
  const [fcEncounter] = await sqlClient()<{
    game_code: string; queue_id: number | null;
    a_outcome: string; b_outcome: string;
  }[]>`
    SELECT game_code, queue_id, a_outcome, b_outcome
      FROM streamer_encounter WHERE match_id = 'fco:verify-draw'
  `;
  check("★★ FC 무승부 조우는 승/패로 합성되지 않고 draw 그대로 저장된다",
    madeFcEncounters === 1 && fcEncounter?.game_code === 'fconline'
      && fcEncounter.queue_id === null
      && fcEncounter.a_outcome === 'draw' && fcEncounter.b_outcome === 'draw',
    JSON.stringify(fcEncounter));

  await ingestDb.recomputeChampionStats();
  const lolStatsAfterFc = await snapshotStats();
  check("★★ FC 경기가 있어도 LoL champion_stat 재계산이 성공하고 결과가 변하지 않는다",
    JSON.stringify(lolStatsAfterFc) === JSON.stringify(lolStatsBeforeFc),
    `전 ${lolStatsBeforeFc.length}행 · 후 ${lolStatsAfterFc.length}행`);

  const [fcPublicLeak] = await sqlClient()<{
    matches: number; participants: number; encounters: number;
  }[]>`
    SELECT
      (SELECT count(*)::int FROM core_public.match WHERE match_id = 'fco:verify-draw') AS matches,
      (SELECT count(*)::int FROM core_public.match_participant WHERE match_id = 'fco:verify-draw') AS participants,
      (SELECT count(*)::int FROM core_public.streamer_encounter WHERE match_id = 'fco:verify-draw') AS encounters
  `;
  check("★★ Phase 1 core_public 세 뷰가 FC 행을 LoL 화면에 노출하지 않는다",
    fcPublicLeak.matches === 0 && fcPublicLeak.participants === 0 && fcPublicLeak.encounters === 0,
    JSON.stringify(fcPublicLeak));

  // ── 새 테이블에 RLS 를 켰나 (0002 의 관용구가 문서일 뿐이면 다음 표에서 새어 나간다)
  const rlsOff = await sqlClient()<{ relname: string }[]>`
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
     ORDER BY c.relname
  `;
  check("★★ public 스키마의 모든 테이블에 RLS 가 켜져 있다 (PostgREST 로 새면 삭제 요청이 무의미해진다)",
    rlsOff.length === 0, rlsOff.map((r) => r.relname).join(",") || "전부 켜짐");

  // ── 프레임 수명
  // leadId 에 쌓은 프레임: f1·f2(→ck1) · f3(→ck2) · f4 · f9(→ckAdmin) = 5장 / 매치 3개
  const leadList = await ck.listEventLeads({ state: "confirmed" });
  const listedLead = leadList.find((l) => l.id === leadId);
  check("목록의 경기 수는 근거 프레임 수에 의해 중복되지 않는다",
    listedLead?.match_count === 3, JSON.stringify({ matches: listedLead?.match_count }));

  const ws = await ck.getLeadWorkspace(leadId);
  check("★ 검수 화면이 후보(경기가 안 된 것 포함)를 같이 받는다",
    ws?.candidates.length === 3 && ws.candidates.some((c) => c.conclusion === "not_target"),
    `후보 ${ws?.candidates.length}건`);

  // ── 다른 시점에서 같은 경기를 만났을 때 기존 경기를 고를 수 있나 (계획 §6)
  // 넓은 VOD 구간 전체를 기존 경기 하나에 걸면 경기 막대가 그 범위로 팽창한다.
  // 같은 판으로 판단한 **좁은 구간 하나만** linked 로 남기고, 남은 질문도 그 경기에 붙인다.
  await ck.mergeLeadCandidates(leadId, [{
    id: "c-linked-ck1", at: [320, 360], conclusion: "linked", match_id: "verify-cup:ck1",
    observed: "다른 시점의 같은 경기 결과 화면",
    why: "시각·참가자·승패가 기존 경기와 일치한다",
    open_questions: ["가려진 한 자리를 다른 시점에서 더 확인할지"],
  }]);
  const around = await ck.findMatchesAround({
    at: new Date("2026-09-20T20:20:00Z"),
    window_minutes: 90,
    streamer_ids: [s1.id, s2.id],
  });
  check("★★ 시각·참가자로 기존 경기를 찾을 수 있다 — VOD 번호로 새 ID 를 만들지 않아도 된다",
    around.length > 0 && around.some((m) => m.match_id === "verify-cup:ck1"),
    around.map((m) => `${m.match_id}(겹침${m.overlap})`).join(" "));
  const aroundCk1 = around.find((m) => m.match_id === "verify-cup:ck1");
  check("★★ 기존 경기 조회가 로스터·판독 공백을 보여 줘 조사 깊이를 추측에 맡기지 않는다",
    aroundCk1?.participant_count === 2 && aroundCk1.unidentified_count === 0
      && aroundCk1.champion_missing_count === 0 && aroundCk1.kda_missing_count === 0,
    JSON.stringify(aroundCk1));
  check("★★ 결과 근거 완전성은 레거시 match 칼럼이 아니라 review_record 정본으로 판단한다",
    aroundCk1?.has_final_evidence === true && aroundCk1.evidence_frame_count === 2
      && aroundCk1.result_frame_count === 1,
    JSON.stringify(aroundCk1));
  check("★★ linked 후보에 남긴 질문도 기존 경기 조회에서 이어서 보인다",
    aroundCk1?.open_questions.includes("가려진 한 자리를 다른 시점에서 더 확인할지") === true,
    JSON.stringify(aroundCk1?.open_questions));

  // ── 부분 판독 — 셋 중 일부만 읽은 판 (검수 피드백 #5)
  //
  // ⚠ 예전 규칙은 "셋 중 **하나라도**" 였다. 그러면 kills 만 읽은 판이 분모에 들어가고
  //   sum(deaths) 는 NULL → coalesce 로 0 이 되어 **5/0/0 으로 집계된다.**
  //   "모른다" 가 "안 죽었다" 로 바뀌는 것이라 숫자로 거짓말하게 된다(CLAUDE.md 3).
  await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:partialKda",
    played_at: new Date("2026-09-20T23:50:00Z"), winning_team: 200,
    result_evidence: "결과창에 툴팁이 겹쳐 데스·어시스트만 가렸다",
    participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, champion_id: 103, kills: 5 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, champion_id: 238, kills: 9, deaths: 1, assists: 4 },
    ],
  });
  const partial = await sqlClient()<{ games: number; kda_games: number; kills: number; deaths: number }[]>`
    SELECT games, kda_games, kills, deaths FROM champion_stat
     WHERE streamer_id = (SELECT id FROM streamer WHERE slug = 'alpha')
       AND champion_id = 103 AND season = 'ALL'
  `;
  check("★★ KDA 를 일부만 읽은 판은 **분자에도 분모에도** 안 들어간다 (모르는 값이 0 이 되면 안 된다)",
    partial[0]?.games === 1 && partial[0]?.kda_games === 0
      && partial[0]?.kills === 0 && partial[0]?.deaths === 0,
    JSON.stringify(partial[0]));

  // ── 재판독으로 사람을 바꾸면 옛 사람 통계가 남나 (검수 피드백 #4)
  //
  // ⚠ upsertMatchFromScan 은 참가자를 DELETE 후 재INSERT 한다. 옛 명단을 **지우기 전에**
  //   잡지 않으면 "고친 뒤" 만 재계산 범위에 들어가고, 옛 사람에게 유령 경기가 남는다.
  await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:swap",
    played_at: new Date("2026-09-21T01:00:00Z"), winning_team: 100,
    result_evidence: "판독 1차", participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, champion_id: 268, kills: 1, deaths: 1, assists: 1 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, champion_id: 238, kills: 2, deaths: 2, assists: 2 },
    ],
  });
  const ghostBefore = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM champion_stat
     WHERE streamer_id = (SELECT id FROM streamer WHERE slug = 'alpha') AND champion_id = 268
  `;
  // 같은 자리를 다른 사람으로 다시 읽었다 (알파 → 베타)
  await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:swap",
    played_at: new Date("2026-09-21T01:00:00Z"), winning_team: 100,
    result_evidence: "재판독 — 1번 자리는 알파가 아니라 베타였다", participants: [
      { participant_id: 1, puuid: betaPuuid, team_id: 100, champion_id: 268, kills: 1, deaths: 1, assists: 1 },
      { participant_id: 2, puuid: alphaPuuid, team_id: 200, champion_id: 238, kills: 2, deaths: 2, assists: 2 },
    ],
  });
  const ghostAfter = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM champion_stat
     WHERE streamer_id = (SELECT id FROM streamer WHERE slug = 'alpha') AND champion_id = 268
  `;
  check("★★ 재판독으로 사람을 바꾸면 **옛 사람의 통계가 사라진다** (고치기 전 명단도 재계산 범위다)",
    ghostBefore[0]?.n > 0 && ghostAfter[0]?.n === 0,
    `알파의 268 통계 ${ghostBefore[0]?.n}행 → ${ghostAfter[0]?.n}행`);

  // ── 식별(identify)이 판독값을 지우나 (검수 피드백 #1)
  //
  // ⚠ 예전엔 applyMatchReview 의 참가자 upsert 를 썼다. 그건 전 컬럼을 덮으므로,
  //   사람만 붙이려고 돌렸는데 **챔피언이 0, KDA 가 null 로 지워졌다.**
  const linkTarget = await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:linkOnly",
    played_at: new Date("2026-09-21T02:00:00Z"), winning_team: 100,
    result_evidence: "결과창", participants: [
      { participant_id: 1, observed_name: "누군지모름", team_id: 100, champion_id: 157, kills: 7, deaths: 2, assists: 5 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, champion_id: 238, kills: 2, deaths: 7, assists: 1 },
    ],
  });
  const linked = await ck.linkParticipants("verify-cup:linkOnly", [{ participant_id: 1, streamer_id: s1.id }]);
  const afterLink = await ck.getMatchDetail("verify-cup:linkOnly");
  const p1 = afterLink?.participants.find((p) => p.participant_id === 1);
  check("★★ 식별은 **사람만** 붙인다 — 판독한 챔피언·KDA 가 지워지지 않는다",
    linkTarget === true && linked.status === "ok" && p1?.streamer_id === s1.id
      && p1?.champion_id === 157 && p1?.kills === 7 && p1?.assists === 5,
    JSON.stringify(p1));
  check("★ 식별은 reviewed_at 을 찍지 않는다 — 사람 연결 하나로 챔피언·KDA 보강이 잠기면 안 된다",
    afterLink?.match.reviewed_at === null, String(afterLink?.match.reviewed_at));
  const missingSeat = await ck.linkParticipants("verify-cup:linkOnly", [{ participant_id: 9, streamer_id: s1.id }]);
  check("★ 식별은 없는 자리를 만들지 않고 **못 찾았다고 알린다**",
    missingSeat.status === "ok" && missingSeat.linked === 0 && missingSeat.missing.join(",") === "9",
    JSON.stringify(missingSeat));
  const reviewedLink = await ck.linkParticipants("verify-cup:ck1", [{ participant_id: 1, streamer_id: s2.id }]);
  // 보호는 칸 단위다(0074, review-lock.ts) — 이 경기는 사람이 승자를 고쳐 칸 보호이고, 1번 자리는
  // 이미 계정(puuid)으로 사람이 정해져 있다. 정해진 사람은 사람이 안 고쳤어도 자동 식별이 바꾸지 않는다.
  const ck1Seat = (await ck.getMatchDetail("verify-cup:ck1"))?.participants.find((p) => p.participant_id === 1);
  check("★ 사람이 검수한 경기의 정해진 자리는 자동 식별이 건드리지 않는다",
    reviewedLink.status === "ok" && reviewedLink.linked === 0 && reviewedLink.kept.join(",") === "1"
      && ck1Seat?.streamer_id === null && ck1Seat?.puuid === alphaPuuid, JSON.stringify(reviewedLink));

  // ── 프레임 안 붙은 경기가 검수 화면에서 사라지나 (검수 피드백 #2)
  //
  // ⚠ 예전엔 매치 목록을 **근거 프레임에서만** 모았다. 후보가 가리키고 공개까지 된 경기가
  //   프레임을 안 붙였다는 이유로 화면에서 통째로 사라졌고, 검수자는 존재를 모른다.
  const frameless = await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:frameless",
    played_at: new Date("2026-09-21T03:00:00Z"), winning_team: 200,
    result_evidence: "결과창은 봤지만 프레임을 안 붙였다", evidence_frame_ids: [],
    participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, champion_id: 157 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, champion_id: 238 },
    ],
  });
  await ck.mergeLeadCandidates(leadId, [{
    id: "c-frameless", at: [11000, 11500], conclusion: "match", match_id: "verify-cup:frameless",
    observed: "결과창", why: "근거 프레임을 못 붙였다",
  }]);
  const wsFrameless = await ck.getLeadWorkspace(leadId);
  check("★★ 근거 프레임이 없어도 **후보가 가리키는 경기**는 검수 화면에 나온다",
    frameless === true && (wsFrameless?.matches ?? []).some((m) => m.match.match_id === "verify-cup:frameless"),
    (wsFrameless?.matches ?? []).map((m) => m.match.match_id).join(","));

  const wsEvents = wsFrameless?.events ?? [];
  check("★ 검수 화면이 대회 목록을 같이 받는다 (분류는 대회에서 나온다 — 못 붙이면 '기타')",
    wsEvents.length > 0, `${wsEvents.length}개`);

  console.log("\n▸ 보존 계약 — 재수집·동시 편집·공개 경계 (2차 검수 지적)");

  // ── 부분 재조사가 이전 실행 기록을 지우나 (지적 #3a)
  //
  // ⚠ jsonb 의 `||` 는 최상위 키를 통째로 바꾼다. 부분 범위만 다시 돌린 기록을 보내면
  //   requested·failed·opened 가 전부 날아갔다. "어디까지 봤나" 는 결론만큼 중요한 기록이다.
  const scanLead = await ck.upsertEventLead({
    source: "vod_title", source_key: "vod:9990003", title: "부분 재조사",
    channel_id: "ch3", observed_at: new Date("2026-09-21T10:00:00Z"), state: "confirmed",
  });
  await ck.markLeadScan(scanLead, {
    status: "done", requested: [[0, 40000]], sampled: [[0, 40000]],
    failed: [[600, 900], [30000, 30500]], opened: [100, 200], signals: ["frame"], version: "v1",
  });
  // 며칠 뒤 한 구간만 다시 팠다 — 그 구간에 600~900 이 들어 있다
  const merged = await ck.markLeadScan(scanLead, {
    status: "done", requested: [[500, 1200]], sampled: [[500, 1200]], opened: [700], version: "v1",
  });
  check("★★ 부분 재조사가 이전 실행 기록을 지우지 않는다 (누적)",
    JSON.stringify(merged.requested) === JSON.stringify([[0, 40000]])
      && JSON.stringify(merged.opened) === JSON.stringify([100, 200, 700]),
    JSON.stringify({ requested: merged.requested, opened: merged.opened }));
  check("★★ sampled 만으로는 이전 실패를 해소하지 않는다",
    JSON.stringify(merged.failed) === JSON.stringify([[600, 900], [30000, 30500]]),
    JSON.stringify(merged.failed));
  const resolvedScan = await ck.markLeadScan(scanLead, {status:"done"}, {resolved_failed:[[600,900]]});
  check("실제로 해소했다고 명시한 실패 구간만 제거한다", JSON.stringify(resolvedScan.failed) === JSON.stringify([[30000,30500]]));
  const replaced = await ck.markLeadScan(scanLead, { status: "running", version: "v2" }, { mode: "replace" });
  check("★ 기록이 틀렸을 때는 명시적으로 갈아엎을 수 있다 (mode:'replace')",
    replaced.requested === undefined && replaced.status === "running", JSON.stringify(replaced));

  // ── 재수집이 사람이 고친 프레임 연결을 되돌리나 (지적 #3b)
  //   사람은 프레임의 **경기 연결**만 고친다(관찰문은 조사 기록이라 검수 화면에서 뺐다).
  const humanFrame = await ck.recordEvidenceFrames(leadId, [
    { frame_path: "out/ck/2026-09-20/human.jpg", at_sec: 12345, kind: "result", note: "스킬이 적은 메모", read: true },
  ]);
  // 이력 검사를 위해 실제로 옮겼다가 푼다(null→null 은 변경이 아니라 이력도 없다).
  await ck.relinkEvidenceFrame(humanFrame[0].id, "verify-cup:ck1");
  await ck.relinkEvidenceFrame(humanFrame[0].id, null);
  // 같은 VOD 를 다시 훑었다 — 다른 메모와 원래 연결을 들고 온다
  await ck.recordEvidenceFrames(leadId, [
    { frame_path: "out/ck/2026-09-20/human.jpg", at_sec: 12345, kind: "result", note: "재수집이 새로 적은 메모" },
  ]);
  await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:ck2x", played_at: new Date("2026-09-21T04:00:00Z"), winning_team: 100,
    result_evidence: "재수집", evidence_frame_ids: [humanFrame[0].id],
    participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, champion_id: 157 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, champion_id: 238 },
    ],
  });
  const [frameNow] = await sqlClient()<{ note: string; match_id: string | null }[]>`
    SELECT r.body AS note, f.match_id
      FROM match_evidence_frame f
      LEFT JOIN review_record r ON r.frame_id = f.id AND r.type = 'observation'
     WHERE f.id = ${humanFrame[0].id}::uuid
  `;
  check("★★ 사람이 연결을 고친 프레임은 재수집이 기록도 덮지 않는다 (경기의 reviewed_at 과 같은 계약)",
    frameNow.note === "스킬이 적은 메모", JSON.stringify(frameNow.note));
  const frameHistory = await ck.listReviewChanges({ lead_id: leadId });
  check("★ 프레임 연결을 옮긴 것은 이력에 남는다 (0042)",
    frameHistory.some((c) => c.entity === "frame" && c.entity_key === humanFrame[0].id && c.field === "match_id" && c.after === null),
    JSON.stringify(frameHistory.filter((c) => c.entity === "frame")));
  check("★★ 사람이 **끊어 둔 프레임 연결**을 재수집이 되살리지 않는다",
    frameNow.match_id === null, String(frameNow.match_id));

  // ── 대회 분류를 바꾸면 저장된 파생 분류가 갈라지나 (지적 #5)
  //
  // ⚠ match 쪽 분류는 질의 시점 계산(뷰), encounter·champion_stat 은 **저장된 컬럼**이다.
  //   kind 만 바꾸면 공개 경기는 tournament 인데 상대전적은 ck 인 채로 갈라졌다.
  const catEvent = await tournaments.ensureEvent({ slug: "verify-cat", name: "분류시험", kind: "ck" });
  await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cat:g1", event_id: catEvent,
    played_at: new Date("2026-09-21T05:00:00Z"), winning_team: 200, result_evidence: "결과창",
    participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, champion_id: 51, kills: 1, deaths: 1, assists: 1 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, champion_id: 22, kills: 2, deaths: 2, assists: 2 },
    ],
  });
  await sqlClient()`UPDATE match SET reviewed_at = now() WHERE match_id = 'verify-cat:g1'`;
  await tournaments.updateEvent("verify-cat", { kind: "tournament" });
  const catPub = await sqlClient()<{ category: string }[]>`
    SELECT category FROM core_public.match WHERE match_id = 'verify-cat:g1'
  `;
  const catEnc = await sqlClient()<{ category: string }[]>`
    SELECT DISTINCT category FROM streamer_encounter WHERE match_id = 'verify-cat:g1'
  `;
  const catChamp = await sqlClient()<{ category: string }[]>`
    SELECT DISTINCT category FROM champion_stat WHERE champion_id = 51
  `;
  check("★★ 대회 분류를 바꾸면 **저장된 파생 분류도 따라간다** (경기·조우·챔피언 통계가 갈리지 않는다)",
    catPub[0]?.category === "tournament" && catEnc[0]?.category === "tournament"
      && catChamp[0]?.category === "tournament",
    JSON.stringify({ 공개: catPub[0]?.category, 조우: catEnc[0]?.category, 챔피언: catChamp[0]?.category }));

  // ── 대회를 찾는 쪽과 고치는 쪽을 나눴나 (0035 — 멸망전 4개가 'ck' 로 덮인 사고)
  //
  // ★ VOD 조사 반영은 대회를 **읽기만** 해야 한다. 예전 upsertEvent 는 입력에 없는 칸까지
  //   null·기본값으로 덮어, 분류가 'ck' 로 바뀌고 주최·기간·출처가 사라졌다.
  const ownerId = await tournaments.ensureEvent({
    slug: "verify-owner", name: "주인 있는 대회", kind: "tournament", organizer: "SOOP",
    starts_at: "2020-03-12", source_url: "https://example.com/wiki",
  });
  const linkedId = await tournaments.ensureEvent({ slug: "verify-owner" });
  const [ownerRow] = await sqlClient()<{ name: string; kind: string; organizer: string | null; source_url: string | null }[]>`
    SELECT name, kind, organizer, source_url FROM event WHERE slug = 'verify-owner'
  `;
  check("★★ 기존 대회에 연결만 하면 아무 칸도 바뀌지 않는다 (분류·주최·출처)",
    linkedId === ownerId && ownerRow.kind === "tournament" && ownerRow.organizer === "SOOP"
      && ownerRow.source_url === "https://example.com/wiki" && ownerRow.name === "주인 있는 대회",
    JSON.stringify(ownerRow));
  await expectReject("★★ 연결하면서 다른 분류를 주면 덮지 않고 멈춘다",
    () => tournaments.ensureEvent({ slug: "verify-owner", kind: "ck" }), "이미 tournament");
  await expectReject("새 대회는 분류 없이 못 만든다 — 기본값이 없다",
    () => tournaments.ensureEvent({ slug: "verify-nokind", name: "분류 없음" }), "분류(kind)가 필요");
  await expectReject("새 대회는 이름 없이 못 만든다 — slug 로 대신하지 않는다",
    () => tournaments.ensureEvent({ slug: "verify-noname", kind: "ck" }), "이름이 필요");
  await expectReject("DB 에도 분류 기본값이 없다 — 빠뜨린 INSERT 는 거부된다",
    async () => { await sqlClient()`INSERT INTO event (slug, name) VALUES ('verify-raw', '원시 삽입')`; },
    "kind");
  await tournaments.updateEvent("verify-owner", { starts_at: null, ends_at: undefined });
  const [patched] = await sqlClient()<{ starts_at: Date | null; organizer: string | null }[]>`
    SELECT starts_at, organizer FROM event WHERE slug = 'verify-owner'
  `;
  check("★ 대회 수정은 생략한 칸을 유지하고, 명시한 null 만 비운다",
    patched.starts_at === null && patched.organizer === "SOOP", JSON.stringify(patched));

  // ── 시리즈 라운드명·세트 순서 (0035)
  await sqlClient().begin(async (tx) => {
    await ensureMatchSeries(tx, { id: "verify-owner:g01", game_code: "lol", event_id: ownerId, round_label: "8강 1경기", set_order_known: true });
    await ensureMatchSeries(tx, { id: "verify-owner:g01", game_code: "lol", event_id: ownerId, round_label: "8강 1경기", set_order_known: false });
  });
  const [roundRow] = await sqlClient()<{ round_label: string; set_order_known: boolean }[]>`
    SELECT round_label, set_order_known FROM match_series WHERE id = 'verify-owner:g01'
  `;
  check("★ 확인된 세트 순서는 '모름' 입력으로 내려가지 않는다",
    roundRow.round_label === "8강 1경기" && roundRow.set_order_known === true, JSON.stringify(roundRow));
  await expectReject("★ 같은 시리즈에 다른 라운드명이 오면 하나를 고르지 않고 멈춘다",
    () => sqlClient().begin((tx) => ensureMatchSeries(tx, {
      id: "verify-owner:g01", game_code: "lol", event_id: ownerId, round_label: "4강 1경기",
    })), "라운드명은 이미");

  // ── 단서↔경기 연결은 뷰 하나 · 끊어진 후보 참조는 들어오지 못한다 (0035)
  const linkRows = await sqlClient()<{ n: number; distinct_n: number }[]>`
    SELECT count(*)::int AS n, count(DISTINCT (lead_id, match_id))::int AS distinct_n FROM lead_match
  `;
  check("★ lead_match 는 (단서, 경기) 를 중복 없이 돌려준다 — 경기 수·검수 수가 같은 집합에서 나온다",
    linkRows[0].n === linkRows[0].distinct_n && linkRows[0].n > 0, JSON.stringify(linkRows[0]));
  // 다른 절이 세는 검증 VOD(leadId)를 흔들지 않게 전용 단서를 쓴다.
  const candLead = await ck.upsertEventLead({
    source: "vod_title", source_key: "vod:candidate-order", title: "후보 순서 시험",
    observed_at: new Date("2026-09-20T20:00:00Z"),
  });
  await expectReject("★★ 자동 후보 병합도 없는 경기 ID 를 저장하지 않는다 (혼자 커밋하는 길도 같은 관문)",
    () => ck.mergeLeadCandidates(candLead, [{ id: "verify-dangling", at: [1, 2], conclusion: "linked", match_id: "does-not-exist" }]),
    "없는 경기");
  await expectReject("★★ '경기 반영'이라고 적으려면 어느 경기인지 있어야 한다 — 연결 없는 반영 후보를 새로 만들지 않는다",
    () => ck.mergeLeadCandidates(candLead, [{ id: "verify-no-link", at: [5, 6], conclusion: "match" }]),
    "match_id 가 있어야");
  // 같은 트랜잭션에서는 후보를 먼저 넣고 경기를 뒤에 만들어도 된다 — 검사는 끝에서 한 번.
  await sqlClient().begin(async (tx) => {
    await ck.mergeLeadCandidatesInTx(tx, candLead, [{ id: "verify-later", at: [3, 4], conclusion: "match", match_id: "verify-cup:later" }]);
    await tx`INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, winning_team, source, origin)
             VALUES ('verify-cup:later', 'lol', 0, '0', now(), 100, 'manual', 'vod_scan')`;
    await ck.assertCandidateMatchesExistInTx(tx, [candLead]);
  });
  check("같은 트랜잭션에서 후보가 경기보다 먼저 와도 끝의 검사는 통과한다",
    ((await ck.getEventLead(candLead))?.raw.candidates ?? []).some((c) => c.id === "verify-later"));
  const dangling = await sqlClient()<{ n: number }[]>`SELECT count(*)::int AS n FROM lead_candidate_dangling`;
  check("★ 없는 경기를 가리키는 후보가 0 이다", dangling[0].n === 0, `${dangling[0].n}건`);

  // ── 두 검수자가 낡은 폼으로 서로를 덮나 (지적 #7)
  const eA = await ck.getMatchDetail("verify-cat:g1");
  const eB = await ck.getMatchDetail("verify-cat:g1");   // 같은 원본을 둘이 읽었다
  await ck.applyMatchReview("verify-cat:g1", {
    participants: { patch: [{ participant_id: 1, changes: { kills: 10 }, expect: { kills: eA!.participants[0].kills } }] },
  });
  // B 는 **다른 칸**을 고친다 — 부딪히지 않아야 한다
  await ck.applyMatchReview("verify-cat:g1", {
    participants: { patch: [{ participant_id: 1, changes: { assists: 7 }, expect: { assists: eB!.participants[0].assists } }] },
  });
  const [bothSaved] = await sqlClient()<{ kills: number; assists: number }[]>`
    SELECT kills, assists FROM match_participant WHERE match_id='verify-cat:g1' AND participant_id=1
  `;
  check("★★ 두 검수자가 **다른 칸**을 고치면 둘 다 남는다 (폼 전체를 덮지 않는다)",
    bothSaved.kills === 10 && bothSaved.assists === 7, JSON.stringify(bothSaved));

  await expectReject(
    "★★ **같은 칸**을 낡은 값으로 덮으려 하면 거부하고 최신 값을 알려준다",
    () => ck.applyMatchReview("verify-cat:g1", {
      participants: { patch: [{ participant_id: 1, changes: { kills: 3 }, expect: { kills: eB!.participants[0].kills } }] },
    }),
    "다른 검수자가",
  );

  // ── 숨긴 계정의 식별자가 공개 계약에 남나 (지적 #8)
  //
  // ⚠ puuid 와 streamer_id 가 **함께** 있는 행에서만 터진다 — VOD 판독으로 손수 이은
  //   참가자의 모양이다. 공개 큐 수집분은 streamer_id 가 비어 있어 행째로 빠졌다.
  await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:hidden", played_at: new Date("2026-09-21T06:00:00Z"), winning_team: 100,
    result_evidence: "결과창", participants: [
      { participant_id: 1, puuid: alphaPuuid, streamer_id: s1.id, team_id: 100, champion_id: 157 },
      { participant_id: 2, streamer_id: s2.id, team_id: 200, champion_id: 238 },
    ],
  });
  const beforeHide = await sqlClient()<{ puuid: string | null }[]>`
    SELECT puuid FROM core_public.match_participant WHERE match_id = 'verify-cup:hidden' ORDER BY team_id
  `;
  await sqlClient()`UPDATE streamer_account SET visibility = 'hidden' WHERE puuid = ${alphaPuuid}`;
  const afterHide = await sqlClient()<{ streamer_id: string; puuid: string | null }[]>`
    SELECT streamer_id, puuid FROM core_public.match_participant WHERE match_id = 'verify-cup:hidden' ORDER BY team_id
  `;
  check("★★ 계정을 숨기면 **그 puuid 가 공개 계약에서 사라진다** (부계정 오노출은 실제 분쟁이 된다)",
    beforeHide[0]?.puuid === alphaPuuid && afterHide.every((r) => r.puuid !== alphaPuuid),
    JSON.stringify({ 전: beforeHide[0]?.puuid?.slice(0, 8), 후: afterHide.map((r) => r.puuid) }));
  check("★ 그래도 **참가 기록은 남는다** — 식별자만 지우는 방침이다(0021)",
    afterHide.length === 2 && afterHide.some((r) => r.streamer_id === s1.id),
    `${afterHide.length}행`);
  // ★ streamer_match(0075)는 참가자 뷰의 공개 판정을 속도 때문에 두 갈래로 옮겨 적은 것이다.
  //   한쪽만 고치면 프로필과 로스터가 다른 사람을 말한다 — 숨긴 계정이 있는 지금과 되돌린 뒤 둘 다 대조한다.
  const streamerMatchDrift = async () => (await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      (SELECT streamer_id, match_id, participant_id FROM core_public.match_participant WHERE streamer_id IS NOT NULL
       EXCEPT ALL SELECT streamer_id, match_id, participant_id FROM core_public.streamer_match)
      UNION ALL
      (SELECT streamer_id, match_id, participant_id FROM core_public.streamer_match
       EXCEPT ALL SELECT streamer_id, match_id, participant_id FROM core_public.match_participant WHERE streamer_id IS NOT NULL)
    ) d`)[0].n;
  const driftHidden = await streamerMatchDrift();
  await sqlClient()`UPDATE streamer_account SET visibility = 'public' WHERE puuid = ${alphaPuuid}`;
  const driftPublic = await streamerMatchDrift();
  check("★ streamer_match 는 참가자 뷰에서 사람이 붙은 자리와 **같은 행**이다 (계정 숨김 상태 포함, 0075)",
    driftHidden === 0 && driftPublic === 0, JSON.stringify({ 숨김: driftHidden, 공개: driftPublic }));

  // ── 미확인 참가자가 로스터에 서나 (0022)
  //
  // ⚠ 예전엔 `streamer_id` 가 없다는 이유로 공개 뷰에서 행째로 빠졌다. 그래서 5대5 가
  //   **4명으로** 그려졌고, 보는 사람은 누락인지 인원 차이인지 구분할 수 없었다.
  await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:unknown", played_at: new Date("2026-09-21T10:00:00Z"), winning_team: 100,
    result_evidence: "결과창 — 한 명은 우리 명단에 없다",
    participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, champion_id: 157, kills: 5, deaths: 1, assists: 2 },
      { participant_id: 2, observed_name: "소년가장 원딜", team_id: 100, champion_id: 34, kills: 3, deaths: 8, assists: 7 },
      { participant_id: 3, puuid: betaPuuid, team_id: 200, champion_id: 238, kills: 1, deaths: 5, assists: 0 },
    ],
  });
  const roster = await sqlClient()<{ streamer_id: string | null; observed_name: string | null; champion_id: number }[]>`
    SELECT streamer_id, observed_name, champion_id FROM core_public.match_participant
     WHERE match_id = 'verify-cup:unknown' ORDER BY champion_id
  `;
  const unknownSeat = roster.find((r) => r.streamer_id === null);
  check("★★ 사람을 못 붙인 자리도 **공개 로스터에 선다** (5대5 를 4명으로 그리면 안 된다)",
    roster.length === 3 && unknownSeat !== undefined,
    `${roster.length}자리`);
  check("★ 그 자리는 화면에서 읽은 인게임명으로 나온다 (챔피언·KDA 도 같이)",
    unknownSeat?.observed_name === "소년가장 원딜" && unknownSeat?.champion_id === 34,
    JSON.stringify(unknownSeat));
  const namedSeat = roster.find((r) => r.streamer_id !== null);
  check("★ 등록된 사람은 observed_name 을 안 내보낸다 (부계정 인게임명을 덧붙일 이유가 없다)",
    namedSeat?.observed_name === null, JSON.stringify(namedSeat));

  // 숨김이 이 문으로 새지 않나 — 0021 이 막은 것을 0022 가 다시 열면 안 된다
  await sqlClient()`UPDATE streamer_account SET visibility = 'hidden' WHERE puuid = ${alphaPuuid}`;
  const afterHidden = await sqlClient()<{ streamer_id: string | null; observed_name: string | null }[]>`
    SELECT streamer_id, observed_name FROM core_public.match_participant WHERE match_id = 'verify-cup:unknown'
  `;
  check("★★ 계정을 숨긴 자리가 '미확인' 으로 **둔갑해 되살아나지 않는다** (0021 을 0022 가 안 뚫는다)",
    afterHidden.length === 2 && !afterHidden.some((r) => r.streamer_id === null && r.observed_name === null),
    `${afterHidden.length}자리`);
  await sqlClient()`UPDATE streamer_account SET visibility = 'public' WHERE puuid = ${alphaPuuid}`;

  // ── 미확인 목록과 일괄 연결
  const unknownList = await ck.listUnidentifiedParticipants();
  const target = unknownList.find((u) => u.observed_name === "소년가장 원딜");
  check("★ 미확인 목록이 이름으로 묶여 나온다 (등장 횟수가 곧 조사 우선순위)",
    target !== undefined && target.seats >= 1 && target.match_ids.includes("verify-cup:unknown"),
    JSON.stringify({ seats: target?.seats, teammates: target?.teammates }));
  check("★ 같은 팀의 등록된 사람이 단서로 같이 온다 (사람 찾는 가장 센 실마리다)",
    (target?.teammates.length ?? 0) > 0, JSON.stringify(target?.teammates));

  const bulk = await ck.reviewUnidentifiedParticipants(target!.targets, s2.id);
  const afterBulk = await ck.getMatchDetail("verify-cup:unknown");
  const filled = afterBulk?.participants.find((p) => p.participant_id === 2);
  check("★★ 목록에서 선택한 미확인 자리를 검수로 연결한다",
    bulk.linked === 1 && filled?.streamer_id === s2.id,
    `${bulk.linked}자리 · 경기 ${bulk.matches.length}`);
  check("★★ 일괄 연결도 **판독값을 안 건드린다** (챔피언·KDA 그대로)",
    filled?.champion_id === 34 && filled?.kills === 3 && filled?.assists === 7,
    JSON.stringify(filled));
  const gone = await ck.listUnidentifiedParticipants();
  check("★ 붙이고 나면 목록에서 빠진다",
    !gone.some((u) => u.observed_name === "소년가장 원딜"), `${gone.length}건 남음`);

  // ── 관리자 보호와 수정 이력 (0042)
  //
  // 새 경기는 조사(ck:merge → upsertMatchFromScan)로만 만든다 — 검수 화면의 '새 경기 만들기'는 없앴다
  // (참가자 0명 경기가 즉시 공개되던 길). 사람은 공개될 값을 고치고, 고친 것은 전후 값이 이력에 남는다.
  await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:handmade", played_at: new Date("2026-09-21T07:00:00Z"), winning_team: 100,
    result_evidence: "조사가 남긴 최종 결과창",
    participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, champion_id: 157, kills: 4, deaths: 1, assists: 2 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, champion_id: 238, kills: 1, deaths: 4, assists: 0 },
    ],
  });
  const [storedEvidence] = await sqlClient()<{ canonical: string | null; created_by: string | null }[]>`
    SELECT rr.body AS canonical, rr.created_by
      FROM match m LEFT JOIN review_record rr ON rr.match_id=m.match_id AND rr.type='final_evidence'
     WHERE m.match_id='verify-cup:handmade'
  `;
  const [legacyColumn] = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_name = 'match' AND column_name = 'result_evidence'
  `;
  check("★★ 최종 결과 근거는 review_record 한 곳에만 있다 — match 에 옛 복사본 칸이 없다(0040)",
    storedEvidence.canonical === "조사가 남긴 최종 결과창" && legacyColumn.n === 0,
    JSON.stringify({ ...storedEvidence, legacyColumn: legacyColumn.n }));

  await ck.applyMatchReview("verify-cup:handmade", {
    match: { changes: { winning_team: 200 }, expect: { winning_team: 100 } },
    participants: { patch: [{ participant_id: 1, changes: { kills: 5 }, expect: { kills: 4 } }] },
  });
  const history = await ck.listReviewChanges({ match_id: "verify-cup:handmade" });
  check("★★ 관리자 수정은 전후 값이 이력에 남는다 — 승자 100→200, 1번 자리 킬 4→5 (0042)",
    history.some((c) => c.entity === "match" && c.field === "winning_team" && c.before === 100 && c.after === 200)
      && history.some((c) => c.entity === "participant" && c.entity_key === "1" && c.field === "kills" && c.before === 4 && c.after === 5),
    JSON.stringify(history.map((c) => [c.entity, c.entity_key, c.field, c.before, c.after])));
  await ck.applyMatchReview("verify-cup:handmade", {
    match: { changes: { winning_team: 200 }, expect: { winning_team: 200 } },
  });
  check("★ 값이 그대로인 저장은 이력을 남기지 않는다",
    (await ck.listReviewChanges({ match_id: "verify-cup:handmade" })).length === history.length);
  await ck.markMatchReviewed("verify-cup:handmade", false);
  await ck.markMatchReviewed("verify-cup:handmade", true);
  const toggles = (await ck.listReviewChanges({ match_id: "verify-cup:handmade" }))
    .filter((c) => c.field === "admin_protected").map((c) => `${c.before}→${c.after}`);
  check("★ 관리자 확인을 끄고 켠 것도 이력에 남는다", JSON.stringify(toggles) === JSON.stringify(["true→false", "false→true"]),
    JSON.stringify(toggles));

  // 관리자가 고친 경기는 자동 재수집이 덮지 않는다
  const rescanHandmade = await ck.upsertMatchFromScan({ played_at_precision: "datetime",
    match_id: "verify-cup:handmade", played_at: new Date("2026-09-21T09:00:00Z"), winning_team: 100,
    participants: [{ participant_id: 1, puuid: betaPuuid, team_id: 100, champion_id: 64 }],
  });
  const afterRescanHandmade = await ck.getMatchDetail("verify-cup:handmade");
  check("★★ 관리자가 고친 경기를 **재수집이 덮지 않는다**",
    rescanHandmade === false && afterRescanHandmade?.participants.length === 2
      && afterRescanHandmade?.match.winning_team === 200,
    `rescan=${rescanHandmade} 참가자=${afterRescanHandmade?.participants.length} 승자=${afterRescanHandmade?.match.winning_team}`);

  check("찾은 경기에 참가자 이름이 함께 온다 (같은 판인지 사람이 판정한다)",
    around.some((m) => m.participant_names.length > 0),
    JSON.stringify(around[0]?.participant_names));

  const framesBeforeDelete = await ck.listEvidenceFrames(leadId);
  const ck1FrameCount = framesBeforeDelete.filter((f) => f.match_id === "verify-cup:ck1").length;
  const nullsBefore = framesBeforeDelete.filter((f) => f.match_id === null).length;
  const frameReviewIds = framesBeforeDelete
    .filter((f) => f.match_id === "verify-cup:ck1")
    .map((f) => f.id);
  await sqlClient()`DELETE FROM match WHERE match_id = 'verify-cup:ck1'`;
  const framesAfterMatchDelete = await ck.listEvidenceFrames(leadId);
  // ⚠ 절대 개수로 재지 않는다 — 처음부터 미연결이던 프레임(뽑기만 한 것)이 섞여 있다.
  //   불변식은 "프레임은 하나도 안 사라지고, 그 경기 것만 미연결로 바뀐다" 다.
  check("매치가 지워져도 근거 프레임은 남는다(SET NULL) — 검수 화면이 놓친 것도 봐야 한다",
    framesAfterMatchDelete.length === framesBeforeDelete.length
      && framesAfterMatchDelete.filter((f) => f.match_id === null).length === nullsBefore + ck1FrameCount,
    JSON.stringify(framesAfterMatchDelete.map((f) => f.match_id)));
  const preservedFrameReviews = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM review_record
     WHERE frame_id=ANY(${frameReviewIds}::uuid[]) AND type='observation'
  `;
  check("★★ 경기를 지워도 남은 프레임의 관찰 기록은 같이 지워지지 않는다",
    preservedFrameReviews[0].n === frameReviewIds.length,
    `${preservedFrameReviews[0].n}/${frameReviewIds.length}`);

  await sqlClient()`DELETE FROM event_lead WHERE id = ${leadId}::uuid`;
  const framesAfterLeadDelete = await ck.listEvidenceFrames(leadId);
  check("lead 가 지워지면 그 근거 프레임도 같이 지워진다(CASCADE)", framesAfterLeadDelete.length === 0);
  const matchEvidenceAfterLeadDelete = await sqlClient()<{ body: string }[]>`
    SELECT body FROM review_record WHERE match_id='verify-cup:ck2' AND type='final_evidence'
  `;
  check("★★ VOD 단서를 지워도 확정된 경기의 최종 결과 근거는 남는다",
    matchEvidenceAfterLeadDelete[0]?.body === "1:10:00 결과창 그래프탭",
    matchEvidenceAfterLeadDelete[0]?.body ?? "없음");

  console.log("\n▸ 코드 내전 분류 · 계정 연결이 파생 데이터에 바로 반영되나 (0077)");
  {
    const g1 = await streamers.createStreamer({ slug: "verify-code-a", display_name: "코드내전A" });
    const g2 = await streamers.createStreamer({ slug: "verify-code-b", display_name: "코드내전B" });
    const [pA, pB] = ["ca".repeat(39), "cb".repeat(39)];
    await streamers.upsertRiotAccount({ puuid: pA, game_name: "코드A", tag_line: "KR1" });
    await streamers.upsertRiotAccount({ puuid: pB, game_name: "코드B", tag_line: "KR1" });
    await streamers.linkAccount({ streamer_id: g1.id, puuid: pA, confidence: "verified", evidence: { note: "검증" } });
    await sqlClient()`
      INSERT INTO match (match_id, game_code, platform_id, riot_game_id, queue_id, mode_key, game_mode,
                         game_creation, winning_team, source, tournament_code)
      VALUES ('KR_CODE1', 'lol', 'KR', 9001, 3130, '3130', 'CLASSIC', now(), 100, 'tournament_code', 'KR-verify')`;
    await sqlClient()`
      INSERT INTO match_participant
        (match_id, puuid, participant_id, team_id, team_position, individual_position, champion_id, outcome, kills, deaths, assists)
      VALUES ('KR_CODE1', ${pA}, 1, 100, 'MIDDLE', 'MIDDLE', 157, 'win', 5, 2, 7),
             ('KR_CODE1', ${pB}, 6, 200, 'MIDDLE', 'MIDDLE', 238, 'loss', 2, 5, 3)`;
    await ingestDb.rederiveEncounters(["KR_CODE1"]);
    const cat = await sqlClient()<{ category: string }[]>`SELECT category FROM core_public.match WHERE match_id = 'KR_CODE1'`;
    check("★ 대회가 안 붙은 토너먼트 코드 경기는 CK 가 아니라 '코드 내전'이다",
      cat[0]?.category === "code_custom", cat[0]?.category ?? "없음");

    const encOfMatch = async (id: string) => (await sqlClient()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM streamer_encounter WHERE match_id = ${id}`)[0].n;
    const encOf = () => encOfMatch("KR_CODE1");
    const statOf = async (id: string) => (await sqlClient()<{ n: number }[]>`
      SELECT coalesce(sum(games), 0)::int AS n FROM champion_stat WHERE streamer_id = ${id}::uuid AND season = 'ALL'`)[0].n;
    const encBefore = await encOf();
    await streamers.linkAccount({ streamer_id: g2.id, puuid: pB, confidence: "likely", evidence: { note: "검증" } });
    const [encLinked, statLinked] = [await encOf(), await statOf(g2.id)];
    check("★★ 계정을 연결하면 **워커 없이** 그 경기의 조우와 챔피언 통계가 바로 생긴다",
      encBefore === 0 && encLinked === 1 && statLinked === 1, JSON.stringify({ encBefore, encLinked, statLinked }));
    await streamers.unlinkAccount(g2.id, pB);
    const [encUnlinked, statUnlinked] = [await encOf(), await statOf(g2.id)];
    check("★★ 연결을 떼면 그 조우와 챔피언 통계도 바로 사라진다(유령 전적 없음)",
      encUnlinked === 0 && statUnlinked === 0, JSON.stringify({ encUnlinked, statUnlinked }));

    // 계정으로 붙은 사람(g1) + 참가자 행에 직접 적힌 사람(g2, VOD 판독 연결)이 섞인 경기.
    // 재파생 대상 찾기가 deriveEncounters 와 다르게 세면 한 번 고쳐도 영원히 "필요" 로 남는다(730경기 사고).
    await sqlClient()`
      INSERT INTO match (match_id, game_code, platform_id, riot_game_id, queue_id, mode_key, game_mode,
                         game_creation, winning_team, source, tournament_code)
      VALUES ('KR_CODE2', 'lol', 'KR', 9002, 3130, '3130', 'CLASSIC', now(), 100, 'tournament_code', 'KR-verify2')`;
    await sqlClient()`
      INSERT INTO match_participant (match_id, puuid, streamer_id, participant_id, team_id, champion_id, outcome)
      VALUES ('KR_CODE2', ${pA}, NULL, 1, 100, 157, 'win'),
             ('KR_CODE2', NULL, ${g2.id}::uuid, 6, 200, 238, 'loss')`;
    const needBefore = (await ingestDb.findMatchesNeedingEncounters(5000)).includes("KR_CODE2");
    await ingestDb.rederiveEncounters(["KR_CODE2"]);
    const needAfter = (await ingestDb.findMatchesNeedingEncounters(5000)).includes("KR_CODE2");
    check("★★ 계정 연결·직접 연결이 섞인 경기도 재파생 한 번이면 대상에서 빠진다 (매번 다시 돌지 않는다)",
      needBefore && !needAfter && (await encOfMatch("KR_CODE2")) === 1, JSON.stringify({ needBefore, needAfter }));

    console.log("\n▸ 칼바람은 하나로, 아레나·우르프는 어느 공개 화면에도 없다 (0078)");
    for (const [id, gid, queue, mode] of [
      ["KR_MAYHEM1", 9003, 2400, "KIWI"], ["KR_ARENA1", 9004, 1750, "CHERRY"], ["KR_URF1", 9005, 900, "URF"],
    ] as const) {
      await sqlClient()`
        INSERT INTO match (match_id, game_code, platform_id, riot_game_id, queue_id, mode_key, game_mode,
                           game_creation, winning_team, source)
        VALUES (${id}, 'lol', 'KR', ${gid}, ${queue}, ${String(queue)}, ${mode}, now(), 100, 'public_queue')`;
      await sqlClient()`
        INSERT INTO match_participant (match_id, puuid, streamer_id, participant_id, team_id, champion_id, outcome)
        VALUES (${id}, ${pA}, NULL, 1, 100, 157, 'win'),
               (${id}, NULL, ${g2.id}::uuid, 6, 200, 238, 'loss')`;
    }
    await ingestDb.rederiveEncounters(["KR_MAYHEM1", "KR_ARENA1", "KR_URF1"]);
    await ingestDb.recomputeChampionStats([g1.id]);
    const seen = async (view: string) => (await sqlClient().unsafe<{ match_id: string }[]>(
      `SELECT DISTINCT match_id FROM core_public.${view} WHERE match_id IN ('KR_MAYHEM1','KR_ARENA1','KR_URF1') ORDER BY 1`))
      .map((r) => r.match_id).join(",");
    const [pubMatch, pubEnc, aramMatch, aramEnc] =
      [await seen("match"), await seen("streamer_encounter"), await seen("aram_match"), await seen("aram_encounter")];
    check("★ 증강 칼바람(2400)은 game_mode 와 상관없이 칼바람 화면에만 있다",
      aramMatch === "KR_MAYHEM1" && aramEnc === "KR_MAYHEM1", JSON.stringify({ aramMatch, aramEnc }));
    check("★ 아레나·우르프는 협곡·칼바람 어느 공개 뷰에도 없다(원본은 남는다)",
      pubMatch === "" && pubEnc === ""
        && (await sqlClient()`SELECT 1 FROM match WHERE match_id IN ('KR_ARENA1','KR_URF1')`).length === 2,
      JSON.stringify({ pubMatch, pubEnc }));
    const statCats = (await sqlClient()<{ category: string }[]>`
      SELECT DISTINCT category FROM core_public.lol_champion_stat_all_modes
       WHERE streamer_id = ${g1.id}::uuid AND champion_id = 157 AND season = 'ALL' ORDER BY 1`).map((r) => r.category);
    const pubStat = await sqlClient()`
      SELECT 1 FROM core_public.champion_stat WHERE streamer_id = ${g1.id}::uuid AND category = 'excluded'`;
    check("★ 아레나·우르프 챔피언 통계는 공개 챔피언 통계에 없다",
      statCats.includes("excluded") && pubStat.length === 0, JSON.stringify(statCats));

    console.log("\n▸ 랜드는 히스토리에서 한 묶음·집계는 판 단위, 보너스 판은 묶음에만 보이고 집계에 없다 (0079)");
    const [landEv] = await sqlClient()<{ id: string }[]>`
      INSERT INTO event (slug, name, kind, game_code) VALUES ('verify-land', '검증 랜드', 'land', 'lol') RETURNING id`;
    const [ckEv] = await sqlClient()<{ id: string }[]>`
      INSERT INTO event (slug, name, kind, game_code) VALUES ('verify-bonus-ck', '검증 CK', 'ck', 'lol') RETURNING id`;
    await sqlClient()`INSERT INTO match_series (id, game_code, event_id, set_order_known) VALUES
      ('verify-land:land', 'lol', ${landEv.id}::uuid, true), ('verify-bonus-ck:s', 'lol', ${ckEv.id}::uuid, true)`;
    // 랜드 3판: g1 이 g2 와 적·아군·적 (팀이 매 판 섞인다). g1 기준 승·승·패.
    // CK 2판 본게임 g1 2:0 승 + 보너스 1판 g1 패.
    const games: [string, string, number, string, number, number][] = [
      ["VL1", "verify-land:land", 1, "main", 100, 200], ["VL2", "verify-land:land", 2, "main", 100, 100],
      ["VL3", "verify-land:land", 3, "main", 200, 200],
      ["VB1", "verify-bonus-ck:s", 1, "main", 100, 200], ["VB2", "verify-bonus-ck:s", 2, "main", 100, 200],
      ["VB3", "verify-bonus-ck:s", 3, "bonus", 200, 200],
    ];
    for (const [id, series, no, role, win, g2team] of games) {
      await sqlClient()`
        INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, game_creation, winning_team, source,
                           series_id, series_game_no, set_role, set_label, origin)
        VALUES (${id}, 'lol', 0, '0', 'CLASSIC', now() + ${no} * interval '1 hour', ${win}, 'manual',
                ${series}, ${no}, ${role}, ${role === "bonus" ? "범인찾기" : null}, 'vod_scan')`;
      await sqlClient()`
        INSERT INTO match_participant (match_id, puuid, streamer_id, participant_id, team_id, team_position, champion_id, outcome)
        VALUES (${id}, ${pA}, NULL, 1, 100, 'MIDDLE', 157, ${win === 100 ? "win" : "loss"}),
               (${id}, NULL, ${g2.id}::uuid, ${g2team === 100 ? 2 : 6}, ${g2team}, ${g2team === 100 ? "TOP" : "MIDDLE"}, 238,
                ${win === g2team ? "win" : "loss"})`;
    }
    await expectReject("본게임 시리즈 없이 보너스 판은 만들 수 없다", () => sqlClient()`
      INSERT INTO match (match_id, game_code, queue_id, game_creation, winning_team, source, origin, set_role)
      VALUES ('VB_ORPHAN', 'lol', 0, now(), 100, 'manual', 'vod_scan', 'bonus')`, "match_bonus_in_series");
    const ids = games.map((g) => g[0]);
    await ingestDb.rederiveEncounters(ids);
    await ingestDb.recomputeChampionStats([g1.id]);
    const listIn = async (view: string) => (await sqlClient().unsafe<{ match_id: string }[]>(
      `SELECT DISTINCT match_id FROM core_public.${view} WHERE match_id = ANY($1) ORDER BY 1`, [ids])).map((r) => r.match_id).join(",");
    check("★ 보너스 판은 집계용 경기·조우 뷰에 없고 히스토리용 뷰에만 있다",
      (await listIn("match")) === "VB1,VB2,VL1,VL2,VL3" && (await listIn("streamer_encounter")) === "VB1,VB2,VL1,VL2,VL3"
        && (await listIn("match_with_bonus")) === "VB1,VB2,VB3,VL1,VL2,VL3",
      JSON.stringify({ m: await listIn("match"), e: await listIn("streamer_encounter") }));
    const landKeys = await sqlClient()<{ match_id: string; series_key: string; category: string }[]>`
      SELECT match_id, series_key, category FROM core_public.streamer_encounter WHERE match_id IN ('VL1','VL3') ORDER BY 1`;
    check("★ 랜드 조우의 series_key 는 판 자신이다 — 상대전적의 매치 단위가 판이다",
      landKeys.every((r) => r.series_key === r.match_id && r.category === "land"), JSON.stringify(landKeys));
    const vs = (await publicDb.listOpponents(g1.id, { category: "land" })).find((o) => o.streamer_id === g2.id);
    check("★ 랜드 상대전적: 적으로 2판(1승 1패) = 매치 2개, 아군 1판",
      vs?.vs_sets === 2 && vs.vs_set_wins === 1 && vs.vs_matches === 2 && vs.vs_match_wins === 1 && vs.ally_sets === 1,
      JSON.stringify(vs));
    const ckVs = (await publicDb.listOpponents(g1.id, { category: "ck" })).find((o) => o.streamer_id === g2.id);
    check("★ CK 상대전적에 보너스 판이 없다 — 본게임 2:0 만", ckVs?.vs_sets === 2 && ckVs.vs_set_wins === 2
      && ckVs.vs_matches === 1 && ckVs.vs_match_wins === 1, JSON.stringify(ckVs));
    const hist = await personalDb.listPersonalMatches(g1.id, { category: "all" });
    const landRow = hist.find((h) => h.series_key === "verify-land:land");
    const ckRow = hist.find((h) => h.series_key === "verify-bonus-ck:s");
    check("★ 히스토리: 랜드 3판은 한 줄(2승 1패), CK 는 한 줄에 보너스까지 펼쳐지되 스코어는 2:0",
      landRow?.sets === 3 && landRow.set_wins === 2 && ckRow?.sets === 2 && ckRow.set_wins === 2
        && ckRow.match_ids.length === 3 && ckRow.set_roles[2] === "bonus" && ckRow.set_labels[2] === "범인찾기"
        && ckRow.set_labels[0] === "",
      JSON.stringify({ landRow, ckRow }));
    const recs = await personalDb.listPersonalRecords(g1.id, {});
    const landRec = recs.find((r) => r.category === "land");
    const ckRec = recs.find((r) => r.category === "ck");
    check("★ 개인 요약: 랜드는 판 단위(3경기 2승 1패), CK 는 보너스 없이 1경기 1승",
      landRec?.matches === 3 && landRec.wins === 2 && landRec.losses === 1 && ckRec?.matches === 1 && ckRec.wins === 1,
      JSON.stringify({ landRec, ckRec }));
    const statGames = (await sqlClient()<{ n: number }[]>`
      SELECT coalesce(sum(games), 0)::int AS n FROM champion_stat
       WHERE streamer_id = ${g1.id}::uuid AND season = 'ALL' AND category = 'ck'`)[0].n;
    check("★ 챔피언 통계에 보너스 판이 없다", statGames === 2, String(statGames));
  }

  await verifyScheduleDb(check, expectReject);
  await verifyPuuidMoveDb(check);
} finally {
  await closeDb();
  await server.stop();
  await db.close();
}

console.log(failures === 0 ? "\n전부 통과.\n" : `\n${failures}건 실패.\n`);
process.exit(failures === 0 ? 0 : 1);
