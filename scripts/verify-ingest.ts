/**
 * 수집 엔진(A~D)을 **실제로 돌려서** 검증한다.
 *
 *   npm run verify:ingest
 *
 * Riot API 키가 없어도 돈다. 가짜는 HTTP 경계 하나뿐이고(scripts/fake-riot.ts),
 * 그 위의 `RiotClient`·엔진·DB 질의는 전부 운영에서 도는 코드 그대로다.
 *
 * 여기서 확인하는 것 — 전부 "돌려보지 않으면 모르는" 것들이다:
 *   · 언랭 계정도 rank_snapshot 에 자리가 남는가 (구멍과 언랭을 구분할 수 있는가)
 *   · spectator 전이를 본 계정만 match-v5 를 부르는가 (호출 낭비)
 *   · 백필 커서가 **반드시 내려가는가** (제자리걸음 = 영원한 루프)
 *   · 404 매치를 dead_match 에 넣고 다시 부르지 않는가
 *   · 신규 스트리머 등록 후 **과거 조우가 되살아나는가** (docs/PLAN.md §11-5)
 *   · 매핑을 풀면 조우가 사라지는가 (유령 전적)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { createFakeRiot, type FakeMatch } from "./fake-riot.ts";

const ROOT = join(import.meta.dirname, "..");
const PORT = Number(process.env.VERIFY_INGEST_PORT ?? 5434);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// ── 픽스처 ───────────────────────────────────────────────────────────

const PUUID_A = "a".repeat(78);
const PUUID_B = "b".repeat(78);
const PUUID_C = "c".repeat(78);
const STRANGER = "z".repeat(78);

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * KR_1002 를 **가운데**에 죽은 매치로 둔 게 핵심이다.
 * 백필이 404 를 만나고도 커서를 계속 내리는지 확인해야 한다.
 */
const MATCHES: FakeMatch[] = [
  {
    matchId: "KR_1003", gameCreation: NOW - 1 * HOUR, queueId: 420,
    roster: [
      { puuid: PUUID_A, teamId: 100, position: "MIDDLE", win: true, championId: 157 },
      { puuid: PUUID_B, teamId: 200, position: "MIDDLE", win: false, championId: 238 },
      { puuid: PUUID_C, teamId: 100, position: "TOP", win: true, championId: 86 },
    ],
  },
  { matchId: "KR_1002", gameCreation: NOW - 30 * DAY, queueId: 420, dead: true, roster: [] },
  {
    matchId: "KR_1001", gameCreation: NOW - 200 * DAY, queueId: 450, // 칼바람 — 라인이 없다
    roster: [
      { puuid: PUUID_A, teamId: 100, position: "MIDDLE", win: true, championId: 157 },
      { puuid: PUUID_B, teamId: 100, position: "BOTTOM", win: true, championId: 222 },
      { puuid: PUUID_C, teamId: 200, position: "TOP", win: false, championId: 86 },
    ],
  },
  {
    matchId: "KR_1000", gameCreation: NOW - 400 * DAY, queueId: 420,
    roster: [{ puuid: PUUID_A, teamId: 100, position: "MIDDLE", win: true, championId: 157 }],
  },
];

