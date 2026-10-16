/**
 * 수집 엔진(A~C)을 **실제로 돌려서** 검증한다.
 *
 *   npm run verify:ingest
 *
 * Riot API 키가 없어도 돈다. 가짜는 HTTP 경계 하나뿐이고(scripts/fake-riot.ts),
 * 그 위의 `RiotClient`·엔진·DB 질의는 전부 운영에서 도는 코드 그대로다.
 *
 * 여기서 확인하는 것 — 전부 "돌려보지 않으면 모르는" 것들이다(docs/CLASSIFICATION-REDESIGN-PLAN.md §4):
 *   · 랭크 점수는 연결된 계정 **전원** — 지명과 무관하다. 언랭도 자리가 남는다(구멍과 구분)
 *   · 계정을 연결해도 수집 대상이 생기지 않는다(자동 백필 등록 없음)
 *   · 경기 기록은 지명 범위(collection_scope: 지명된 사람의 연결 계정·큐·기간)만 Riot 에 묻고, 범위 밖 판은 **저장하지 않는다**
 *   · 지명 판은 개인 기록(personal), 참가자 10명은 기본 칸만, 상세는 **지명 계정 행만**
 *   · spectator 전이를 본 계정만 match-v5 를 부르는가 (호출 낭비)
 *   · 백필 커서가 **반드시 내려가는가** (제자리걸음 = 영원한 루프), 404 는 dead_match 로 가고 다시 안 부른다
 *   · 나중에 지명한 계정의 상세가 빠진 판은 다시 받아 채운다
 *   · 토너먼트 코드 판은 내전 세트 — 날짜별 자동 미분류 묶음에 한 판짜리 시리즈, 후보는 승인 큐로만
 */

import { join } from "node:path";

import { applyAll } from "./lib/migrations.ts";

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

import { buildMatchDto, createFakeRiot, type FakeMatch } from "./fake-riot.ts";

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

const me = (puuid: string, teamId: number, position: string, win: boolean, championId: number) =>
  ({ puuid, teamId, position, win, championId });

/**
 * 지명: A 솔랭(60일 전부터 열림) · B 솔랭(60일 전부터 열림) · A 자유랭(100~50일 전, 끝남).
 * C 는 연결은 됐지만 지명이 없다 — 랭크만 쌓여야 한다.
 *
 * KR_1002 를 **가운데**에 죽은 매치로 둔 게 핵심이다 — 백필이 404 를 만나고도 커서를 계속 내리는지 본다.
 * 지명 밖 판 세 종류: 기간 전(KR_1000) · 지명 안 한 큐(KR_1004 칼바람) · 끝난 기간 뒤(KR_2002).
 */
const MATCHES: FakeMatch[] = [
  { matchId: "KR_1005", gameCreation: NOW - 30 * 60 * 1000, queueId: 420, roster: [me(PUUID_A, 100, "MIDDLE", true, 157)] },
  {
    matchId: "KR_1003", gameCreation: NOW - 1 * HOUR, queueId: 420,
    roster: [me(PUUID_A, 100, "MIDDLE", true, 157), me(PUUID_B, 200, "MIDDLE", false, 238), me(PUUID_C, 100, "TOP", true, 86)],
  },
  { matchId: "KR_1004", gameCreation: NOW - 2 * HOUR, queueId: 450, roster: [me(PUUID_A, 100, "MIDDLE", true, 157)] },
  { matchId: "KR_1002", gameCreation: NOW - 30 * DAY, queueId: 420, dead: true, roster: [] },
  {
    matchId: "KR_1001", gameCreation: NOW - 20 * DAY, queueId: 420,
    roster: [me(PUUID_A, 100, "MIDDLE", true, 157), me(PUUID_B, 100, "BOTTOM", true, 222)],
  },
  { matchId: "KR_0999", gameCreation: NOW - 15 * DAY, queueId: 420, roster: [me(PUUID_B, 200, "BOTTOM", false, 222)] },
  { matchId: "KR_1000", gameCreation: NOW - 400 * DAY, queueId: 420, roster: [me(PUUID_A, 100, "MIDDLE", true, 157)] },
  { matchId: "KR_2001", gameCreation: NOW - 70 * DAY, queueId: 440, roster: [me(PUUID_A, 100, "TOP", true, 86)] },
  { matchId: "KR_2002", gameCreation: NOW - 40 * DAY, queueId: 440, roster: [me(PUUID_A, 100, "TOP", true, 86)] },
];

