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
const publicDb = await import("../packages/core/lib/db/public.ts");
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
    "riot_account", "streamer", "streamer_account", "streamer_channel",
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

  // ── 경기 분류 ───────────────────────────────────────────────────
  //   화면 필터(전체 / 솔로랭크 / 내전 / 대회 …)의 기준이라, SQL 과 TS 가 어긋나면
  //   "내전만" 을 눌렀는데 대회가 섞여 나오는 식으로 **조용히** 거짓말을 한다.
  //   lp_absolute 와 같은 이유로 전 조합을 대조한다.
  console.log("\n▸ match_category — SQL 과 TS 가 같은 값을 낸다");
  const sources = ["public_queue", "tournament_code", "manual", "??"];
  const queues = [420, 440, 450, 400, 430, 490, 700, 3130, 0, 1700, null];
  const kinds = [null, "scrim", "tournament", "showmatch", "other", "??"];
  let catMismatch = 0, catCombos = 0;
  for (const source of sources) {
    for (const queue_id of queues) {
      for (const event_kind of kinds) {
        catCombos++;
        const res = await db.query<{ v: string }>(
          "SELECT lol_match_category($1, $2, $3) AS v", [source, queue_id, event_kind]);
        const ts = matchCategory({ source, queue_id, event_kind });
        if (res.rows[0].v !== ts) {
          catMismatch++;
          if (catMismatch <= 3) {
            console.log(`      ${source}/${queue_id}/${event_kind}: SQL=${res.rows[0].v} TS=${ts}`);
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
            unnest(ARRAY[NULL,'scrim','tournament','showmatch','other']) k`);
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
             CASE WHEN sa.slug = 'alpha' THEN se.a_win ELSE se.b_win END AS alpha_win
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
  await sqlClient()`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'alpha'`;

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
  const otherEventId = await tournaments.upsertEvent({
    slug: "verify-cup-2", name: "검증컵 2회", source_url: "https://example.com/2",
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
    noGame?.placement === "1차예선 탈락" && noGame?.matches === 0 && noGame?.sets === 0,
    JSON.stringify(noGame));

  const tally3 = await publicDb.summarizePlacements(s2.id);
  check("★ 예선 탈락도 횟수로 집계된다",
    tally3.buckets.find((b) => b.key === "qualifier")?.count === 1 && tally3.unknown === 0,
    JSON.stringify(tally3));

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