const fake = createFakeRiot({
  matches: MATCHES,
  history: {
    [PUUID_A]: ["KR_1003", "KR_1002", "KR_1001", "KR_1000"],
    [PUUID_B]: ["KR_1003", "KR_1001"],
    [PUUID_C]: ["KR_1003", "KR_1001"],
  },
  league: {
    [PUUID_A]: [{
      queueType: "RANKED_SOLO_5x5", tier: "DIAMOND", rank: "I",
      leaguePoints: 42, wins: 120, losses: 100, hotStreak: false,
    }],
    // B 는 언랭이다 — 응답이 빈 배열이다.
  },
  activeGames: {
    [PUUID_A]: {
      gameId: 9999, gameType: "MATCHED", gameQueueConfigId: 420,
      gameStartTime: NOW, platformId: "KR", gameMode: "CLASSIC", gameLength: 600,
      participants: [
        { puuid: PUUID_A, teamId: 100, championId: 157, riotId: "알파본계#KR1" },
        { puuid: STRANGER, teamId: 100, championId: 64, riotId: "행인#KR1" },
        { puuid: PUUID_C, teamId: 200, championId: 86, riotId: "감마본계#KR1" },
        // ★ 실전에서 첫 수집을 죽인 케이스. spectator-v5 는 puuid 가 없거나 빈
        //   참가자를 섞어서 준다. 이게 후보 테이블까지 흘러가면 NOT NULL 위반으로
        //   잡 전체가 죽는다. 여기 두 줄이 그 회귀를 막는다.
        { teamId: 200, championId: 22, riotId: "puuid없는참가자#KR1" },
        { puuid: "", teamId: 200, championId: 51, riotId: "puuid빈문자열#KR1" },
      ],
    },
  },
  riotIds: {
    [PUUID_A]: { gameName: "알파본계", tagLine: "KR1" },
    [PUUID_B]: { gameName: "베타본계", tagLine: "KR1" },
    [PUUID_C]: { gameName: "감마본계", tagLine: "KR1" },
  },
});

// ── 부팅 ─────────────────────────────────────────────────────────────

const pglite = await PGlite.create({ extensions: { pg_trgm, pgcrypto } });
const server = new PGLiteSocketServer({ db: pglite, port: PORT, host: "127.0.0.1" });
await server.start();

process.env.DATABASE_URL = `postgres://postgres@127.0.0.1:${PORT}/postgres`;
// PGlite 소켓 서버는 동시 연결을 못 받는다 (docs/SETUP.md §3).
process.env.DATABASE_POOL_MAX = "1";
process.env.RIOT_API_KEY = "RGAPI-fake-for-verification";
process.env.LIVE_LOOKBACK_DAYS = "3";
process.env.BACKFILL_BATCH = "25";

const { db: connect, closeDb } = await import("../packages/core/lib/db/client.ts");
const sql = connect();
const streamers = await import("../packages/core/lib/db/streamers.ts");
const ingest = await import("../packages/core/lib/db/ingest.ts");
const { loadConfig } = await import("../apps/worker/src/config.ts");
const { createContext } = await import("../apps/worker/src/context.ts");
const { runRankEngine } = await import("../apps/worker/src/engines/rank.ts");
const { runLiveEngine, createLiveState } = await import("../apps/worker/src/engines/live.ts");
const { runBackfillSlice } = await import("../apps/worker/src/engines/backfill.ts");
const { runDeriveEngine } = await import("../apps/worker/src/engines/derive.ts");
const { runJob } = await import("../apps/worker/src/job.ts");

const ctx = createContext(loadConfig(), { fetchImpl: fake.fetchImpl });

// 엔진을 직접 부르지 않고 운영과 같은 경로(runJob)로 부른다 — job_run 기록까지 검증된다.
const rankJob = () => runJob(ctx, "engine_a_rank", () => runRankEngine(ctx));
const liveJob = (s: ReturnType<typeof createLiveState>) =>
  runJob(ctx, "engine_b_live", () => runLiveEngine(ctx, s));
const backfillJob = () => runJob(ctx, "engine_c_backfill", () => runBackfillSlice(ctx));
const deriveJob = (opts: { championStats?: boolean }) =>
  runJob(ctx, "engine_d_derive", () => runDeriveEngine(ctx, opts));