const activeGames: Record<string, unknown> = {
  [PUUID_A]: {
    gameId: 9999, gameType: "MATCHED", gameQueueConfigId: 420,
    gameStartTime: NOW, platformId: "KR", gameMode: "CLASSIC", gameLength: 600,
    participants: [
      { puuid: PUUID_A, teamId: 100, championId: 157, riotId: "알파본계#KR1" },
      { puuid: STRANGER, teamId: 100, championId: 64, riotId: "행인#KR1" },
      // ★ 실전에서 첫 수집을 죽인 케이스. spectator-v5 는 puuid 가 없거나 빈
      //   참가자를 섞어서 준다. 이게 후보 테이블까지 흘러가면 NOT NULL 위반으로
      //   잡 전체가 죽는다. 여기 두 줄이 그 회귀를 막는다.
      { teamId: 200, championId: 22, riotId: "puuid없는참가자#KR1" },
      { puuid: "", teamId: 200, championId: 51, riotId: "puuid빈문자열#KR1" },
    ],
  },
};

const fake = createFakeRiot({
  matches: MATCHES,
  history: {
    [PUUID_A]: ["KR_1005", "KR_1003", "KR_1004", "KR_1002", "KR_1001", "KR_2002", "KR_2001", "KR_1000"],
    [PUUID_B]: ["KR_1003", "KR_1001", "KR_0999"],
    [PUUID_C]: ["KR_1003"],
  },
  league: {
    [PUUID_A]: [{
      queueType: "RANKED_SOLO_5x5", tier: "DIAMOND", rank: "I",
      leaguePoints: 42, wins: 120, losses: 100, hotStreak: false,
    }],
    // B·C 는 언랭이다 — 응답이 빈 배열이다.
  },
  activeGames,
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
const collection = await import("../packages/core/lib/db/collection.ts");
type OrderInput = Parameters<typeof collection.createOrderInTx>[1];
const createOrder = (o: OrderInput) => sql.begin((tx) => collection.createOrderInTx(tx, o));
const { loadConfig } = await import("../apps/worker/src/config.ts");
const { createContext } = await import("../apps/worker/src/context.ts");
const { runRankEngine } = await import("../apps/worker/src/engines/rank.ts");
const { runLiveEngine, createLiveState } = await import("../apps/worker/src/engines/live.ts");
const { runBackfillSlice } = await import("../apps/worker/src/engines/backfill.ts");
const { runJob } = await import("../apps/worker/src/job.ts");

const ctx = createContext(loadConfig(), { fetchImpl: fake.fetchImpl });

// 엔진을 직접 부르지 않고 운영과 같은 경로(runJob)로 부른다 — job_run 기록까지 검증된다.
// (B·C 는 운영 DB 점검 관문을 지난다 — PGlite 에서도 실제 점검 질의가 돈다.)
const rankJob = () => runJob(ctx, "engine_a_rank", () => runRankEngine(ctx));
const liveJob = (s: ReturnType<typeof createLiveState>) =>
  runJob(ctx, "engine_b_live", () => runLiveEngine(ctx, s));
const backfillJob = () => runJob(ctx, "engine_c_backfill", () => runBackfillSlice(ctx));

const ids = async () => (await sql<{ match_id: string }[]>`SELECT match_id FROM match ORDER BY match_id`).map((m) => m.match_id).join(",");
const detailsOf = async (matchId: string) => (await sql<{ puuid: string }[]>`
  SELECT p.puuid FROM lol_participant_detail d JOIN match_participant p USING (match_id, participant_id)
   WHERE d.match_id = ${matchId} ORDER BY p.puuid`).map((r) => r.puuid[0]).join("");

try {
  await applyAll((sql) => pglite.exec(sql), ROOT);

  console.log("\n▸ 시드 — 계정 연결은 수집 대상을 만들지 않는다");
  const alpha = await streamers.createStreamer({ slug: "alpha", display_name: "알파", channel: { channel_id: "alpha" } });
  const beta = await streamers.createStreamer({ slug: "beta", display_name: "베타", channel: { channel_id: "beta" } });
  const gamma = await streamers.createStreamer({ slug: "gamma", display_name: "감마", channel: { channel_id: "gamma" } });
  for (const [streamer, puuid, name] of [[alpha, PUUID_A, "알파본계"], [beta, PUUID_B, "베타본계"], [gamma, PUUID_C, "감마본계"]] as const) {
    await streamers.upsertRiotAccount({ puuid, game_name: name, tag_line: "KR1" });
    await streamers.linkAccount({
      streamer_id: streamer.id, puuid, is_main: true, confidence: "verified",
      evidence: { source: "broadcast_notice", url: "https://example.com/proof" },
    });
  }
  const autoTargets = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM collection_scope`;
  check("★ 계정 3개를 연결해도 지명 수집 대상은 0 이다(자동 백필 등록 없음)", autoTargets[0].n === 0, `${autoTargets[0].n}건`);
  check("랭크 대상은 연결 계정 전원(3)", (await ingest.listRankTargets()).length === 3);

  const liveNothing = await liveJob(createLiveState());
  check("지명이 없으면 실시간 엔진은 Riot 을 부르지 않는다",
    liveNothing.processed === 0 && fake.matchIdsAsked.length === 0 && !fake.calls.spectator, JSON.stringify(liveNothing.detail));
  const backfillNothing = await backfillJob();
  check("지명이 없으면 백필은 비었다고 한다", backfillNothing.exhausted && fake.matchIdsAsked.length === 0);

  // 지명은 사람 단위다 — 알파·베타 듀오(솔랭), 알파 혼자(자유랭, 이미 끝난 기간).
  await createOrder({ slug: "verify-duo", title: "검증 듀오", owner: "module:verify/duo", queue_ids: [420], starts_at: new Date(NOW - 60 * DAY), members: ["alpha", "beta"] });
  await createOrder({
    slug: "verify-a-flex", title: "검증 알파 자유랭", owner: "module:verify/a-flex", queue_ids: [440],
    starts_at: new Date(NOW - 100 * DAY), ends_at: new Date(NOW - 50 * DAY), members: ["alpha"],
  });
  let rejected = false;
  try { await createOrder({ slug: "verify-bad", title: "목적 없음", owner: " ", queue_ids: [420], starts_at: new Date(NOW), members: ["alpha"] }); } catch { rejected = true; }
  check("목적 없는 지명은 거부한다", rejected);

  // ── Engine A ───────────────────────────────────────────────────────
  console.log("\n▸ Engine A — 랭크 스냅샷(연결 계정 전원)");
  const rank = await rankJob();
  check("★ 지명 없는 계정(감마)까지 3계정 처리", rank.processed === 3, JSON.stringify(rank.detail));

  const snaps = await sql<{ puuid: string; tier: string | null; lp_absolute: number | null }[]>`
    SELECT puuid, tier, lp_absolute FROM rank_snapshot
     WHERE queue_type = 'RANKED_SOLO_5x5' ORDER BY puuid
  `;
  check("스냅샷이 3건 (언랭 포함)", snaps.length === 3, `${snaps.length}건`);
  check("랭크 계정은 lp_absolute 가 계산된다",
    snaps[0].tier === "DIAMOND" && snaps[0].lp_absolute === 2400 + 300 + 42,
    `${snaps[0].tier} ${snaps[0].lp_absolute}`);
  check("언랭도 행이 남는다 (구멍과 구분 가능)",
    snaps[1].tier === null && snaps[1].lp_absolute === null);

  const profiles = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM riot_account
     WHERE summoner_id IS NOT NULL AND summoner_level = 512 AND last_rank_synced_at IS NOT NULL
  `;
  check("프로필(레벨·summonerId)도 같이 갱신된다", profiles[0].n === 3, `${profiles[0].n}건`);

  const rerun = await rankJob();
  check("같은 날 다시 돌려도 행이 늘지 않는다 (멱등)", rerun.processed === 3);
  const afterRerun = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM rank_snapshot`;
  check("rank_snapshot 총 건수 유지", afterRerun[0].n === snaps.length, `${afterRerun[0].n}건`);
  check("두 번째 실행은 프로필을 다시 안 받는다 (20시간 캐시)",
    fake.calls.summoner === 3, `summoner 호출 ${fake.calls.summoner}회`);
  check("★ 랭크는 경기 목록을 묻지 않는다", fake.matchIdsAsked.length === 0);

  // ── Engine B ───────────────────────────────────────────────────────
  console.log("\n▸ Engine B — 지명의 신규 판 따라잡기");
  const liveState = createLiveState();
  const live = await liveJob(liveState);
  check("첫 틱은 전수 조사(sweep)", live.detail?.sweep === true);
  check("실시간 대상은 열린 지명 2개(끝난 자유랭 지명은 빠진다) · 계정 2개",
    live.detail?.targets === 2 && live.detail?.accounts === 2, JSON.stringify(live.detail));
  check("게임 중인 지명 계정 1개를 감지", live.detail?.inGame === 1, JSON.stringify(live.detail));
  check("★ 지명 없는 감마 계정에는 spectator 도 목록 조회도 안 한다",
    fake.calls.spectator === 2 && fake.matchIdsAsked.every((a) => a.puuid !== PUUID_C), JSON.stringify(fake.matchIdsAsked));
  check("★ 목록 조회는 지명의 큐를 넘긴다", fake.matchIdsAsked.every((a) => a.queue === 420), JSON.stringify(fake.matchIdsAsked));

  check("최근 판만 적재된다 (3일 lookback, 게임 중인 A 는 건너뜀 → B 의 KR_1003)", (await ids()) === "KR_1003", await ids());
  const m1003 = await sql<{ scope: string; collected_via: string; series_id: string | null; map: string }[]>`
    SELECT scope, collected_via, series_id, map FROM match WHERE match_id = 'KR_1003'`;
  check("★ 지명 판은 개인 기록(personal)·api·시리즈 없음",
    m1003[0]?.scope === "personal" && m1003[0].collected_via === "api" && m1003[0].series_id === null && m1003[0].map === "rift",
    JSON.stringify(m1003[0]));
  const parts = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM match_participant WHERE match_id = 'KR_1003'`;
  check("참가자 10인이 전부 기본 칸으로 저장된다", parts[0].n === 10, `${parts[0].n}명`);
  check("★ 상세는 지명 계정(A·B)만 — 지명 없는 감마·일반인 7명은 없다", (await detailsOf("KR_1003")) === "ab", await detailsOf("KR_1003"));
  const detail = await sql<{ cs: number; items: number[]; challenges: Record<string, number> }[]>`
    SELECT d.cs, d.items, d.challenges FROM lol_participant_detail d JOIN match_participant p USING (match_id, participant_id)
     WHERE d.match_id = 'KR_1003' AND p.puuid = ${PUUID_A}`;
  check("상세 칸이 채워진다(CS·아이템 7칸·화면이 읽는 challenges 키)",
    detail[0]?.cs === 200 && detail[0].items.length === 7 && detail[0].challenges?.soloKills === 2, JSON.stringify(detail[0]));
  const pub = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM core_public.personal_game WHERE match_id = 'KR_1003'`;
  const pubVs = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM core_public.versus_set WHERE match_id = 'KR_1003'`;
  check("★ 개인 기록은 personal_game 에만 보이고 내전 세트(versus_set)에는 없다", pub[0].n === 10 && pubVs[0].n === 0,
    JSON.stringify({ personal: pub[0].n, versus: pubVs[0].n }));

  const synced = await sql<{ puuid: string; last_match_synced_at: Date | null }[]>`
    SELECT puuid, last_match_synced_at FROM riot_account ORDER BY puuid`;
  check("적재한 계정(B)의 최근 수집 시각이 표시용으로 올라간다",
    synced.find((c) => c.puuid === PUUID_B)?.last_match_synced_at !== null);
  check("게임 중인 계정(A)은 건드리지 않는다", synced.find((c) => c.puuid === PUUID_A)?.last_match_synced_at === null);

  const cands = await sql<{ puuid: string; seen_count: number }[]>`SELECT puuid, seen_count FROM account_candidate ORDER BY puuid`;
  check("같은 로비의 미매핑 계정이 후보로 쌓인다 (자동 등록은 안 한다)",
    cands.length === 1 && cands[0].puuid === STRANGER, JSON.stringify(cands.map((c) => c.puuid.slice(0, 4))));
  check("★ puuid 없는 spectator 참가자는 후보가 되지 않는다 (실전에서 잡을 죽인 케이스)",
    cands.every((c) => typeof c.puuid === "string" && c.puuid.length > 0));
  check("★ 지명 판(공개 큐)의 일반인은 후보가 되지 않는다 (승인 큐가 노이즈로 덮인다)",
    cands.every((c) => !c.puuid.startsWith("filler")));

  // 두 번째 틱: sweep 이 아니고, A 는 여전히 게임 중이므로 match-v5 호출이 없어야 한다.
  const asked1 = fake.matchIdsAsked.length;
  const live2 = await liveJob(liveState);
  check("sweep 이 아닌 틱은 전수 조회를 하지 않는다", live2.detail?.sweep === false);
  check("게임 중인 계정에는 match-v5 를 낭비하지 않는다", fake.matchIdsAsked.length === asked1,
    `matchIds ${asked1} → ${fake.matchIdsAsked.length}`);

  // 세 번째 틱: A 의 게임이 끝났다 → A 의 지명만 따라잡는다. A 는 이미 KR_1003 을 가졌으므로 그 뒤만 본다.
  delete activeGames[PUUID_A];
  const live3 = await liveJob(liveState);
  const asked3 = fake.matchIdsAsked.slice(asked1);
  check("★ 게임이 끝난 계정의 지명만 따라잡는다", live3.detail?.justFinished === 1 && asked3.length === 1 && asked3[0].puuid === PUUID_A,
    JSON.stringify({ detail: live3.detail, asked3 }));
  check("끝난 판(KR_1005)이 들어온다", (await ids()) === "KR_1003,KR_1005", await ids());
  check("상세는 지명 계정 A 만", (await detailsOf("KR_1005")) === "a", await detailsOf("KR_1005"));

  // ── Engine C ───────────────────────────────────────────────────────
  console.log("\n▸ Engine C — 지명 백필");
  let slices = 0;
  for (;;) {
    const r = await backfillJob();
    if (r.exhausted) break;
    if (++slices > 20) { check("백필이 20슬라이스 안에 끝난다", false, "커서가 안 내려간다"); break; }
  }
  check(`백필이 ${slices}슬라이스로 끝난다 (무한 루프 없음)`, slices <= 20 && slices > 0);

  check("★ 지명 범위 안의 과거 판만 적재된다 — 기간 전(KR_1000)·지명 안 한 큐(KR_1004)·끝난 기간 뒤(KR_2002)는 없다",
    (await ids()) === "KR_0999,KR_1001,KR_1003,KR_1005,KR_2001", await ids());
  check("듀오 판(KR_1001)은 두 지명 계정 모두 상세", (await detailsOf("KR_1001")) === "ab", await detailsOf("KR_1001"));
  check("자유랭 지명 판(KR_2001)은 A 만 상세", (await detailsOf("KR_2001")) === "a", await detailsOf("KR_2001"));

  const dead = await sql<{ match_id: string }[]>`SELECT match_id FROM dead_match`;
  check("404 매치는 dead_match 로 간다", dead.length === 1 && dead[0].match_id === "KR_1002", dead.map((d) => d.match_id).join(","));

  const matchCallsBefore = fake.calls.match;
  await backfillJob();
  check("죽은 매치를 다시 부르지 않는다", fake.calls.match === matchCallsBefore,
    `match ${matchCallsBefore} → ${fake.calls.match}`);

  const cursors = await sql<{ slug: string; state: string; reached_end: boolean; cursor_before: Date | null }[]>`
    SELECT o.slug, p.state, p.reached_end, p.cursor_before FROM collection_progress p JOIN collection_order o ON o.id = p.order_id ORDER BY o.slug, p.puuid`;
  check("지명 범위 진척이 전부 done + 끝 도달(칸 3: 듀오 2·자유랭 1)", cursors.length === 3 && cursors.every((c) => c.state === "done" && c.reached_end), JSON.stringify(cursors));
  const flex = cursors.find((c) => c.slug === "verify-a-flex");
  check("끝난 지명은 기간의 끝에서부터 내려간다(커서가 기간 안)", Boolean(flex?.cursor_before && flex.cursor_before.getTime() < NOW - 50 * DAY),
    JSON.stringify(flex));
  const asked = new Set(fake.matchIdsAsked.map((a) => `${a.puuid[0]}:${a.queue}`));
  check("★ Riot 에 물은 것은 지명(계정·큐)뿐이다", [...asked].sort().join(",") === "a:420,a:440,b:420", [...asked].join(","));

  // 나중에 지명한 계정의 상세가 빠진 판은 다시 받아 채운다.
  console.log("\n▸ 나중에 지명한 사람 — 이미 가진 판의 상세를 채운다");
  await sql.begin((tx) => collection.addMemberInTx(tx, "verify-duo", "gamma"));
  const matchCallsC = fake.calls.match;
  for (let i = 0; i < 5; i++) if ((await backfillJob()).exhausted) break;
  check("★ 감마 지명 뒤 KR_1003 을 한 번 다시 받아 감마 상세만 더한다",
    (await detailsOf("KR_1003")) === "abc" && fake.calls.match === matchCallsC + 1,
    `${await detailsOf("KR_1003")} / match ${matchCallsC} → ${fake.calls.match}`);
  check("판·참가자는 늘지 않는다", (await ids()) === "KR_0999,KR_1001,KR_1003,KR_1005,KR_2001"
    && (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM match_participant WHERE match_id = 'KR_1003'`)[0].n === 10);

  // 실패한 지명은 영구 제외가 아니라 한동안 쉬었다가 다시 집힌다(옛 ingest_cursor 는 5번 실패하면 영영 빠졌다).
  await createOrder({ slug: "verify-b-flex", title: "검증 베타 자유랭", owner: "module:verify/b-flex", queue_ids: [440], starts_at: new Date(NOW - 10 * DAY), members: ["beta"] });
  const first = await collection.claimBackfillScope();
  const errored = first?.id ?? "";
  check("새 지명의 칸은 백필이 처음 집을 때 진척이 생긴다", first?.slug === "verify-b-flex", JSON.stringify(first?.slug));
  await collection.saveScopeProgress({ id: errored, state: "error", error: "가짜 5xx" });
  check("방금 실패한 칸은 바로 다시 집지 않는다", (await collection.claimBackfillScope()) === null);
  const later = await collection.claimBackfillScope(60 * 60 * 1000, new Date(NOW + 2 * HOUR));
  check("★ 실패하고 한 시간이 지나면 다시 집는다", later?.id === errored, JSON.stringify(later?.slug));
  const dropped = await sql.begin((tx) => collection.deleteOrderInTx(tx, "verify-b-flex"));
  check("모은 판이 없는 지명을 지우면 정리할 것도 없다", dropped.pruned.matches.length === 0, dropped.pruned.matches.join(","));

  // ── 저장 관문 ──────────────────────────────────────────────────────
  console.log("\n▸ 저장 관문 — 엔진을 거치지 않아도 지명 밖 판은 저장되지 않는다");
  const strangerDto = buildMatchDto({
    matchId: "KR_5000001", gameCreation: NOW - 3 * HOUR, queueId: 420, fillerPrefix: "nobody",
    roster: [me(STRANGER, 100, "MIDDLE", true, 1)],
  });
  const outside = await ingest.saveMatch(strangerDto);
  check("★ 지명 계정이 없는 공개 큐 판은 out_of_scope — 아무것도 쓰지 않는다",
    outside.state === "out_of_scope" && !(await ids()).includes("KR_5000001")
      && (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM match_participant WHERE match_id = 'KR_5000001'`)[0].n === 0,
    JSON.stringify(outside));
  const wrongQueue = await ingest.saveMatch(buildMatchDto({ ...MATCHES.find((m) => m.matchId === "KR_1004")! }));
  check("★ 지명 계정이라도 지명 안 한 큐(칼바람)는 저장하지 않는다", wrongQueue.state === "out_of_scope" && !(await ids()).includes("KR_1004"));
  const afterEnd = await ingest.saveMatch(buildMatchDto({ ...MATCHES.find((m) => m.matchId === "KR_2002")! }));
  check("★ 끝난 지명 기간 뒤의 판은 저장하지 않는다", afterEnd.state === "out_of_scope" && !(await ids()).includes("KR_2002"));

  // ── 토너먼트 코드 ──────────────────────────────────────────────────
  // 토너먼트 코드는 분류가 아니라 입력 수단이다(사용자 결정 4). 판은 내전 세트가 되고, 형식은 사람이 시리즈를
  // 실제 행사로 옮겨 정한다 — 그때까지는 KST 날짜별 자동 미분류 묶음에 한 판짜리 시리즈로 있다.
  console.log("\n▸ 토너먼트 코드 판 — 내전 세트(자동 미분류 묶음)");
  // KST 정오에 고정한다 — 둘째 판(+40분)이 같은 KST 날짜여야 같은 묶음이라는 검사가 실행 시각에 따라 흔들리지 않게.
  const codeAt = Date.UTC(2026, 9, 10, 3, 0);
  const ckDto = buildMatchDto({
    matchId: "KR_3130001", gameCreation: codeAt, queueId: 3130, tournamentCode: "KR050c3-aad2ff79",
    gameType: "CUSTOM_GAME", fillerPrefix: "ck", fillerNamePrefix: "모르는사람",
    roster: [me(PUUID_A, 100, "MIDDLE", true, 157), me(PUUID_B, 200, "MIDDLE", false, 238)],
  });
  const ckSaved = await ingest.saveMatch(ckDto);
  const ckRow = await sql<{ scope: string; series_id: string | null; series_game_no: number | null; tournament_code: string | null; collected_via: string }[]>`
    SELECT scope, series_id, series_game_no, tournament_code, collected_via FROM match WHERE match_id = 'KR_3130001'`;
  check("★ 토너먼트 코드 판은 지명과 무관하게 내전 세트(versus)로 들어간다",
    ckSaved.state === "saved" && ckRow[0]?.scope === "versus" && ckRow[0].series_id === "set:KR_3130001" && ckRow[0].series_game_no === 1,
    JSON.stringify(ckRow[0]));
  check("토너먼트 코드가 저장된다 (같은 코드 = 같은 내전 세션)·수집 경로 api",
    ckRow[0]?.tournament_code === "KR050c3-aad2ff79" && ckRow[0].collected_via === "api", JSON.stringify(ckRow[0]));
  const kstDay = new Date(codeAt + 9 * HOUR).toISOString().slice(0, 10);
  const bucket = await sql<{ slug: string; format: string; auto_bucket: boolean }[]>`
    SELECT e.slug, e.format, e.auto_bucket FROM match_series ms JOIN event e ON e.id = ms.event_id WHERE ms.id = 'set:KR_3130001'`;
  check("★ 그 판의 KST 날짜 묶음(lol-code-auto-날짜)·미분류·자동 묶음",
    bucket[0]?.slug === `lol-code-auto-${kstDay}` && bucket[0].format === "unclassified" && bucket[0].auto_bucket, JSON.stringify(bucket[0]));
  check("★ 내전 판의 상세는 없다 — 기본 칸 10명만(지명 계정 A·B 가 있어도)",
    (await detailsOf("KR_3130001")) === ""
      && (await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM match_participant WHERE match_id = 'KR_3130001'`)[0].n === 10);
  const vs = await sql<{ streamer_id: string; format: string }[]>`
    SELECT streamer_id, format FROM core_public.versus_set WHERE match_id = 'KR_3130001' ORDER BY streamer_id`;
  check("공개 내전 세트에 두 스트리머가 미분류로 보인다", vs.length === 2 && vs.every((v) => v.format === "unclassified"), JSON.stringify(vs));

  const again = await ingest.saveMatch(ckDto);
  const series = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM match_series WHERE event_id = (SELECT id FROM event WHERE slug = ${`lol-code-auto-${kstDay}`})`;
  check("같은 판을 다시 받아도 duplicate — 시리즈·묶음이 늘지 않는다", again.state === "duplicate" && series[0].n === 1, `${again.state} / ${series[0].n}`);
  const ck2 = await ingest.saveMatch(buildMatchDto({
    matchId: "KR_3130002", gameCreation: codeAt + 40 * 60 * 1000, queueId: 3130, tournamentCode: "KR050c3-aad2ff79",
    gameType: "CUSTOM_GAME", fillerPrefix: "ck", fillerNamePrefix: "모르는사람",
    roster: [me(PUUID_A, 200, "MIDDLE", false, 157), me(PUUID_B, 100, "MIDDLE", true, 238)],
  }));
  const buckets = await sql<{ n: number }[]>`SELECT count(DISTINCT ms.event_id)::int AS n FROM match_series ms WHERE ms.id IN ('set:KR_3130001', 'set:KR_3130002')`;
  check("같은 KST 날짜의 둘째 판은 같은 묶음에 자기 한 판짜리 시리즈로", ck2.state === "saved" && buckets[0].n === 1, `${buckets[0].n}`);

  const ckCands = await sql<{ puuid: string; game_name: string | null; seen_with: string[]; seen_count: number }[]>`
    SELECT puuid, game_name, seen_with, seen_count FROM account_candidate WHERE puuid LIKE 'ck__KR_3130001%'`;
  check("★ 토너먼트 코드 판의 모르는 참가자 8명이 승인 큐로 간다 (자동 등록은 안 한다)",
    ckCands.length === 8 && ckSaved.candidates === 8, `${ckCands.length}건 / saveMatch=${ckSaved.candidates}`);
  check("사람이 알아볼 이름이 함께 남는다 (표시용 — 조인엔 안 쓴다)",
    ckCands.every((c) => c.game_name?.startsWith("모르는사람")));
  check("누구와 같이 있었는지가 근거로 남는다", ckCands.every((c) => c.seen_with.length === 2));
  check("같은 판을 다시 받아도 후보를 다시 세지 않는다(첫 적재 때만)", ckCands.every((c) => c.seen_count === 1));
  const stillPending = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM streamer_account WHERE puuid LIKE 'ck%'`;
  check("★ 후보는 계정으로 자동 등록되지 않는다 (§11-2 — 근거 없는 매핑 금지)", stillPending[0].n === 0, `${stillPending[0].n}건`);

  // ── 관리자 숫자 ────────────────────────────────────────────────────
  console.log("\n▸ 관리자 스트리머 목록 — 경기 수는 공개 내전 세트 기준");
  const list = await streamers.listStreamers();
  const count = (slug: string) => list.find((s) => s.slug === slug)?.match_count;
  check("알파·베타는 토너먼트 코드 내전 2세트, 감마는 0(개인 기록 판은 세지 않는다)",
    count("alpha") === 2 && count("beta") === 2 && count("gamma") === 0, JSON.stringify(list.map((s) => [s.slug, s.match_count])));
  const counts = await streamers.adminCounts();
  check("남은 지명 수집 수는 백필이 안 끝난 지명", counts.collection_pending === 0, JSON.stringify(counts));

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