try {
  await pglite.exec(readFileSync(join(ROOT, "db", "schema.sql"), "utf8"));

  console.log("\n▸ 시드");
  const alpha = await streamers.createStreamer({ slug: "alpha", display_name: "알파", platform_user_id: "alpha" });
  const beta = await streamers.createStreamer({ slug: "beta", display_name: "베타", platform_user_id: "beta" });
  for (const [streamer, puuid, name] of [[alpha, PUUID_A, "알파본계"], [beta, PUUID_B, "베타본계"]] as const) {
    await streamers.upsertRiotAccount({ puuid, game_name: name, tag_line: "KR1" });
    await streamers.linkAccount({
      streamer_id: streamer.id, puuid, is_main: true, confidence: "verified",
      evidence: { source: "broadcast_notice", url: "https://example.com/proof" },
    });
  }
  const targets = await ingest.listIngestTargets();
  check("수집 대상이 2계정이다", targets.length === 2, `${targets.length}건`);

  // ── Engine A ───────────────────────────────────────────────────────
  console.log("\n▸ Engine A — 랭크 스냅샷");
  const rank = await rankJob();
  check("2계정 처리", rank.processed === 2, JSON.stringify(rank.detail));

  const snaps = await sql<{ puuid: string; tier: string | null; lp_absolute: number | null }[]>`
    SELECT puuid, tier, lp_absolute FROM rank_snapshot
     WHERE queue_type = 'RANKED_SOLO_5x5' ORDER BY puuid
  `;
  check("스냅샷이 2건 (언랭 포함)", snaps.length === 2, `${snaps.length}건`);
  check("랭크 계정은 lp_absolute 가 계산된다",
    snaps[0].tier === "DIAMOND" && snaps[0].lp_absolute === 2400 + 300 + 42,
    `${snaps[0].tier} ${snaps[0].lp_absolute}`);
  check("언랭도 행이 남는다 (구멍과 구분 가능)",
    snaps[1].tier === null && snaps[1].lp_absolute === null);

  const profiles = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM riot_account
     WHERE summoner_id IS NOT NULL AND summoner_level = 512 AND last_rank_synced_at IS NOT NULL
  `;
  check("프로필(레벨·summonerId)도 같이 갱신된다", profiles[0].n === 2, `${profiles[0].n}건`);

  const rerun = await rankJob();
  check("같은 날 다시 돌려도 행이 늘지 않는다 (멱등)", rerun.processed === 2);
  const afterRerun = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM rank_snapshot`;
  check("rank_snapshot 총 건수 유지", afterRerun[0].n === snaps.length, `${afterRerun[0].n}건`);
  check("두 번째 실행은 프로필을 다시 안 받는다 (20시간 캐시)",
    fake.calls.summoner === 2, `summoner 호출 ${fake.calls.summoner}회`);

  // ── Engine B ───────────────────────────────────────────────────────
  console.log("\n▸ Engine B — 신규 매치 따라잡기");
  const liveState = createLiveState();
  const live = await liveJob(liveState);
  check("첫 틱은 전수 조사(sweep)", live.detail?.sweep === true);
  check("게임 중인 계정 1개를 감지", live.detail?.inGame === 1, JSON.stringify(live.detail));

  const ingested = await sql<{ match_id: string }[]>`SELECT match_id FROM match ORDER BY match_id`;
  check("최근 매치만 적재된다 (3일 lookback)",
    ingested.length === 1 && ingested[0].match_id === "KR_1003",
    ingested.map((m) => m.match_id).join(","));

  const parts = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM match_participant WHERE match_id = 'KR_1003'`;
  check("참가자 10인이 전부 저장된다 (조우 파생의 원본)", parts[0].n === 10, `${parts[0].n}명`);

  const enc1 = await sql<{ relation: string; is_lane_matchup: boolean; a_win: boolean }[]>`
    SELECT relation, is_lane_matchup, a_win FROM streamer_encounter WHERE match_id = 'KR_1003'
  `;
  check("조우 1쌍이 파생된다", enc1.length === 1, `${enc1.length}쌍`);
  check("반대 팀 같은 포지션 → 맞라인",
    enc1[0]?.relation === "opponent" && enc1[0]?.is_lane_matchup === true, JSON.stringify(enc1[0]));

  const cursors0 = await sql<{ puuid: string; last_match_synced_at: Date | null }[]>`
    SELECT puuid, last_match_synced_at FROM riot_account ORDER BY puuid
  `;
  check("적재한 계정의 매치 커서가 올라간다",
    cursors0.find((c) => c.puuid === PUUID_B)?.last_match_synced_at !== null);
  // A 는 지금 게임 중이다 — 끝나지 않은 경기를 조회하지 않았으므로 커서도 그대로여야 한다.
  check("게임 중인 계정의 커서는 건드리지 않는다",
    cursors0.find((c) => c.puuid === PUUID_A)?.last_match_synced_at === null);

  const cands = await sql<{ puuid: string; seen_count: number }[]>`
    SELECT puuid, seen_count FROM account_candidate ORDER BY puuid
  `;
  check("같은 로비의 미매핑 계정이 후보로 쌓인다 (자동 등록은 안 한다)",
    cands.length === 2, `${cands.length}건`);
  check("★ puuid 없는 spectator 참가자는 후보가 되지 않는다 (실전에서 잡을 죽인 케이스)",
    cands.every((c) => typeof c.puuid === "string" && c.puuid.length > 0),
    JSON.stringify(cands.map((c) => c.puuid)));

  // 두 번째 틱: sweep 이 아니고, A 는 여전히 게임 중이므로 match-v5 호출이 없어야 한다.
  const matchIdsBefore = fake.calls.matchIds;
  const live2 = await liveJob(liveState);
  check("sweep 이 아닌 틱은 전수 조회를 하지 않는다", live2.detail?.sweep === false);
  check("게임 중인 계정에는 match-v5 를 낭비하지 않는다",
    fake.calls.matchIds === matchIdsBefore,
    `matchIds ${matchIdsBefore} → ${fake.calls.matchIds}`);

  // ── Engine C ───────────────────────────────────────────────────────
  console.log("\n▸ Engine C — 백필");
  let slices = 0;
  for (;;) {
    const r = await backfillJob();
    if (r.exhausted) break;
    if (++slices > 20) { check("백필이 20슬라이스 안에 끝난다", false, "커서가 안 내려간다"); break; }
  }
  check(`백필이 ${slices}슬라이스로 끝난다 (무한 루프 없음)`, slices <= 20 && slices > 0);

  const all = await sql<{ match_id: string }[]>`SELECT match_id FROM match ORDER BY match_id`;
  check("과거 매치가 전부 적재된다",
    all.map((m) => m.match_id).join(",") === "KR_1000,KR_1001,KR_1003",
    all.map((m) => m.match_id).join(","));

  const dead = await sql<{ match_id: string }[]>`SELECT match_id FROM dead_match`;
  check("404 매치는 dead_match 로 간다", dead.length === 1 && dead[0].match_id === "KR_1002",
    dead.map((d) => d.match_id).join(","));

  const matchCallsBefore = fake.calls.match;
  await backfillJob();
  check("죽은 매치를 다시 부르지 않는다", fake.calls.match === matchCallsBefore,
    `match ${matchCallsBefore} → ${fake.calls.match}`);

  const cursors = await sql<{ backfill_state: string; backfill_reached_end: boolean }[]>`
    SELECT backfill_state, backfill_reached_end FROM ingest_cursor ORDER BY puuid
  `;
  check("커서가 전부 done + 경계 도달", cursors.every((c) => c.backfill_state === "done" && c.backfill_reached_end),
    JSON.stringify(cursors));

  const aram = await sql<{ is_lane_matchup: boolean; relation: string }[]>`
    SELECT is_lane_matchup, relation FROM streamer_encounter WHERE match_id = 'KR_1001'
  `;
  check("칼바람 조우는 맞라인이 아니다 (같은 팀이므로 ally)",
    aram.length === 1 && aram[0].is_lane_matchup === false && aram[0].relation === "ally",
    JSON.stringify(aram));

  // ── Engine D ───────────────────────────────────────────────────────
  console.log("\n▸ Engine D — 신규 스트리머 등록 후 과거 조우 재파생");
  const before = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM streamer_encounter`;
  check("등록 전 조우는 2쌍 (알파–베타 × 2경기)", before[0].n === 2, `${before[0].n}쌍`);

  const gamma = await streamers.createStreamer({ slug: "gamma", display_name: "감마", platform_user_id: "gamma" });
  await streamers.upsertRiotAccount({ puuid: PUUID_C, game_name: "감마본계", tag_line: "KR1" });
  await streamers.linkAccount({
    streamer_id: gamma.id, puuid: PUUID_C, is_main: true, confidence: "likely",
    evidence: { note: "방송에서 본인이 화면에 띄움" },
  });

  const pending = await ingest.findMatchesNeedingEncounters();
  check("재파생이 필요한 경기를 찾아낸다", pending.length === 2, pending.join(","));

  const matchCallsBeforeDerive = fake.calls.match;
  const derive = await deriveJob({ championStats: true });
  check("Engine D 는 Riot 을 부르지 않는다", fake.calls.match === matchCallsBeforeDerive);

  const after = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM streamer_encounter`;
  check("★ 과거 조우가 되살아난다 — 3명 × 2경기 = 6쌍", after[0].n === 6,
    `${after[0].n}쌍 / ${JSON.stringify(derive.detail)}`);

  const gammaPairs = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM streamer_encounter
     WHERE streamer_a_id = ${gamma.id}::uuid OR streamer_b_id = ${gamma.id}::uuid
  `;
  check("감마의 조우 4쌍 (알파·베타 × 2경기)", gammaPairs[0].n === 4, `${gammaPairs[0].n}쌍`);

  const gammaLane = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM streamer_encounter
     WHERE match_id = 'KR_1003' AND is_lane_matchup
  `;
  check("탑–미드는 맞라인이 아니다 (KR_1003 의 맞라인은 여전히 1쌍)", gammaLane[0].n === 1, `${gammaLane[0].n}쌍`);

  const stats = await sql<{ season: string; games: number }[]>`
    SELECT season, sum(games)::int AS games FROM champion_stat GROUP BY season ORDER BY season
  `;
  check("champion_stat 이 'ALL' + 연도로 재계산된다", stats.length >= 2, JSON.stringify(stats));

  const idempotent = await deriveJob({});
  check("재파생을 다시 돌려도 할 일이 없다 (멱등)", idempotent.processed === 0,
    JSON.stringify(idempotent.detail));

  // ── 매핑 철회 ──────────────────────────────────────────────────────
  console.log("\n▸ 매핑을 풀면 조우도 사라진다 (유령 전적 방지)");
  await streamers.unlinkAccount(gamma.id, PUUID_C);
  const pruneRun = await deriveJob({});
  const afterUnlink = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM streamer_encounter`;
  check("감마의 조우 4쌍이 지워진다", afterUnlink[0].n === 2,
    `${afterUnlink[0].n}쌍 / ${JSON.stringify(pruneRun.detail)}`);

  // ── 운영 기록 ──────────────────────────────────────────────────────
  console.log("\n▸ job_run");
  const jobs = await sql<{ job: string; state: string; n: number }[]>`
    SELECT job, state, count(*)::int AS n FROM job_run GROUP BY job, state ORDER BY job
  `;
  check("실행 기록이 남는다", jobs.length > 0, jobs.map((j) => `${j.job}:${j.state}×${j.n}`).join(" "));
  check("실패한 잡이 없다", jobs.every((j) => j.state === "ok"), JSON.stringify(jobs));

  console.log(`\n  (가짜 Riot 호출: ${JSON.stringify(fake.calls)})`);
} finally {
  await closeDb();
  await server.stop();
  await pglite.close();
}

console.log(failures === 0 ? "\n전부 통과.\n" : `\n${failures}건 실패.\n`);
process.exit(failures === 0 ? 0 : 1);
