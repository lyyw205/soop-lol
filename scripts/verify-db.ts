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
 *
 * ★ 분류·수집 뼈대(0089, docs/CLASSIFICATION-REDESIGN-PLAN.md §12) 위에서 돈다 — 판은 행사 → 시리즈 → 세트 한 길로만
 *   분류에 들어가고(classification.ts), 공개 집계는 core_public.versus_set·versus_pair_set 을 질의 시점에 읽어
 *   metrics/tally.ts 로 센다. 그래서 여기 검사는 "파생 표를 다시 만들면 맞나"가 아니라 **"원본을 고친 그 자리에서
 *   공개 숫자가 맞나"** 를 본다. 이관·불변식·공개 뷰 자체는 scripts/verify-skeleton.ts 가 따로 본다(겹치지 않는다) —
 *   이 파일은 그 위에서 **core 의 쓰기·읽기 함수**를 끝까지 돌린다.
 */

import { join } from "node:path";
import type postgres from "postgres";

import { applyAll } from "./lib/migrations.ts";
import { verifyReviewRecordUpgrade } from "./lib/verify-review-record-migration.ts";
import { verifyNameHistoryDb, verifyNormNameSqlDb, verifyPuuidMoveDb } from "./lib/verify-puuid-move-db.ts";
import { verifyScheduleDb } from "./lib/verify-schedule-db.ts";
import { verifyMemberDb } from "./lib/verify-member-db.ts";
import { verifyCommunityDb } from "./lib/verify-community-db.ts";
import { verifyCkDuplicateMergeDb, verifyCkDuplicatesDb } from "./lib/verify-ck-duplicates.ts";
import { verifyMatchSeriesDb } from "./lib/verify-match-series.ts";
import { verifySubmissionDb } from "./lib/verify-submission-db.ts";
import { verifyScheduleReportDb } from "./lib/verify-schedule-report-db.ts";
import { verifyVodRequestDb } from "./lib/verify-vod-request-db.ts";
import { verifyCollectionDb } from "./lib/verify-collection-db.ts";
import { recordCursor } from "../packages/core/lib/metrics/record-cursor.ts";
import { resolveRecordPeriod } from "../packages/core/lib/metrics/record-period.ts";
import { mirror, tally, total, type Counts } from "../packages/core/lib/metrics/tally.ts";
import { isLanePair, pairResult } from "../packages/core/lib/metrics/opponent-history.ts";
import type { EventInput, EventPatch } from "../packages/core/lib/db/classification.ts";
import type { MatchDto } from "../packages/core/lib/riot/types.ts";
import type { VersusScope } from "../packages/core/lib/metrics/record-scope.ts";

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
// PGlite는 단일 연결만 지원한다. 병렬 공개 조회도 같은 연결에서 직렬 실행한다.
process.env.DATABASE_POOL_MAX = "1";

// core 는 import 시점이 아니라 호출 시점에 DATABASE_URL 을 읽으므로 순서는 안전하다.
const { db: sqlClient, closeDb } = await import("../packages/core/lib/db/client.ts");
const streamers = await import("../packages/core/lib/db/streamers.ts");
const tournaments = await import("../packages/core/lib/db/tournaments.ts");
const ingestDb = await import("../packages/core/lib/db/ingest.ts");
const publicDb = await import("../packages/core/lib/db/public.ts");
const personalDb = await import("../packages/core/lib/db/personal.ts");
const opponents = await import("../packages/core/lib/db/opponent-history.ts");
const ck = await import("../packages/core/lib/db/ck.ts");
const classification = await import("../packages/core/lib/db/classification.ts");
const collection = await import("../packages/core/lib/db/collection.ts");
const publicContract = await import("../packages/core/lib/contract/index.ts");
const { lolEvent } = await import("./lib/verify-ck-fixtures.ts");
const { lpAbsolute } = await import("../packages/core/lib/metrics/lp.ts");

type Tx = postgres.TransactionSql;

// ── 분류 쓰기는 운영과 같은 길(classification.ts)로만 ─────────────────────────
// 검사가 행사·시리즈를 SQL 로 직접 붙이면 운영 경로가 거치는 게임 대조·제외 확인·진행 방식 어휘 검사를 검사 자신이 건너뛴다.
const ensureEvent = (input: EventInput) =>
  sqlClient().begin((tx) => classification.ensureEventInTx(tx, input)) as Promise<string>;
const updateEvent = (slug: string, patch: EventPatch) =>
  sqlClient().begin((tx) => classification.updateEventInTx(tx, slug, patch)) as Promise<string>;

/** 손으로 넣는 내전 세트 한 판 — 시리즈 밖(personal)으로 만들고 같은 트랜잭션에서 placeSetInTx 로 시리즈에 둔다(운영 경로와 같다). */
interface RawSet {
  match_id: string; event_id: string; at: Date | string;
  series_id?: string; game_no?: number; queue_id?: number; game_mode?: string;
  collected_via?: "api" | "vod" | "manual"; winning_team?: 100 | 200;
  set_role?: "main" | "bonus"; set_label?: string | null; reviewed?: boolean;
}
async function insertSetInTx(tx: Tx, s: RawSet): Promise<void> {
  await tx`
    INSERT INTO match (match_id, game_code, queue_id, mode_key, game_mode, game_creation, winning_team, collected_via, scope)
    VALUES (${s.match_id}, 'lol', ${s.queue_id ?? 0}, ${String(s.queue_id ?? 0)}, ${s.game_mode ?? "CLASSIC"}, ${s.at},
            ${s.winning_team ?? 100}, ${s.collected_via ?? "manual"}, 'personal')`;
  await classification.placeSetInTx(tx, {
    match_id: s.match_id, game_no: s.game_no ?? 1, actor: "admin",
    series: { id: s.series_id ?? classification.singleSetSeriesId(s.match_id), game_code: "lol", event_id: s.event_id },
  });
  if (s.set_role === "bonus") {
    await tx`UPDATE match SET set_role = 'bonus', set_label = ${s.set_label ?? null} WHERE match_id = ${s.match_id}`;
  }
  if (s.reviewed) await tx`UPDATE match SET reviewed_at = now() WHERE match_id = ${s.match_id}`;
}
const insertSet = (s: RawSet) => sqlClient().begin((tx) => insertSetInTx(tx, s));

/** Riot match-v5 한 판(수집 경로 ingest.saveMatch 에 그대로 넣는다). 토너먼트 코드 판은 tournamentCode 를 준다. */
interface RiotSeat { puuid: string; teamId: 100 | 200; championId: number; position?: string; kills?: number; deaths?: number; assists?: number }
function riotGame(matchId: string, gameId: number, at: Date, seats: RiotSeat[],
  opts: { queueId?: number; gameMode?: string; tournamentCode?: string; winner?: 100 | 200 } = {}): MatchDto {
  const winner = opts.winner ?? 100;
  return {
    metadata: { dataVersion: "2", matchId, participants: seats.map((p) => p.puuid) },
    info: {
      gameId, platformId: "KR", gameCreation: at.getTime(), gameStartTimestamp: at.getTime() + 30_000,
      gameEndTimestamp: at.getTime() + 1_830_000, gameDuration: 1800, gameMode: opts.gameMode ?? "CLASSIC",
      gameType: opts.tournamentCode ? "CUSTOM_GAME" : "MATCHED_GAME", gameVersion: "16.3.512.1234", mapId: 11,
      queueId: opts.queueId ?? 0, tournamentCode: opts.tournamentCode,
      participants: seats.map((p, i) => ({
        puuid: p.puuid, participantId: i + 1, teamId: p.teamId, win: p.teamId === winner,
        championId: p.championId, championName: undefined as unknown as string,
        kills: p.kills ?? 1, deaths: p.deaths ?? 1, assists: p.assists ?? 1,
        teamPosition: p.position ?? "", individualPosition: p.position ?? "",
      })),
      teams: [{ teamId: 100, win: winner === 100 }, { teamId: 200, win: winner === 200 }],
    },
  } as MatchDto;
}

/** 기간 필터 — 화면과 같은 해석(resolveRecordPeriod)을 거친 from·to 만 넘긴다. */
const year = (y: number): VersusScope => {
  const p = resolveRecordPeriod({ year: y });
  return { from: p.from, to: p.to };
};
const counts = (c: Counts) => `${c.win}승 ${c.draw}무 ${c.loss}패 ${c.unknown}미상`;
const sameCounts = (a: Counts, b: Counts) => a.win === b.win && a.draw === b.draw && a.loss === b.loss && a.unknown === b.unknown;
/** 한 사람이 다른 한 사람을 상대편으로 만난 기록(세트·시리즈) — 프로필 상대 전적 탭과 같은 함수. */
const vsRecord = async (a: string, b: string, scope: Parameters<typeof opponents.listOpponentSummaries>[1] = {}) =>
  (await opponents.listOpponentSummaries(a, scope)).find((o) => o.other_id === b)?.record ?? null;
/** 이 판이 공개 내전 세트로 몇 사람 몫 나오나 / 공개 상대전적 짝이 몇 행인가(양방향이라 한 쌍 = 2행). */
const versusRows = async (matchId: string) =>
  (await sqlClient()<{ n: number }[]>`SELECT count(*)::int AS n FROM core_public.lol_versus_set WHERE match_id = ${matchId}`)[0].n;
const pairRows = async (matchId: string) =>
  (await sqlClient()<{ n: number }[]>`SELECT count(*)::int AS n FROM core_public.versus_pair_set WHERE match_id = ${matchId}`)[0].n;

try {
  console.log("\n▸ 스키마 적용");
  const applied = await applyAll((sql) => db.exec(sql), ROOT);
  check(`db/migrations 가 순서대로 적용된다 (${applied.length}건)`, true,
    applied.map((m) => m.version).join(" "));

  const tables = await db.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const names = tables.rows.map((r) => r.tablename);
  // 파생 표(조우·챔피언 통계)와 전원 백필 커서는 없다(0089) — 지명 수집(0090: 지명·사람·진척)·제외(event_exclusion)·상세(지명 범위 계정만)가 있다.
  const expected = [
    "account_candidate", "career_event", "collection_member", "collection_order", "collection_progress", "dead_match", "event", "event_exclusion",
    "job_run", "lol_participant_detail", "match", "match_participant", "rank_snapshot",
    "match_series", "review_record", "riot_account", "streamer", "streamer_account", "streamer_channel",
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

  // (옛 lol_match_category SQL↔TS 전 조합 대조는 지웠다 — 분류 함수 자체가 없다(0089). 분류는 행사의 format 하나이고,
  //  format.ts 목록 = DB CHECK 대조는 verify-skeleton 이 한다.)

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

  // ★ 계정 연결은 수집 대상을 만들지 않는다(계획 §4) — 옛 구조는 여기서 전원 백필 대기열에 넣어 하루 2.7만 판을 쌓았다.
  const targetsAfterLink = await sqlClient()<{ n: number }[]>`SELECT count(*)::int AS n FROM collection_scope`;
  check("계정을 연결해도 수집 대상이 생기지 않는다 — 경기 수집은 지명된 사람의 계정(collection_scope)만",
    targetsAfterLink[0].n === 0, `${targetsAfterLink[0].n}건`);

  console.log("\n▸ 수집 — 토너먼트 코드 판은 내전 세트, 공개 큐 판은 지명한 것만 개인 기록");
  // 참가자는 10인 전원을 저장한다 — 스트리머 2명 + 일반인. 공개면이 일반인을 걸러내는지 보려면 실제로 섞여 있어야 한다.
  const kr1Seats: RiotSeat[] = [
    { puuid: puuidA, teamId: 100, championId: 157, kills: 5, deaths: 2, assists: 7 },
    { puuid: puuidB, teamId: 200, championId: 238, kills: 2, deaths: 5, assists: 3 },
    { puuid: "n".repeat(78), teamId: 100, championId: 64 },
  ];
  const kr1 = await ingestDb.saveMatch(riotGame("KR_1", 1, new Date("2026-07-01T12:00:00Z"), kr1Seats, { queueId: 3130, tournamentCode: "KR-verify-1" }));
  const [kr1Set] = await sqlClient()<{ format: string; auto_bucket: boolean; series_id: string }[]>`
    SELECT DISTINCT format, auto_bucket, series_id FROM core_public.lol_versus_set WHERE match_id = 'KR_1'`;
  check("★ 토너먼트 코드 판은 수집 즉시 내전 세트다 — 날짜 자동 묶음(분류 전)의 한 판짜리 시리즈, CK 로 지어내지 않는다",
    kr1.state === "saved" && kr1.scope === "versus" && kr1Set?.format === "unclassified" && kr1Set.auto_bucket === true
      && kr1Set.series_id === classification.singleSetSeriesId("KR_1"),
    JSON.stringify({ kr1, kr1Set }));
  const kr1Pairs = await sqlClient()<{ a_streamer_id: string; b_streamer_id: string; a_outcome: string; b_outcome: string }[]>`
    SELECT a_streamer_id, b_streamer_id, a_outcome, b_outcome FROM core_public.versus_pair_set WHERE match_id = 'KR_1'`;
  check("★ 상대전적 짝은 저장된 사본이 아니라 양방향 한 쌍이다 — A→B 와 B→A 가 서로 거울",
    kr1Pairs.length === 2 && kr1Pairs.every((p) => kr1Pairs.some((q) => q.a_streamer_id === p.b_streamer_id
      && q.b_streamer_id === p.a_streamer_id && q.a_outcome === p.b_outcome && q.b_outcome === p.a_outcome)),
    JSON.stringify(kr1Pairs));

  // 공개 큐 판: 지명이 없으면 저장하지 않고, 지명한 판은 개인 기록(시리즈 밖)으로만 들어간다 — 내전 집계에 섞이지 않는다(원칙 7).
  const soloAt = new Date("2026-07-02T12:00:00Z");
  const soloSeats: RiotSeat[] = [
    { puuid: puuidA, teamId: 100, championId: 157, position: "MIDDLE" },
    { puuid: puuidB, teamId: 200, championId: 238, position: "MIDDLE" },
  ];
  const unnamed = await ingestDb.saveMatch(riotGame("KR_SOLO0", 2, soloAt, soloSeats, { queueId: 420 }));
  await sqlClient().begin((tx) => collection.createOrderInTx(tx, {
    slug: "verify-solo", title: "검증 솔랭", owner: "module:verify/solo", queue_ids: [420],
    starts_at: new Date("2026-07-01T00:00:00Z"), members: ["alpha"],
  }));
  const named = await ingestDb.saveMatch(riotGame("KR_SOLO1", 3, soloAt, soloSeats, { queueId: 420 }));
  check("★ 지명 없는 공개 큐 판은 저장하지 않는다 / 지명한 판은 개인 기록(personal)으로만",
    unnamed.state === "out_of_scope" && named.state === "saved" && named.scope === "personal"
      && (await sqlClient()`SELECT 1 FROM match WHERE match_id = 'KR_SOLO0'`).length === 0,
    JSON.stringify({ unnamed: unnamed.state, named }));
  check("★ 개인 기록 판은 내전 세트·상대전적에 섞이지 않는다 — 같은 판에 두 스트리머가 상대편이어도 (원칙 7)",
    (await versusRows("KR_SOLO1")) === 0 && (await pairRows("KR_SOLO1")) === 0
      && (await sqlClient()`SELECT 1 FROM core_public.personal_game WHERE match_id = 'KR_SOLO1'`).length === 2);

  console.log("\n▸ 관리자 질의가 실제로 돈다");
  const counts0 = await streamers.adminCounts();
  check("adminCounts — 경기 2(코드 판·지명 판) · 지명 수집 대기 1", counts0.streamers === 2 && counts0.accounts === 2
    && counts0.matches === 2 && counts0.collection_pending === 1, JSON.stringify(counts0));

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

  // KR_1(토너먼트 코드 판): 알파(숨김) vs 베타 + Riot 일반인 한 자리.
  check("한쪽이라도 숨겨지면 상대전적 짝이 사라진다 (재계산 없이 그 자리에서)",
    (await pairRows("KR_1")) === 0, `${await pairRows("KR_1")}행`);

  const kr1Roster = await publicContract.listMatchRosters(["KR_1"]);
  check("일반인 참가자는 공개 경기 보기(로스터)에 노출되지 않는다 — 숨긴 스트리머 자리도",
    kr1Roster.length === 1 && kr1Roster[0].streamer_id === s2.id, `${kr1Roster.length}자리`);
  const viewColumns = async (view: string) => (await sqlClient()<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns WHERE table_schema = 'core_public' AND table_name = ${view}`)
    .map((r) => r.column_name);
  const personalCols = await viewColumns("personal_game");
  check("빌드 칸(아이템·스펠·핵심 룬)은 개인 기록(지명한 판)에만 있다 — 룬 원본 JSON 은 없다(0069·0089)",
    ["items", "summoner1_id", "keystone_id", "sub_style_id"].every((k) => personalCols.includes(k)) && !personalCols.includes("perks"),
    personalCols.join(","));

  // 0069 의 "라인업에 신원 칸 없음"은 경기 하나 보기(match_detail)가 잇는다 — puuid 칸이 아예 없고, 인게임명은 미등록 자리에만.
  const detailCols = await viewColumns("match_detail");
  check("★ 경기 보기에는 puuid 칸이 아예 없다 — 인게임명은 미등록 자리에만 나온다",
    detailCols.length > 0 && !detailCols.includes("puuid") && kr1Roster.every((r) => r.observed_name === null),
    detailCols.join(","));
  const hiddenIds = (await sqlClient()<{ id: string }[]>`SELECT id FROM streamer WHERE visibility <> 'public'`).map((r) => r.id);
  const allRosterIds = (await sqlClient()<{ streamer_id: string | null }[]>`SELECT streamer_id FROM core_public.match_detail`);
  check("★ 숨긴 스트리머 자리는 경기 보기에서 빠진다 — 익명 자리로도 남지 않는다(0089 match_detail)",
    allRosterIds.length > 0 && allRosterIds.every((r) => r.streamer_id != null && !hiddenIds.includes(r.streamer_id)),
    `${allRosterIds.length}자리`);

  console.log("\n▸ 대회(내전) 기록 — Riot API 로 못 얻는 경기를 수기로 넣는다");
  // API 로 받은 롤 판은 Riot 이 준 값이 반드시 있어야 한다 — 없는 값을 지어낸 판이 'API' 로 둔갑하면 출처를 아무도 판단하지 못한다.
  await expectReject(
    "API 로 받은 롤 판은 riot_game_id 없이 못 들어간다",
    async () => {
      await sqlClient()`
        INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, collected_via, scope)
        VALUES ('BAD_1', 'lol', 420, '420', now(), 'api', 'personal')
      `;
    },
    "riot_ids",
  );

  const eventId = await ensureEvent({
    game_code: "lol", slug: "verify-cup", name: "검증컵", format: "tournament", organizer: "테스트",
    source_url: "https://example.com/tournament",
  });
  check("대회가 등록된다", Boolean(eventId));

  const puuids = await tournaments.mainPuuidsBySlug(["alpha", "beta"]);
  check("slug → 대표 puuid 해석", puuids.size === 2, [...puuids.keys()].join(","));

  // 앞 절이 알파를 숨겨 뒀다. 이 절은 두 사람의 공개 기록을 재므로 되돌린다(끝에서 다시 숨겨 숨김 규칙을 본다).
  await sqlClient()`UPDATE streamer SET visibility = 'public' WHERE slug = 'alpha'`;

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
  const [f1Row] = await sqlClient()<{ platform_id: string | null; riot_game_id: number | null; collected_via: string }[]>`
    SELECT platform_id, riot_game_id, collected_via FROM match WHERE match_id = 'verify-cup:f1'`;
  check("대회 경기가 riot_game_id 없이 저장된다 (없는 값을 지어내지 않는다)",
    f1Row?.platform_id === null && f1Row.riot_game_id === null, JSON.stringify(f1Row));

  // ★ 파생 단계가 없다 — 저장한 그 트랜잭션이 끝나면 공개 상대전적에 이미 있다(옛 구조는 rederiveEncounters 를 따로 불렀다).
  check("★ 대회 경기도 저장 즉시 공개 상대전적에 나온다 — 코드 판·VOD 판과 같은 뷰, 재파생 없음",
    (await pairRows("verify-cup:f1")) === 2, `${await pairRows("verify-cup:f1")}행`);
  const [f1Set] = await sqlClient()<{ format: string }[]>`
    SELECT DISTINCT format FROM core_public.lol_versus_set WHERE match_id = 'verify-cup:f1'`;
  check("대회 판은 수집 경로가 수기(manual)이고 분류는 행사의 tournament 다 — 어떻게 알았나와 무슨 판인가는 따로 있다",
    f1Row?.collected_via === "manual" && f1Set?.format === "tournament", JSON.stringify({ f1Row, f1Set }));
  // 대회 경기는 큐가 커스텀(0)이지만 협곡 5v5 이고, 포지션이 Riot 추론값이 아니라
  // 주최측 로스터라 맞라인으로 센다. 같은 MIDDLE 끼리 붙었으니 참이어야 한다.
  const f1Pair = (await opponents.listPairSets(s1.id, {}, s2.id)).find((r) => r.match_id === "verify-cup:f1");
  check("★ 대회 경기도 포지션이 명시돼 있으면 맞라인으로 센다",
    f1Pair !== undefined && isLanePair(f1Pair), JSON.stringify(f1Pair && [f1Pair.relation, f1Pair.a_position, f1Pair.b_position]));
  check("반대 팀이면 opponent", f1Pair?.relation === "opponent");

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
  const noPos = (await opponents.listPairSets(s1.id, {}, s2.id)).find((r) => r.match_id === "verify-cup:nopos");
  check("포지션을 모르는 대회 경기는 맞라인으로 세지 않는다 (§11-10 — 애매하면 판정하지 않는다)",
    noPos !== undefined && !isLanePair(noPos), JSON.stringify(noPos && [noPos.a_position, noPos.b_position]));

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
  const drawRow = (await opponents.listOpponentHistoryMatches(s1.id, s2.id)).matches.find((m) => m.series_id === "verify-cup:draw");
  check("★ 1:1 로 끝난 다전제는 무승부다 (패로 세지 않는다)",
    drawRow?.result === "draw" && drawRow.record.win === 1 && drawRow.record.loss === 1 && total(drawRow.record) === 2,
    JSON.stringify(drawRow && { result: drawRow.result, record: drawRow.record }));
  // 개인 기록은 같은 판의 상대 수와 무관하게 세트 하나를 한 번만 센다.
  const cup2026: VersusScope = { format: "tournament", ...year(2026) };
  const personalSets = await personalDb.listPersonalSets(s1.id, cup2026);
  const personalRows = (await personalDb.listPersonalMatches(s1.id, personalSets)).rows;
  const personalTally = tally(personalSets);
  check("개인 기록: 대회 4세트를 3시리즈로 세고 무승부를 보존한다 (2승 1무 0패)",
    personalRows.length === 3 && total(personalTally.sets) === 4
      && sameCounts(personalTally.series, { win: 2, draw: 1, loss: 0, unknown: 0 }),
    `세트 ${counts(personalTally.sets)} · 시리즈 ${counts(personalTally.series)}`);
  const allCupSets = await personalDb.listPersonalSets(s1.id, { format: "tournament" });
  const latestPersonal = (await personalDb.listPersonalMatches(s1.id, allCupSets, { limit: 1 })).rows;
  const nextPersonal = (await personalDb.listPersonalMatches(s1.id, allCupSets,
    { limit: 1, cursor: recordCursor(latestPersonal[0].played_at, latestPersonal[0].series_id) })).rows;
  check("개인 기록: LIMIT이 다전제 세트를 자르지 않고 페이지가 중복되지 않는다",
    latestPersonal[0]?.sets.length === 2 && latestPersonal[0]?.record.win === 1
      && latestPersonal[0]?.series_id !== nextPersonal[0]?.series_id,
    JSON.stringify({ first: latestPersonal[0]?.series_id, next: nextPersonal[0]?.series_id }));
  const setIds = (g: { sets: { match_id: string }[] }) => g.sets.map((x) => x.match_id);
  check("개인 히스토리: 로스터를 조회할 세트 ID를 경기마다 한 번씩 보존한다",
    personalRows.every((g) => setIds(g).length === total(g.record) && new Set(setIds(g)).size === g.sets.length)
      && setIds(latestPersonal[0]).length === 2
      && !setIds(latestPersonal[0]).some((id) => setIds(nextPersonal[0]).includes(id)));

  // ── 자주 만난 매치업 = 상대 전적의 맞라인 보기(협곡 · 전체 진행 방식 · 전체 기간) — 사이드바·상세가 같은 함수다
  const pairsAB = await opponents.listPairSets(s1.id, {}, s2.id);
  const opponentSets = pairsAB.filter((r) => r.relation === "opponent").length;
  const laneCount = pairsAB.filter(isLanePair).length;
  const laneAB = await vsRecord(s1.id, s2.id, { laneOnly: true });
  const laneBA = await vsRecord(s2.id, s1.id, { laneOnly: true });
  check("자주 만난 매치업: 어느 쪽에서 찾든 같은 상대를 찾고, 두 기록은 서로 거울이다 (상대전적 대칭)",
    laneAB !== null && laneBA !== null && total(laneAB.sets) === laneCount
      && sameCounts(laneAB.sets, mirror(laneBA.sets)) && sameCounts(laneAB.series, mirror(laneBA.series)),
    `알파→베타 ${laneAB && counts(laneAB.sets)} · 베타→알파 ${laneBA && counts(laneBA.sets)}`);
  const noEncounters = await streamers.createStreamer({ slug: "no-encounters", display_name: "기록 없음" });
  try {
    check("자주 만난 매치업: 기록이 없는 스트리머는 빈 목록이다 — 다른 사람들의 인기 쌍으로 대체하지 않는다",
      (await opponents.listOpponentSummaries(noEncounters.id, { laneOnly: true })).length === 0);
  } finally {
    await sqlClient()`DELETE FROM streamer WHERE id = ${noEncounters.id}::uuid`;
  }
  check("자주 만난 매치업: 포지션 불명·다른 라인·같은 팀 세트를 집계에서 제외한다",
    laneCount > 0 && laneCount < opponentSets && total(laneAB!.sets) === laneCount,
    `맞라인 ${laneCount} / 상대편 ${opponentSets}`);
  const laneMatchIds = pairsAB.filter(isLanePair).map((r) => r.match_id);
  const lanePositions = await sqlClient()<{ match_id: string; participant_id: number; team_position: string | null; individual_position: string | null }[]>`
    SELECT match_id, participant_id, team_position, individual_position FROM match_participant
     WHERE match_id = ANY(${laneMatchIds}) AND puuid = ${puuids.get("alpha")!}`;
  try {
    // 원본(참가자 포지션)을 고치면 공개 숫자가 그 자리에서 바뀐다 — 다시 만들 파생 표가 없다.
    await sqlClient()`UPDATE match_participant SET team_position = NULL, individual_position = NULL
                       WHERE match_id = ANY(${laneMatchIds}) AND puuid = ${puuids.get("alpha")!}`;
    check("자주 만난 매치업: 맞라인 기록이 없는 쌍은 제외하지만 일반 맞대결 목록에는 남는다",
      (await vsRecord(s1.id, s2.id, { laneOnly: true })) === null && (await vsRecord(s1.id, s2.id)) !== null);
  } finally {
    for (const r of lanePositions) {
      await sqlClient()`UPDATE match_participant SET team_position = ${r.team_position}, individual_position = ${r.individual_position}
                         WHERE match_id = ${r.match_id} AND participant_id = ${r.participant_id}`;
    }
  }
  const [opponentVisibility] = await sqlClient()`SELECT visibility FROM streamer WHERE slug = 'beta'`;
  await sqlClient()`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'beta'`;
  const withoutPublicOpponent = (await personalDb.listPersonalMatches(s1.id, await personalDb.listPersonalSets(s1.id, cup2026))).rows;
  const personalRosters = await publicContract.listMatchRosters(withoutPublicOpponent.flatMap(setIds));
  check("개인 히스토리: 상대가 비공개여도 본인 경기는 남고 상대 이름은 로스터에서 제외한다",
    withoutPublicOpponent.length === personalRows.length && personalRosters.length > 0
      && personalRosters.every((player) => player.streamer_id !== s2.id));
  await sqlClient()`UPDATE streamer SET visibility = ${opponentVisibility.visibility} WHERE slug = 'beta'`;
  check("개인 기록: CK 필터는 대회 기록을 포함하지 않는다",
    (await personalDb.listPersonalSets(s1.id, { format: "ck" })).length === 0);
  check("개인 기록: 빈 연도는 기록 없음으로 반환한다",
    (await personalDb.listPersonalSets(s1.id, year(1999))).length === 0);
  check("개인 기록: 기간 칸(series_started_on)은 KST 달력 날짜다 — 기간 필터가 이 칸 하나로 자른다",
    personalSets.find((r) => r.match_id === "verify-cup:f1")?.series_started_on === "2026-08-01",
    personalSets.find((r) => r.match_id === "verify-cup:f1")?.series_started_on);
  // 2025-12-31T16:00Z = 2026-01-01 01:00 KST. 원본 시각만 고친다 — 다시 계산할 것이 없다.
  await sqlClient()`UPDATE match SET game_creation = '2025-12-31T16:00:00Z' WHERE match_id = 'verify-cup:f1'`;
  check("개인 기록·상대 목록은 한국 시간 연도 경계를 공유한다",
    (await personalDb.listPersonalSets(s1.id, year(2026))).some((m) => m.series_id === "verify-cup:f1")
      && !(await personalDb.listPersonalSets(s1.id, year(2025))).some((m) => m.series_id === "verify-cup:f1")
      && (await opponents.listOpponentHistoryMatches(s1.id, s2.id, year(2026))).matches.some((m) => m.series_id === "verify-cup:f1")
      && total((await vsRecord(s1.id, s2.id, { ...year(2026), format: "tournament" }))?.sets ?? { win: 0, draw: 0, loss: 0, unknown: 0 }) === 4);
  await sqlClient()`UPDATE match SET game_creation = '2026-08-01T12:00:00Z' WHERE match_id = 'verify-cup:f1'`;
  // 첫 판은 2025 KST, 다음 판은 2026 KST: 요약·목록·상대 조회가 같은 묶음을 고른다.
  const boundarySeries = personalRows.find((r) => r.sets.length === 2)!;
  const priorDates = await sqlClient()<{ match_id: string; game_creation: Date }[]>`
    SELECT match_id, game_creation FROM match WHERE match_id = ANY(${setIds(boundarySeries)}) ORDER BY game_creation`;
  for (const [i, r] of priorDates.entries()) {
    await sqlClient()`UPDATE match SET game_creation = ${new Date(i === 0 ? "2025-12-31T14:59:00Z" : "2025-12-31T15:01:00Z")} WHERE match_id = ${r.match_id}`;
  }
  const boundaryScope: VersusScope = { ...year(2025), format: "tournament" };
  const boundarySets = await personalDb.listPersonalSets(s1.id, boundaryScope);
  check("연말 다전제: 개인 목록·기간 요약·상대 기록은 첫 경기 연도로 전 세트를 포함한다",
    (await personalDb.listPersonalMatches(s1.id, boundarySets)).rows.find((r) => r.series_id === boundarySeries.series_id)?.sets.length === 2
      && total(tally(boundarySets).sets) === 2
      && total((await opponents.listOpponentHistoryMatches(s1.id, s2.id, boundaryScope)).matches
        .find((r) => r.series_id === boundarySeries.series_id)?.record ?? { win: 0, draw: 0, loss: 0, unknown: 0 }) === 2
      && !(await personalDb.listPersonalSets(s1.id, year(2026))).some((r) => r.series_id === boundarySeries.series_id));
  for (const r of priorDates) await sqlClient()`UPDATE match SET game_creation = ${r.game_creation} WHERE match_id = ${r.match_id}`;
  check("상대 목록: CK 필터와 상세 이력의 범위가 같다",
    (await opponents.listOpponentSummaries(s1.id, { format: "ck" })).length === 0
      && (await opponents.listOpponentHistoryMatches(s1.id, s2.id, { format: "ck" })).matches.length === 0);
  await sqlClient()`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'alpha'`;
  check("개인 기록: 숨긴 스트리머의 통계·이력은 노출하지 않는다",
    (await personalDb.listPersonalSets(s1.id)).length === 0
      && (await personalDb.listChampionRecords(s1.id)).length === 0
      && (await opponents.listOpponentSummaries(s1.id)).length === 0);

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
  const otherEventId = await ensureEvent({
    game_code: "lol", slug: "verify-cup-2", name: "검증컵 2회", format: "tournament", source_url: "https://example.com/2",
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

  const filtered = await publicDb.listStreamerEvents(s2.id, year(1999));
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

  const places = await publicDb.summarizePlacements(s2.id);
  const semi = places.buckets.find((b) => b.key === "semi");
  check("★ 순위별 횟수가 집계된다", semi?.count === 1 && places.total === 1, JSON.stringify(places));

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
    noGame?.placement === "1차 예선 탈락" && total(noGame.record.sets) === 0 && total(noGame.record.series) === 0,
    JSON.stringify(noGame));

  const tally3 = await publicDb.summarizePlacements(s2.id);
  check("★ 예선 탈락도 횟수로 집계된다",
    tally3.buckets.find((b) => b.key === "qualifier")?.count === 1 && tally3.unknown === 0,
    JSON.stringify(tally3));

  // 2026-10-13: 올스타전도 대회 1위이면 같은 우승으로 센다.
  await tournaments.saveEventTeams(otherEventId, [
    { name: "올스타팀", placement: "우승", placement_rank: 1, members: [{ streamer_id: s2.id }] },
  ]);
  const tally4 = await publicDb.summarizePlacements(s2.id);
  const cards4 = await publicDb.listStreamerCards();
  check("올스타 우승은 목록·프로필에서 같은 수로 집계한다",
    tally4.buckets.find(b => b.key === "champion")?.count === 1 &&
    cards4.find(s => s.streamer_id === s2.id)?.titles === 1 && tally4.total === 2, JSON.stringify(tally4));
  check("대회 성적 목록에도 올스타 우승이 남는다",
    (await publicDb.listStreamerEvents(s2.id)).some(r => r.team_name === "올스타팀" && r.placement_rank === 1));

  // ── 다전제: 세트와 시리즈를 나눠 셀 수 있는가 (마이그레이션 0007 · 세기는 metrics/tally.ts 하나) ──────
  //
  // 3판 2선승을 2:1 로 이기면 **세트 2승 1패 · 시리즈 1승 0패** 다. 이 둘이 한 기록에서
  // 같이 나와야 한다. 하나로 뭉치면 둘 다 틀린다 — 세트만 세면 다전제 한 판이
  // 단판 세 번과 같아지고, 시리즈만 세면 진 쪽이 딴 세트가 사라진다.
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

  const [bo3Format] = await sqlClient()<{
    event_id: string | null; best_of: number | null; best_of_evidence: string | null;
  }[]>`
    SELECT event_id, best_of, best_of_evidence FROM match_series WHERE id='verify-cup:bo3'
  `;
  check("★ best_of는 세트마다 복제되지 않고 시리즈 한 행에 저장된다",
    bo3Format?.event_id === eventId && bo3Format.best_of === 3
      && bo3Format.best_of_evidence === "검증컵 규정 Bo3", JSON.stringify(bo3Format));
  const publicBo3 = await sqlClient()<{ n: number; best_of: number | null }[]>`
    SELECT count(DISTINCT match_id)::int AS n, min(best_of)::int AS best_of
      FROM core_public.lol_versus_set WHERE series_id='verify-cup:bo3'
  `;
  check("★ 공개 계약은 같은 시리즈의 모든 세트에 best_of를 실어 준다",
    publicBo3[0]?.n === 3 && publicBo3[0]?.best_of === 3, JSON.stringify(publicBo3[0]));
  await expectReject("짝수 best_of는 DB가 거부한다", async () => {
    await sqlClient()`INSERT INTO match_series (id, game_code, event_id, best_of, best_of_evidence)
      VALUES ('verify:bad-even', 'lol', ${eventId}::uuid, 2, '잘못된 fixture')`;
  }, "match_series_best_of_check");
  await expectReject("근거 없는 best_of는 DB가 거부한다", async () => {
    await sqlClient()`INSERT INTO match_series (id, game_code, event_id, best_of)
      VALUES ('verify:bad-evidence', 'lol', ${eventId}::uuid, 3)`;
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
  const fcEventId = await ensureEvent({ game_code: "fconline", slug: "verify-fc-cup", name: "검증 FC 대회", format: "tournament" });
  await sqlClient()`INSERT INTO match_series (id, game_code, event_id) VALUES ('verify:fco-series', 'fconline', ${fcEventId}::uuid)`;
  await expectReject("다른 게임의 시리즈에 LoL 세트를 넣을 수 없다", async () => {
    await sqlClient()`
      INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, collected_via, scope,
                         series_id, series_game_no)
      VALUES ('verify:wrong-game-series', 'lol', 0, '0', now(), 'manual', 'versus',
              'verify:fco-series', 1)
    `;
  }, "match_series_fk");
  await expectReject("판 두기(placeSetInTx)도 다른 게임 시리즈를 거부한다 — 운영 경로는 SQL 오류 전에 멈춘다",
    () => sqlClient().begin(async (tx) => {
      await tx`INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, collected_via, scope)
               VALUES ('verify:wrong-game-place', 'lol', 0, '0', now(), 'manual', 'personal')`;
      await classification.placeSetInTx(tx, { match_id: "verify:wrong-game-place", game_no: 1, actor: "admin",
        series: { id: "verify:fco-series", game_code: "fconline", event_id: fcEventId } });
    }), "lol 경기다");

  // 앞에서 알파를 hidden 으로 바꿔놨다(그 자체가 다른 검사다). 공개 뷰는 숨은
  // 스트리머를 안 보여주는 게 맞으므로, 집계 의미를 보려면 잠깐 되돌렸다가 다시 숨긴다.
  await sqlClient()`UPDATE streamer SET visibility = 'public' WHERE slug = 'alpha'`;

  // 알파 기준 — 상대 전적 탭의 펼친 한 줄(시리즈)과 같은 함수.
  const bo3 = (await opponents.listOpponentHistoryMatches(s1.id, s2.id)).matches.find((m) => m.series_id === "verify-cup:bo3");
  check("★ 다전제 2:1 은 세트로 2승 1패 (3세트)",
    bo3 !== undefined && bo3.record.win === 2 && bo3.record.loss === 1 && total(bo3.record) === 3,
    JSON.stringify(bo3?.record));
  const bo3Series = tally((await personalDb.listPersonalSets(s1.id)).filter((r) => r.series_id === "verify-cup:bo3")).series;
  check("★ 같은 다전제가 시리즈로는 1승 0패 (1경기)",
    bo3?.result === "win" && sameCounts(bo3Series, { win: 1, draw: 0, loss: 0, unknown: 0 }), counts(bo3Series));

  const single = (await opponents.listOpponentHistoryMatches(s1.id, s2.id)).matches.find((m) => m.series_id === "verify-cup:f1");
  const codeSingle = await sqlClient()<{ n: number }[]>`
    SELECT count(DISTINCT series_id)::int AS n FROM core_public.lol_versus_set WHERE match_id = 'KR_1'`;
  check("단판은 자기 자신이 곧 시리즈다 — 코드 판(한 판짜리 시리즈 set:)도 같은 식으로 집계된다",
    single?.standalone === true && total(single.record) === 1 && codeSingle[0]?.n === 1,
    JSON.stringify({ standalone: single?.standalone, code: codeSingle[0]?.n }));

  await sqlClient()`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'alpha'`;
  const hiddenAgain = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM core_public.versus_pair_set WHERE match_id LIKE 'verify-cup:%'
  `;
  check("숨긴 스트리머의 다전제도 공개 상대전적에서 통째로 사라진다",
    hiddenAgain[0]?.n === 0 && (await personalDb.listPersonalSets(s1.id)).length === 0, JSON.stringify(hiddenAgain[0]));

  let seriesRejected = false;
  try {
    await sqlClient()`
      INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, winning_team,
                         collected_via, scope, series_id)
      VALUES ('verify-cup:halfseries', 'lol', 0, '0', now(), 100, 'manual', 'versus', 'verify-cup:bo3')
    `;
  } catch {
    seriesRejected = true;
  }
  check("series_id 만 있고 세트 번호가 없으면 거부한다 (집계가 조용히 틀어진다)", seriesRejected);

  const byVia = await sqlClient()<{ scope: string; collected_via: string; n: number }[]>`
    SELECT scope, collected_via, count(*)::int AS n FROM match WHERE game_code = 'lol' GROUP BY 1, 2 ORDER BY 1, 2
  `;
  check("판을 범위(scope)와 수집 경로(collected_via)로 항상 가를 수 있다 — 공개 큐(personal)·코드(api)·수기가 섞이지 않는다 (§11-7)",
    byVia.some((b) => b.scope === "personal" && b.collected_via === "api")
      && byVia.some((b) => b.scope === "versus" && b.collected_via === "api")
      && byVia.some((b) => b.scope === "versus" && b.collected_via === "manual"),
    byVia.map((b) => `${b.scope}/${b.collected_via}:${b.n}`).join(" "));

  await sqlClient()`UPDATE streamer SET visibility = 'public' WHERE slug = 'alpha'`;
  const pairsBeforeResave = await pairRows("verify-cup:f1");
  await tournaments.saveTournamentGame({
    match_id: "verify-cup:f1", event_id: eventId,
    series_id: "verify-cup:f1", series_game_no: 1, played_at_precision: "datetime",
    played_at: new Date("2026-08-01T12:00:00Z"), duration: 2100, source_url: "https://example.com/vod", winning_team: 100,
    participants: [
      { puuid: puuids.get("alpha")!, team_id: 100, position: "MIDDLE", champion_id: 157 },
      { puuid: puuids.get("beta")!,  team_id: 200, position: "MIDDLE", champion_id: 238 },
    ],
  });
  check("같은 판을 다시 저장해도 공개 세트·상대전적이 늘지 않는다 (멱등)",
    pairsBeforeResave === 2 && (await pairRows("verify-cup:f1")) === 2 && (await versusRows("verify-cup:f1")) === 2);

  console.log("\n▸ CK 조사 — VOD 스캔 단서·근거 프레임 (0019)");

  // 앞 절이 alpha 를 숨겨 뒀다. 이 절은 공개면 필터를 재므로 되돌려 놓는다.
  await sqlClient()`UPDATE streamer SET visibility = 'public' WHERE slug = 'alpha'`;
  // ★ 판은 행사 없이 저장되지 않는다(0089). VOD 자동 조사는 형식을 확인 못 하면 미분류 행사에 넣는다 — 이 절의 판이 그렇다.
  const ckEvent = await lolEvent("verify-ck-vod");
  const scan = (g: Omit<Parameters<typeof ck.upsertMatchFromScan>[0], "event_id"> & { event_id?: string | null }) =>
    ck.upsertMatchFromScan({ event_id: ckEvent, ...g });

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

  await scan({ played_at_precision: "datetime",
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

  await scan({ played_at_precision: "datetime",
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

  check("스캔 매치는 collected_via='vod' 로 어떻게 알았나가 표시된다 (분류는 행사가 따로 정한다)",
    ck1?.match.collected_via === "vod" && ck1.match.event_id === ckEvent && ck1.match.event_format === "unclassified",
    JSON.stringify({ via: ck1?.match.collected_via, format: ck1?.match.event_format }));
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

  check("★ 스캔 저장 즉시 공개 상대전적에 나온다 — 따로 파생할 단계가 없다",
    (await pairRows("verify-cup:ck1")) === 2, `${await pairRows("verify-cup:ck1")}행`);
  const ck1Champ = (await personalDb.listChampionRecords(s1.id)).find((c) => c.champion_id === 157);
  check("★ 스캔 저장 즉시 챔피언 기록에도 들어간다 — 챔피언 기록은 공개 세트에서 바로 센다",
    (ck1Champ?.games ?? 0) > 0, JSON.stringify(ck1Champ && { games: ck1Champ.games }));

  console.log("\n▸ 검수 어드민 — 고칠 수 있어야 하는 것 (0020)");

  // ── 승자 정정: outcome 과 공개 상대전적까지 따라가야 한다
  const flipped = await ck.applyMatchReview("verify-cup:ck1", { match: { changes: { winning_team: 200 }, expect: { winning_team: 100 } } });
  check("승자를 고치면 참가자 outcome 이 따라간다",
    flipped?.participants.find((p) => p.team_id === 100)?.outcome === "loss"
      && flipped?.participants.find((p) => p.team_id === 200)?.outcome === "win",
    JSON.stringify(flipped?.participants.map((p) => [p.team_id, p.outcome])));

  // ★ "둘이 다르다"로는 약하다 — 둘 다 반대로 뒤집혀도 통과한다.
  //   공개 상대전적의 승패가 **실제 승리 팀과 일치하는지**를 본다. 그게 0015 의 불변식이다.
  const pairAfterFlip = await sqlClient()<{ a_ok: boolean; b_ok: boolean; n: number }[]>`
    SELECT bool_and((p.a_outcome = 'win') = (a.side = m.winning_team)) AS a_ok,
           bool_and((p.b_outcome = 'win') = (b.side = m.winning_team)) AS b_ok, count(*)::int AS n
      FROM core_public.versus_pair_set p
      JOIN match m ON m.match_id = p.match_id
      JOIN core_public.lol_versus_set a ON a.match_id = p.match_id AND a.streamer_id = p.a_streamer_id
      JOIN core_public.lol_versus_set b ON b.match_id = p.match_id AND b.streamer_id = p.b_streamer_id
     WHERE p.match_id = 'verify-cup:ck1'
  `;
  const ck1Result = (await opponents.listPairSets(s1.id, {}, s2.id)).find((r) => r.match_id === "verify-cup:ck1");
  check("★★ 승자를 고치면 **공개 상대전적의 승패가 승리 팀과 일치한다** — 0015 가 막으려던 '승자 반대로' 사고",
    pairAfterFlip[0]?.n === 2 && pairAfterFlip[0].a_ok === true && pairAfterFlip[0].b_ok === true
      && ck1Result !== undefined && pairResult(ck1Result) === "loss",
    JSON.stringify({ ...pairAfterFlip[0], alpha: ck1Result && pairResult(ck1Result) }));
  check("검수하면 reviewed_at 이 찍힌다", flipped?.match.reviewed_at !== null);

  await insertSet({ match_id: "verify-cup:admin-format-s1", event_id: eventId, at: new Date(),
    series_id: "verify-cup:admin-format", game_no: 1 });
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
  await sqlClient().begin((tx) => classification.dropEmptySeriesInTx(tx, "verify-cup:admin-format"));

  // 판을 여러 판짜리 시리즈에 넣는다 — 검수 화면의 시리즈 칸. 아래 두 검사가 이 시리즈에서 시작한다.
  const bundled = await ck.applyMatchReview("verify-cup:ck1", {
    match: { changes: { series_id: "verify-ck:s1", series_game_no: 1 }, expect: { series_id: flipped!.match.series_id, series_game_no: flipped!.match.series_game_no } },
  });
  check("검수 화면에서 판을 시리즈에 묶으면 시리즈는 같은 행사 아래 생긴다",
    bundled?.match.series_id === "verify-ck:s1" && bundled.match.event_id === ckEvent,
    JSON.stringify({ series: bundled?.match.series_id, event: bundled?.match.event_id }));

  // ★ 폼이 안 채운 칸(undefined)을 NULL 로 써 버리면 근거가 조용히 지워진다.
  //   postgres.js 가 undefined 를 NULL 로 보내기 때문에 실제로 그럴 수 있었다.
  const untouched = await ck.applyMatchReview("verify-cup:ck1", {
    match: { changes: { series_id: undefined, game_duration: 1900 }, expect: { game_duration: flipped!.match.game_duration } },
  });
  check("★★ patch 의 undefined 는 무시한다 — 안 채운 칸이 기존 값을 지우지 않는다",
    untouched?.match.series_id === "verify-ck:s1" && untouched?.match.game_duration === 1900
      && untouched?.match.result_evidence === "0:05:40 결과창 점수판",
    JSON.stringify({ series: untouched?.match.series_id, ev: untouched?.match.result_evidence, dur: untouched?.match.game_duration }));
  // 판은 시리즈 밖에 있을 수 없다(0089) — "시리즈를 지운다"는 그 행사의 한 판짜리 시리즈(set:<id>)로 돌아가는 것이다.
  const unbundled = await ck.applyMatchReview("verify-cup:ck1", { match: { changes: { series_id: null, series_game_no: null }, expect: { series_id: untouched!.match.series_id, series_game_no: untouched!.match.series_game_no } } });
  check("명시적으로 null 을 넘기면 시리즈에서 빠져 같은 행사의 한 판짜리 시리즈로 간다 (지우는 길은 남아 있다 · 빈 시리즈는 안 남는다)",
    unbundled?.match.series_id === classification.singleSetSeriesId("verify-cup:ck1") && unbundled.match.event_id === ckEvent
      && (await sqlClient()`SELECT 1 FROM match_series WHERE id = 'verify-ck:s1'`).length === 0,
    JSON.stringify({ series: unbundled?.match.series_id }));

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
    "공개 집계는 계정을 먼저 보므로",
  );

  // ── 제외: 「기본 공개, 뺄 것만 제외」의 '제외'
  //
  // ⚠ 행 수로 재면 안 된다 — 같은 챔피언 판이 여러 경기에 걸쳐 **한 줄에 합산된다.**
  //   하나를 빼도 줄은 남고 games 만 줄어든다. 그래서 games 를 본다(챔피언 탭과 같은 함수).
  const alphaGames = async () =>
    (await personalDb.listChampionRecords(s1.id)).find((c) => c.champion_id === 157)?.games ?? 0;
  const gamesBeforeHide = await alphaGames();
  await ck.setMatchVisibility("verify-cup:ck1", "hidden");

  check("★ 제외한 경기는 공개 내전 세트(집계)와 경기 보기에서 사라진다",
    (await versusRows("verify-cup:ck1")) === 0
      && (await sqlClient()`SELECT 1 FROM core_public.match_detail WHERE match_id = 'verify-cup:ck1'`).length === 0);
  check("★ 제외한 경기의 참가자도 사라진다 (로스터)",
    (await publicContract.listMatchRosters(["verify-cup:ck1"])).length === 0);
  check("★ 제외한 경기의 상대전적도 사라진다 (이 사이트의 심장)", (await pairRows("verify-cup:ck1")) === 0);

  const rawStillThere = await sqlClient()<{ visibility: string }[]>`
    SELECT visibility FROM match WHERE match_id = 'verify-cup:ck1'
  `;
  check("★ 제외는 삭제가 아니다 — 행은 남아 있어 되살릴 수 있다",
    rawStillThere[0]?.visibility === "hidden", JSON.stringify(rawStillThere[0]));

  const gamesAfterHide = await alphaGames();
  // ⚠ 절대값으로 재지 않는다 — 앞 테스트가 챔피언을 고치면 기여하는 경기 수가 바뀐다.
  //   불변식은 "제외한 경기 한 판만큼 줄어든다" 다.
  check("★ 제외가 챔피언 기록에도 그 자리에서 반영된다 (따로 다시 계산할 표가 없다)",
    gamesBeforeHide > 0 && gamesAfterHide === gamesBeforeHide - 1,
    `games ${gamesBeforeHide} → ${gamesAfterHide}`);

  await ck.setMatchVisibility("verify-cup:ck1", "public");
  check("★ 되살리면 그대로 돌아온다", (await versusRows("verify-cup:ck1")) === 2 && (await alphaGames()) === gamesBeforeHide);

  // 숨김 조인이 살아 있는지 — 0016 에서 한 번 빠뜨린 자리다
  await sqlClient()`UPDATE streamer SET visibility = 'hidden' WHERE slug = 'alpha'`;
  const pairsHiddenStreamer = await pairRows("verify-cup:ck1");
  check("★★ 경기 숨김을 더해도 **스트리머 숨김이 그대로 살아 있다** (계약 5조)",
    pairsHiddenStreamer === 0, `${pairsHiddenStreamer}행`);
  await sqlClient()`UPDATE streamer SET visibility = 'public' WHERE slug = 'alpha'`;

  // ── 프레임 재연결
  const relinked = await ck.relinkEvidenceFrame(frames[2].id, "verify-cup:ck1");
  check("잘못 붙인 프레임을 다른 경기로 옮길 수 있다", relinked?.match_id === "verify-cup:ck1");
  await ck.relinkEvidenceFrame(frames[2].id, "verify-cup:ck2");

  // ── 기각했던 후보를 되살린다: 연결 안 된 프레임에서 경기를 새로 만든다
  const orphan = await ck.recordEvidenceFrames(leadId, [
    { frame_path: "out/ck/2026-09-20/f9.jpg", at_sec: 9000, kind: "result", note: "처음에 기각한 구간" },
  ]);
  // 되살리기는 검수 화면의 "프레임에서 경기 만들기"(createMatchFromEvidence)다 — 행사(또는 기존 시리즈)를 골라야 만든다.
  await expectReject("행사도 시리즈도 고르지 않으면 프레임에서 경기를 만들지 않는다 — 조용히 미분류 그릇에 넣지 않는다",
    () => ck.createMatchFromEvidence({ frame_id: orphan[0].id, played_at: new Date("2026-09-20T23:30:00Z"),
      series_id: null, series_game_no: null, event_id: null, winning_team: 200 }), "행사");
  const revived = await ck.createMatchFromEvidence({ frame_id: orphan[0].id, played_at: new Date("2026-09-20T23:30:00Z"),
    series_id: null, series_game_no: null, event_id: ckEvent, winning_team: 200 });
  const adminMade = await ck.getMatchDetail(revived.match_id);
  const revivedLog = await ck.listReviewChanges({ match_id: revived.match_id });
  check("★ 기각한 후보를 검수에서 되살릴 수 있다 (미연결 프레임 → 고른 행사의 새 경기, 수기 · 이력에 남는다)",
    adminMade?.match.collected_via === "manual" && adminMade.match.event_id === ckEvent
      && adminMade.evidence_frames.length === 1 && revivedLog.some((c) => c.field === "created"),
    `via=${adminMade?.match.collected_via} 프레임=${adminMade?.evidence_frames.length}`);

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
  await scan(povMatch);
  await scan({ ...povMatch, evidence_frame_ids: [pov2Frames[0].id] });
  const ck3Rows = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM match WHERE match_id = 'verify-cup:ck3'
  `;
  const ck3Parts = await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM match_participant WHERE match_id = 'verify-cup:ck3'
  `;
  const ck3Pairs = await pairRows("verify-cup:ck3");
  check("★ 재실행이 같은 결과를 중복 생성하지 않는다 (경기 1 · 참가자 2 · 상대전적 한 쌍)",
    ck3Rows[0]?.n === 1 && ck3Parts[0]?.n === 2 && ck3Pairs === 2,
    `경기 ${ck3Rows[0]?.n} · 참가자 ${ck3Parts[0]?.n} · 짝 ${ck3Pairs}행`);

  const ck3Detail = await ck.getMatchDetail("verify-cup:ck3");
  check("★ 같은 경기를 여러 POV 가 가리킨다 — lead 는 여럿, match 는 하나",
    ck3Detail?.evidence_frames.length === 1
      && ck3Detail.evidence_frames[0].lead_id === lead2,
    `프레임 ${ck3Detail?.evidence_frames.length}장`);

  const rescan = await scan({ played_at_precision: "datetime",
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
  // VOD 판(ck2)을 시드 행사로 옮긴다 — 검수 화면이 시리즈를 다른 행사로 옮기는 길(moveSeriesInTx)과 같다.
  await sqlClient().begin((tx) => classification.moveSeriesInTx(tx, {
    series_id: classification.singleSetSeriesId("verify-cup:ck2"), event_id: eventId, actor: "admin" }));
  // 시드(수기 manual) 판 셋: 검수한 것 · 그냥 것(다판 시리즈의 한 세트) · VOD 근거가 붙은 것.
  await insertSet({ match_id: "verify-cup:seedReviewed", event_id: eventId, at: new Date(), reviewed: true });
  await insertSet({ match_id: "verify-cup:seedPlain", event_id: eventId, at: new Date(), series_id: "verify-cup:seedSeries", game_no: 1 });
  // VOD 근거 프레임이 붙은 시드 경기 — 지우면 근거 연결이 ON DELETE SET NULL 로 소리 없이 끊긴다.
  await insertSet({ match_id: "verify-cup:seedEvidence", event_id: eventId, at: new Date(), series_id: "verify-cup:seedSeries", game_no: 2 });
  // 다른 절이 세는 검증 VOD(leadId)의 프레임 수를 흔들지 않게 따로 단서를 둔다.
  const pruneLead = await ck.upsertEventLead({
    source: "vod_title", source_key: "vod:prune-guard", title: "근거 붙은 시드 경기",
    observed_at: new Date("2026-09-20T20:00:00Z"),
  });
  await sqlClient()`
    INSERT INTO match_evidence_frame (lead_id, match_id, frame_path, kind)
    VALUES (${pruneLead}::uuid, 'verify-cup:seedEvidence', 'out/ck/verify/seed-evidence.jpg', 'result')
  `;
  // 시드에만 있던 다판 시리즈(판 둘 다 시드 · 근거 없음) — prune 이 판을 다 지우면 시리즈도 비어야 한다.
  await insertSet({ match_id: "verify-cup:seedGone1", event_id: eventId, at: new Date(), series_id: "verify-cup:seedGone", game_no: 1 });
  await insertSet({ match_id: "verify-cup:seedGone2", event_id: eventId, at: new Date(), series_id: "verify-cup:seedGone", game_no: 2 });
  const prunedCk = await tournaments.pruneEventMatches(eventId, ["verify-cup:f1"]);
  const seriesAfterPrune = await sqlClient()<{ id: string }[]>`
    SELECT id FROM match_series WHERE id IN ('verify-cup:seedGone', 'verify-cup:seedSeries', 'verify-cup:f1')`;
  check("prune 은 실제로 지운 건수를 돌려준다 (0 이면 시드가 '지운 게 없다'고 거짓말한다)",
    prunedCk >= 1, `${prunedCk}건`);
  check("★ prune 은 비어 버린 시리즈도 치운다 — 빈 시리즈에 라운드명이 들어가 아무 데도 안 보이는 일을 막는다 (판이 남은 시리즈는 남는다)",
    !seriesAfterPrune.some((r) => r.id === "verify-cup:seedGone") && seriesAfterPrune.some((r) => r.id === "verify-cup:f1")
      && seriesAfterPrune.some((r) => r.id === "verify-cup:seedSeries"),
    seriesAfterPrune.map((r) => r.id).join(","));
  const survivors = await sqlClient()<{ match_id: string }[]>`
    SELECT match_id FROM match
     WHERE match_id IN ('verify-cup:ck1', 'verify-cup:ck2', 'verify-cup:seedReviewed', 'verify-cup:seedPlain',
                        'verify-cup:seedEvidence')
     ORDER BY match_id
  `;
  const survivorNames = survivors.map((s) => s.match_id);
  check("★★ prune 은 자기 것(수기 manual)만 지운다 — 같은 행사의 VOD 판독분이 살아남는다",
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
    "★ 판은 수집 경로(collected_via) 없이 못 들어간다 — 안 그러면 prune 이 자기 것인지 판단하지 못한다",
    async () => {
      await sqlClient()`
        INSERT INTO match (match_id, game_code, queue_id, mode_key, game_creation, winning_team, scope)
        VALUES ('verify-cup:noOrigin', 'lol', 0, '0', now(), 100, 'personal')
      `;
    },
    "collected_via",
  );

  // (옛 "범위 재계산 = 전체 재빌드" 대조 3건은 지웠다 — 챔피언 통계 파생 표와 그 재계산 함수가 없다(0089).
  //  챔피언 기록은 공개 세트에서 질의 시점에 센다(metrics/record-champions.ts). 숨긴 판이 빠지는지는 위 '제외' 절이 본다.)

  // ── 못 읽은 KDA 가 평균을 묽게 하지 않나 (0020 ⑧)
  //   ck2 에서 알파는 KDA 를 못 읽었다(그래프 탭). ck3 에서도 안 읽었다.
  //   그러니 그 챔피언의 kda_games 는 games 보다 작아야 하고, 하나도 없으면 0 이어야 한다.
  const kdaDenom = await personalDb.listChampionRecords(s1.id, 50);
  check("분모는 절대 분자보다 작은 표본을 가리키지 않는다 (kda_games ≤ games)",
    kdaDenom.length > 0 && kdaDenom.every((r) => r.kda_games <= r.games),
    JSON.stringify(kdaDenom.map((r) => [r.champion_id, r.games, r.kda_games])));

  // 야스오(157): KR_1·ck1 에서만 KDA 를 읽었고 ck3·대회 판은 못 읽었다 → 분모가 games 보다 작다
  const diluted = kdaDenom.find((r) => r.champion_id === 157);
  check("★★ KDA 를 못 읽은 판은 평균의 분모에서 빠진다 — games 로 나누면 평균이 묽어진다",
    diluted !== undefined && diluted.kda_games < diluted.games && diluted.kills > 0,
    JSON.stringify(diluted && { games: diluted.games, kda_games: diluted.kda_games, kills: diluted.kills }));

  // 리 신(64): ck2 한 판뿐이고 그 판은 결과창이 그래프 탭이라 KDA 를 못 읽었다
  const unread = kdaDenom.find((r) => r.champion_id === 64);
  check("★ 한 판도 못 읽었으면 kda_games 가 0 이다 (화면은 평균을 내지 않고 '—' 를 그린다)",
    unread !== undefined && unread.kda_games === 0 && unread.kills === 0 && unread.games > 0,
    JSON.stringify(unread && { games: unread.games, kda_games: unread.kda_games }));

  // ── 멀티게임 격리 — FC 경기 한 건이 LoL 공개면·집계를 깨지 않나 (0026)
  //
  // FC 참가자에는 LoL champion_id·포지션이 없고, 무승부는 outcome='draw' 하나로만
  // 표현된다. 이 판이 들어온 뒤에도 LoL 챔피언 기록이 그대로여야 하며, LoL 화면에는 섞이면 안 된다.
  const lolChampsBeforeFc = JSON.stringify([await personalDb.listChampionRecords(s1.id, 50), await personalDb.listChampionRecords(s2.id, 50)]);
  await sqlClient().begin(async (tx) => {
    await tx`
      INSERT INTO match (match_id, game_code, mode_key, game_creation, game_duration, collected_via, scope)
      VALUES ('fco:verify-draw', 'fconline', '60', '2024-01-01T00:00:00Z', 600, 'vod', 'personal')`;
    await tx`
      INSERT INTO fco_match_participant (match_id, ouid, nickname, streamer_id, identity_basis, side_no, outcome, goals)
      VALUES ('fco:verify-draw', NULL, '알파FC', ${s1.id}::uuid, 'manual', 1, 'draw', 1),
             ('fco:verify-draw', NULL, '베타FC', ${s2.id}::uuid, 'manual', 2, 'draw', 1)`;
    await classification.placeSingleSetInTx(tx, { match_id: "fco:verify-draw", game_code: "fconline", event_id: fcEventId, actor: "admin" });
  });
  const fcPair = (await publicContract.listFcoTopPairs(8, s1.id)).find((p) => [p.a_id, p.b_id].includes(s2.id));
  check("★★ FC 무승부는 승/패로 합성되지 않고 무로 센다 (세트·시리즈 모두)",
    fcPair !== undefined && fcPair.record.sets.draw === 1 && total(fcPair.record.sets) === 1 && fcPair.record.series.draw === 1,
    JSON.stringify(fcPair?.record));

  const lolChampsAfterFc = JSON.stringify([await personalDb.listChampionRecords(s1.id, 50), await personalDb.listChampionRecords(s2.id, 50)]);
  check("★★ FC 경기가 있어도 LoL 챔피언 기록이 성공하고 결과가 변하지 않는다",
    lolChampsAfterFc === lolChampsBeforeFc, `전 ${lolChampsBeforeFc.length}자 · 후 ${lolChampsAfterFc.length}자`);

  const [fcPublicLeak] = await sqlClient()<{ lol: number; detail: number; both: number }[]>`
    SELECT
      (SELECT count(*)::int FROM core_public.lol_versus_set WHERE match_id = 'fco:verify-draw') AS lol,
      (SELECT count(*)::int FROM core_public.match_detail WHERE match_id = 'fco:verify-draw') AS detail,
      (SELECT count(*)::int FROM core_public.versus_set WHERE match_id = 'fco:verify-draw') AS both
  `;
  check("★★ LoL 공개면(롤 세트·경기 보기·개인 기록)이 FC 판을 노출하지 않는다 — 두 게임을 잇는 versus_set 에만 있다",
    fcPublicLeak.lol === 0 && fcPublicLeak.detail === 0 && fcPublicLeak.both === 2
      && !(await personalDb.listPersonalSets(s1.id)).some((r) => r.match_id === "fco:verify-draw"),
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
  await scan({ played_at_precision: "datetime",
    match_id: "verify-cup:partialKda",
    played_at: new Date("2026-09-20T23:50:00Z"), winning_team: 200,
    result_evidence: "결과창에 툴팁이 겹쳐 데스·어시스트만 가렸다",
    participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, champion_id: 103, kills: 5 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, champion_id: 238, kills: 9, deaths: 1, assists: 4 },
    ],
  });
  const partial = (await personalDb.listChampionRecords(s1.id, 50)).find((c) => c.champion_id === 103);
  check("★★ KDA 를 일부만 읽은 판은 **분자에도 분모에도** 안 들어간다 (모르는 값이 0 이 되면 안 된다)",
    partial?.games === 1 && partial.kda_games === 0 && partial.kills === 0 && partial.deaths === 0,
    JSON.stringify(partial && { games: partial.games, kda_games: partial.kda_games, kills: partial.kills }));

  // ── 재판독으로 사람을 바꾸면 옛 사람 통계가 남나 (검수 피드백 #4)
  //
  // ⚠ upsertMatchFromScan 은 참가자를 DELETE 후 재INSERT 한다. 옛 명단을 **지우기 전에**
  //   잡지 않으면 "고친 뒤" 만 재계산 범위에 들어가고, 옛 사람에게 유령 경기가 남는다.
  await scan({ played_at_precision: "datetime",
    match_id: "verify-cup:swap",
    played_at: new Date("2026-09-21T01:00:00Z"), winning_team: 100,
    result_evidence: "판독 1차", participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, champion_id: 268, kills: 1, deaths: 1, assists: 1 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, champion_id: 238, kills: 2, deaths: 2, assists: 2 },
    ],
  });
  const alpha268 = async () => (await personalDb.listChampionRecords(s1.id, 50)).find((c) => c.champion_id === 268)?.games ?? 0;
  const ghostBefore = await alpha268();
  // 같은 자리를 다른 사람으로 다시 읽었다 (알파 → 베타)
  await scan({ played_at_precision: "datetime",
    match_id: "verify-cup:swap",
    played_at: new Date("2026-09-21T01:00:00Z"), winning_team: 100,
    result_evidence: "재판독 — 1번 자리는 알파가 아니라 베타였다", participants: [
      { participant_id: 1, puuid: betaPuuid, team_id: 100, champion_id: 268, kills: 1, deaths: 1, assists: 1 },
      { participant_id: 2, puuid: alphaPuuid, team_id: 200, champion_id: 238, kills: 2, deaths: 2, assists: 2 },
    ],
  });
  const ghostAfter = await alpha268();
  check("★★ 재판독으로 사람을 바꾸면 **옛 사람의 통계가 사라진다** (유령 전적 없음 — 통계는 지금 명단에서만 센다)",
    ghostBefore > 0 && ghostAfter === 0, `알파의 268 판 ${ghostBefore} → ${ghostAfter}`);

  // ── 식별(identify)이 판독값을 지우나 (검수 피드백 #1)
  //
  // ⚠ 예전엔 applyMatchReview 의 참가자 upsert 를 썼다. 그건 전 컬럼을 덮으므로,
  //   사람만 붙이려고 돌렸는데 **챔피언이 0, KDA 가 null 로 지워졌다.**
  const linkTarget = await scan({ played_at_precision: "datetime",
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
  const frameless = await scan({ played_at_precision: "datetime",
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
  check("★ 검수 화면이 행사 목록을 같이 받는다 (분류는 행사의 진행 방식에서 나온다 — 모르면 '분류 전')",
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
  await scan({ played_at_precision: "datetime",
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

  // ── 행사 분류를 바꾸면 공개 분류가 갈라지나 (지적 #5)
  //
  // ⚠ 옛 구조는 경기 쪽 분류는 질의 시점 계산, 조우·챔피언 통계는 **저장된 칸**이라 kind 만 바꾸면 둘이 갈라졌다.
  //   지금은 분류가 행사의 format 한 곳에만 있다 — 바꾸면 경기·상대전적·챔피언 기록이 같은 값을 본다.
  const catEvent = await ensureEvent({ game_code: "lol", slug: "verify-cat", name: "분류시험", format: "ck" });
  await scan({ played_at_precision: "datetime",
    match_id: "verify-cat:g1", event_id: catEvent,
    played_at: new Date("2026-09-21T05:00:00Z"), winning_team: 200, result_evidence: "결과창",
    participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, champion_id: 51, kills: 1, deaths: 1, assists: 1 },
      { participant_id: 2, puuid: betaPuuid, team_id: 200, champion_id: 22, kills: 2, deaths: 2, assists: 2 },
    ],
  });
  await sqlClient()`UPDATE match SET reviewed_at = now() WHERE match_id = 'verify-cat:g1'`;
  await updateEvent("verify-cat", { format: "tournament" });
  const catSet = await sqlClient()<{ format: string }[]>`
    SELECT DISTINCT format FROM core_public.lol_versus_set WHERE match_id = 'verify-cat:g1'
  `;
  const catPair = await sqlClient()<{ format: string }[]>`
    SELECT DISTINCT format FROM core_public.versus_pair_set WHERE match_id = 'verify-cat:g1'
  `;
  const catChamp = (await personalDb.listChampionRecords(s1.id, 50, { format: "tournament" })).some((c) => c.champion_id === 51)
    && !(await personalDb.listChampionRecords(s1.id, 50, { format: "ck" })).some((c) => c.champion_id === 51);
  check("★★ 행사 분류를 바꾸면 **경기·상대전적·챔피언 기록이 같이 바뀐다** (분류는 행사 한 곳 — 저장된 사본이 없다)",
    catSet.length === 1 && catSet[0].format === "tournament" && catPair.length === 1 && catPair[0].format === "tournament" && catChamp,
    JSON.stringify({ 세트: catSet, 짝: catPair, 챔피언: catChamp }));

  // ── 행사를 찾는 쪽과 고치는 쪽을 나눴나 (0035 — 멸망전 4개가 'ck' 로 덮인 사고)
  //
  // ★ VOD 조사 반영은 행사를 **읽기만** 해야 한다. 예전 upsertEvent 는 입력에 없는 칸까지
  //   null·기본값으로 덮어, 분류가 'ck' 로 바뀌고 주최·기간·출처가 사라졌다.
  const ownerId = await ensureEvent({
    game_code: "lol", slug: "verify-owner", name: "주인 있는 대회", format: "tournament", organizer: "SOOP",
    starts_at: "2020-03-12", source_url: "https://example.com/wiki",
  });
  const linkedId = await ensureEvent({ game_code: "lol", slug: "verify-owner" });
  const [ownerRow] = await sqlClient()<{ name: string; format: string; organizer: string | null; source_url: string | null }[]>`
    SELECT name, format, organizer, source_url FROM event WHERE slug = 'verify-owner'
  `;
  check("★★ 기존 행사에 연결만 하면 아무 칸도 바뀌지 않는다 (분류·주최·출처)",
    linkedId === ownerId && ownerRow.format === "tournament" && ownerRow.organizer === "SOOP"
      && ownerRow.source_url === "https://example.com/wiki" && ownerRow.name === "주인 있는 대회",
    JSON.stringify(ownerRow));
  await expectReject("★★ 연결하면서 다른 분류를 주면 덮지 않고 멈춘다",
    () => ensureEvent({ game_code: "lol", slug: "verify-owner", format: "ck" }), "이미 tournament");
  await expectReject("새 행사는 분류 없이 못 만든다 — 기본값이 없다(모르면 unclassified 를 명시)",
    () => ensureEvent({ game_code: "lol", slug: "verify-nokind", name: "분류 없음" }), "진행 방식(format)이 필요");
  await expectReject("새 행사는 이름 없이 못 만든다 — slug 로 대신하지 않는다",
    () => ensureEvent({ game_code: "lol", slug: "verify-noname", format: "ck" }), "이름이 필요");
  await expectReject("DB 에도 분류 기본값이 없다 — 빠뜨린 INSERT 는 거부된다",
    async () => { await sqlClient()`INSERT INTO event (slug, name) VALUES ('verify-raw', '원시 삽입')`; },
    "format");
  await updateEvent("verify-owner", { starts_at: null, ends_at: undefined });
  const [patched] = await sqlClient()<{ starts_at: Date | null; organizer: string | null }[]>`
    SELECT starts_at, organizer FROM event WHERE slug = 'verify-owner'
  `;
  check("★ 행사 수정은 생략한 칸을 유지하고, 명시한 null 만 비운다",
    patched.starts_at === null && patched.organizer === "SOOP", JSON.stringify(patched));

  // ── 시리즈 라운드명·세트 순서 (0035)
  await sqlClient().begin(async (tx) => {
    await classification.ensureSeriesInTx(tx, { id: "verify-owner:g01", game_code: "lol", event_id: ownerId, round_label: "8강 1경기", set_order_known: true });
    await classification.ensureSeriesInTx(tx, { id: "verify-owner:g01", game_code: "lol", event_id: ownerId, round_label: "8강 1경기", set_order_known: false });
  });
  const [roundRow] = await sqlClient()<{ round_label: string; set_order_known: boolean }[]>`
    SELECT round_label, set_order_known FROM match_series WHERE id = 'verify-owner:g01'
  `;
  check("★ 확인된 세트 순서는 '모름' 입력으로 내려가지 않는다",
    roundRow.round_label === "8강 1경기" && roundRow.set_order_known === true, JSON.stringify(roundRow));
  await expectReject("★ 같은 시리즈에 다른 라운드명이 오면 하나를 고르지 않고 멈춘다",
    () => sqlClient().begin((tx) => classification.ensureSeriesInTx(tx, {
      id: "verify-owner:g01", game_code: "lol", event_id: ownerId, round_label: "4강 1경기",
    })), "라운드명은 이미");
  await expectReject("★ 같은 시리즈 키로 다른 행사를 주면 조용히 옮기지 않는다 — 옮기는 길은 moveSeriesInTx 하나",
    () => sqlClient().begin((tx) => classification.ensureSeriesInTx(tx, {
      id: "verify-owner:g01", game_code: "lol", event_id: catEvent,
    })), "moveSeriesInTx");
  await sqlClient().begin((tx) => classification.dropEmptySeriesInTx(tx, "verify-owner:g01"));

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
    await insertSetInTx(tx, { match_id: "verify-cup:later", event_id: ckEvent, at: new Date(), collected_via: "vod" });
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

  // ── 숨긴 계정이 공개 계약에 남나 (지적 #8)
  //
  // ⚠ puuid 와 streamer_id 가 **함께** 있는 행에서만 터진다 — VOD 판독으로 손수 이은 참가자의 모양이다.
  // ★ 규칙(0089 §5.1): 계정으로 확인된 자리는 계정·스트리머 둘 다 공개일 때만 나온다. 같은 자리에 사람이 함께 적혀 있어도
  //   계정 규칙이 이긴다 — 숨긴 계정의 판은 그 자리째 공개 기록에서 빠진다(옛 0021 은 식별자만 지우고 자리를 남겼다).
  await scan({ played_at_precision: "datetime",
    match_id: "verify-cup:hidden", played_at: new Date("2026-09-21T06:00:00Z"), winning_team: 100,
    result_evidence: "결과창", participants: [
      { participant_id: 1, puuid: alphaPuuid, streamer_id: s1.id, team_id: 100, champion_id: 157 },
      { participant_id: 2, streamer_id: s2.id, team_id: 200, champion_id: 238 },
    ],
  });
  const hiddenSeat = async () => ({
    alphaSets: (await personalDb.listPersonalSets(s1.id)).some((r) => r.match_id === "verify-cup:hidden"),
    roster: (await publicContract.listMatchRosters(["verify-cup:hidden"])).map((r) => r.streamer_id),
    pairs: await pairRows("verify-cup:hidden"),
  });
  const beforeHide = await hiddenSeat();
  await sqlClient()`UPDATE streamer_account SET visibility = 'hidden' WHERE puuid = ${alphaPuuid}`;
  const afterHide = await hiddenSeat();
  check("★★ 계정을 숨기면 **그 계정의 자리가 공개 기록·로스터·상대전적에서 빠진다** (부계정 오노출은 실제 분쟁이 된다)",
    beforeHide.alphaSets && beforeHide.pairs === 2 && beforeHide.roster.includes(s1.id)
      && !afterHide.alphaSets && afterHide.pairs === 0 && !afterHide.roster.includes(s1.id),
    JSON.stringify({ 전: beforeHide, 후: afterHide }));
  const rawSeats = await sqlClient()<{ n: number }[]>`SELECT count(*)::int AS n FROM match_participant WHERE match_id = 'verify-cup:hidden'`;
  check("★ 그래도 **원본 참가 기록은 남고**, 다른 사람의 자리는 그대로 공개다 — 숨김은 공개면만 거른다",
    rawSeats[0].n === 2 && afterHide.roster.length === 1 && afterHide.roster[0] === s2.id,
    JSON.stringify({ 원본: rawSeats[0].n, 로스터: afterHide.roster }));
  // ★ 공개 경로는 둘이다 — 집계(lol_versus_set)와 경기 보기(match_detail). 같은 공개 규칙을 각자 옮겨 적은 것이라
  //   한쪽만 고치면 프로필과 로스터가 다른 사람을 말한다. 숨긴 계정이 있는 지금과 되돌린 뒤 둘 다 대조한다(옛 0075 streamer_match 검사).
  const publicPathDrift = async () => (await sqlClient()<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      (SELECT streamer_id, match_id, slot FROM core_public.lol_versus_set
       EXCEPT ALL SELECT streamer_id, match_id, participant_id FROM core_public.match_detail
        WHERE streamer_id IS NOT NULL AND set_role = 'main' AND map IN ('rift', 'aram'))
      UNION ALL
      (SELECT streamer_id, match_id, participant_id FROM core_public.match_detail
        WHERE streamer_id IS NOT NULL AND set_role = 'main' AND map IN ('rift', 'aram')
       EXCEPT ALL SELECT streamer_id, match_id, slot FROM core_public.lol_versus_set)
    ) d`)[0].n;
  const driftHidden = await publicPathDrift();
  await sqlClient()`UPDATE streamer_account SET visibility = 'public' WHERE puuid = ${alphaPuuid}`;
  const driftPublic = await publicPathDrift();
  check("★ 공개 집계(lol_versus_set)와 경기 보기(match_detail)는 사람이 붙은 본게임 자리가 **같은 행**이다 (계정 숨김 상태 포함)",
    driftHidden === 0 && driftPublic === 0, JSON.stringify({ 숨김: driftHidden, 공개: driftPublic }));

  // ── 미확인 참가자가 로스터에 서나 (0022)
  //
  // ⚠ 예전엔 `streamer_id` 가 없다는 이유로 공개 뷰에서 행째로 빠졌다. 그래서 5대5 가
  //   **4명으로** 그려졌고, 보는 사람은 누락인지 인원 차이인지 구분할 수 없었다.
  await scan({ played_at_precision: "datetime",
    match_id: "verify-cup:unknown", played_at: new Date("2026-09-21T10:00:00Z"), winning_team: 100,
    result_evidence: "결과창 — 한 명은 우리 명단에 없다",
    participants: [
      { participant_id: 1, puuid: alphaPuuid, team_id: 100, champion_id: 157, kills: 5, deaths: 1, assists: 2 },
      { participant_id: 2, observed_name: "소년가장 원딜", team_id: 100, champion_id: 34, kills: 3, deaths: 8, assists: 7 },
      { participant_id: 3, puuid: betaPuuid, team_id: 200, champion_id: 238, kills: 1, deaths: 5, assists: 0 },
    ],
  });
  const roster = await publicContract.listMatchRosters(["verify-cup:unknown"]);
  const unknownSeat = roster.find((r) => r.streamer_id === null);
  check("★★ 사람을 못 붙인 자리도 **공개 로스터에 선다** (5대5 를 4명으로 그리면 안 된다)",
    roster.length === 3 && unknownSeat !== undefined,
    `${roster.length}자리`);
  check("★ 그 자리는 화면에서 읽은 인게임명으로 나온다 (챔피언·KDA 도 같이)",
    unknownSeat?.observed_name === "소년가장 원딜" && unknownSeat?.champion_id === 34 && unknownSeat.kills === 3,
    JSON.stringify(unknownSeat));
  const namedSeat = roster.find((r) => r.streamer_id !== null);
  check("★ 등록된 사람은 observed_name 을 안 내보낸다 (부계정 인게임명을 덧붙일 이유가 없다)",
    namedSeat?.observed_name === null, JSON.stringify(namedSeat));

  // 숨김이 이 문으로 새지 않나 — 숨긴 계정 자리가 '미확인' 자리로 둔갑하면 안 된다
  await sqlClient()`UPDATE streamer_account SET visibility = 'hidden' WHERE puuid = ${alphaPuuid}`;
  const afterHidden = await publicContract.listMatchRosters(["verify-cup:unknown"]);
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
  await scan({ played_at_precision: "datetime",
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
  const rescanHandmade = await scan({ played_at_precision: "datetime",
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

  console.log("\n▸ 코드 내전 분류 · 계정 연결이 공개 기록에 바로 반영되나 (0077 · 0089)");
  {
    const g1 = await streamers.createStreamer({ slug: "verify-code-a", display_name: "코드내전A" });
    const g2 = await streamers.createStreamer({ slug: "verify-code-b", display_name: "코드내전B" });
    const [pA, pB] = ["ca".repeat(39), "cb".repeat(39)];
    await streamers.upsertRiotAccount({ puuid: pA, game_name: "코드A", tag_line: "KR1" });
    await streamers.upsertRiotAccount({ puuid: pB, game_name: "코드B", tag_line: "KR1" });
    await streamers.linkAccount({ streamer_id: g1.id, puuid: pA, confidence: "verified", evidence: { note: "검증" } });
    const codeAt = new Date("2026-09-25T12:00:00Z");
    await ingestDb.saveMatch(riotGame("KR_CODE1", 9001, codeAt, [
      { puuid: pA, teamId: 100, championId: 157, position: "MIDDLE", kills: 5, deaths: 2, assists: 7 },
      { puuid: pB, teamId: 200, championId: 238, position: "MIDDLE", kills: 2, deaths: 5, assists: 3 },
    ], { queueId: 3130, tournamentCode: "KR-verify" }));
    const [codeSet] = await sqlClient()<{ format: string; auto_bucket: boolean; slug: string }[]>`
      SELECT v.format, v.auto_bucket, e.slug FROM core_public.lol_versus_set v JOIN core_public.event e ON e.event_id = v.event_id
       WHERE v.match_id = 'KR_CODE1'`;
    check("★ 행사가 안 붙은 토너먼트 코드 경기는 CK 가 아니라 '분류 전'이다 — 날짜 자동 묶음, 사람이 실제 행사로 옮겨 분류한다",
      codeSet?.format === "unclassified" && codeSet.auto_bucket === true && codeSet.slug === classification.lolCodeBucketSlug(codeAt),
      JSON.stringify(codeSet));

    const statOf = async (id: string) => (await personalDb.listChampionRecords(id, 50)).reduce((n, c) => n + c.games, 0);
    const pairsBefore = await pairRows("KR_CODE1");
    await streamers.linkAccount({ streamer_id: g2.id, puuid: pB, confidence: "likely", evidence: { note: "검증" } });
    const [pairsLinked, statLinked] = [await pairRows("KR_CODE1"), await statOf(g2.id)];
    check("★★ 계정을 연결하면 **워커·재파생 없이** 그 계정의 과거 판이 상대전적과 챔피언 기록에 바로 나온다 (신규 스트리머 등록 후 과거 조우가 되살아난다)",
      pairsBefore === 0 && pairsLinked === 2 && statLinked === 1, JSON.stringify({ pairsBefore, pairsLinked, statLinked }));
    await streamers.unlinkAccount(g2.id, pB);
    const [pairsUnlinked, statUnlinked] = [await pairRows("KR_CODE1"), await statOf(g2.id)];
    check("★★ 연결을 떼면 그 상대전적과 챔피언 기록도 바로 사라진다(유령 전적 없음)",
      pairsUnlinked === 0 && statUnlinked === 0, JSON.stringify({ pairsUnlinked, statUnlinked }));

    // 계정으로 붙은 사람(g1) + 참가자 행에 직접 적힌 사람(g2, VOD 판독 연결)이 섞인 경기.
    // 옛 구조는 재파생 대상 찾기가 파생과 다르게 세어 한 번 고쳐도 영원히 "필요" 로 남았다(730경기 사고). 지금은 대상 자체가 없다.
    await ingestDb.saveMatch(riotGame("KR_CODE2", 9002, codeAt, [
      { puuid: pA, teamId: 100, championId: 157 }, { puuid: "cc".repeat(39), teamId: 200, championId: 238 },
    ], { queueId: 3130, tournamentCode: "KR-verify2" }));
    await sqlClient()`UPDATE match_participant SET puuid = NULL, streamer_id = ${g2.id}::uuid
                       WHERE match_id = 'KR_CODE2' AND participant_id = 2`;
    check("★★ 계정 연결·직접 연결이 섞인 경기도 원본을 고친 그 자리에서 상대전적 한 쌍으로 나온다 (재파생 대상이 따로 없다)",
      (await pairRows("KR_CODE2")) === 2 && (await vsRecord(g1.id, g2.id)) !== null, String(await pairRows("KR_CODE2")));

    console.log("\n▸ 칼바람은 하나로, 아레나·우르프는 어느 공개 화면에도 없다 (0078 · match.map)");
    // 토너먼트 코드 판으로 넣는다 — 맵은 Riot 사실(game_mode·queue)에서 생성 칼럼으로 정해지고, 공개 세트는 맵 탭으로 고른다.
    for (const [id, gid, queue, mode] of [
      ["KR_MAYHEM1", 9003, 2400, "KIWI"], ["KR_ARENA1", 9004, 1750, "CHERRY"], ["KR_URF1", 9005, 900, "URF"],
    ] as const) {
      await ingestDb.saveMatch(riotGame(id, gid, codeAt, [
        { puuid: pA, teamId: 100, championId: 157 }, { puuid: pB, teamId: 200, championId: 238 },
      ], { queueId: queue, gameMode: mode, tournamentCode: `KR-${id}` }));
    }
    const modeIds = ["KR_MAYHEM1", "KR_ARENA1", "KR_URF1"];
    const inTab = async (map: "rift" | "aram") => (await personalDb.listPersonalSets(g1.id, { map }))
      .map((r) => r.match_id).filter((id) => modeIds.includes(id)).sort().join(",");
    const [riftTab, aramTab] = [await inTab("rift"), await inTab("aram")];
    check("★ 증강 칼바람(2400)은 game_mode 와 상관없이 칼바람 탭에만 있다",
      aramTab === "KR_MAYHEM1" && !riftTab.includes("KR_MAYHEM1"), JSON.stringify({ riftTab, aramTab }));
    // ★ 계획 §3.3: map='unsupported' 는 **집계 제외**다 — 공개 세트·상대전적에 없다. (경기 하나 보기 match_detail 은 맵으로
    //   거르지 않는다 — 옛 0078 은 모든 공개 뷰에서 뺐다. 이 차이는 보고서에 남겼다.)
    const anyPublic = await sqlClient()<{ match_id: string }[]>`
      SELECT DISTINCT match_id FROM core_public.lol_versus_set WHERE match_id IN ('KR_ARENA1', 'KR_URF1')
      UNION SELECT DISTINCT match_id FROM core_public.versus_pair_set WHERE match_id IN ('KR_ARENA1', 'KR_URF1')`;
    check("★ 아레나·우르프는 협곡·칼바람 어느 집계(공개 세트·상대전적)에도 없다(원본은 남는다)",
      riftTab === "" && anyPublic.length === 0
        && (await sqlClient()`SELECT 1 FROM match WHERE match_id IN ('KR_ARENA1','KR_URF1')`).length === 2,
      JSON.stringify({ riftTab, anyPublic }));
    const champTabs = [...await personalDb.listChampionRecords(g1.id, 50, { map: "rift" }), ...await personalDb.listChampionRecords(g1.id, 50, { map: "aram" })];
    check("★ 아레나·우르프 판은 챔피언 기록(협곡·칼바람 어느 탭)에도 없다",
      champTabs.reduce((n, c) => n + c.games, 0) === 3, JSON.stringify(champTabs.map((c) => [c.champion_id, c.games])));

    console.log("\n▸ 랜드는 판이 세트·그날이 시리즈, 보너스 판은 펼친 목록에만 보이고 집계에 없다 (0079 · 계획 §5.2)");
    const landEv = await ensureEvent({ game_code: "lol", slug: "verify-land", name: "검증 랜드", format: "land" });
    const ckEv = await ensureEvent({ game_code: "lol", slug: "verify-bonus-ck", name: "검증 CK", format: "ck" });
    // 랜드 3판: g1 이 g2 와 적·아군·적 (팀이 매 판 섞인다). g1 기준 승·승·패.
    // CK 2판 본게임 g1 2:0 승 + 보너스 1판 g1 패.
    const games: [string, string, string, number, "main" | "bonus", 100 | 200, 100 | 200][] = [
      ["VL1", landEv, "verify-land:land", 1, "main", 100, 200], ["VL2", landEv, "verify-land:land", 2, "main", 100, 100],
      ["VL3", landEv, "verify-land:land", 3, "main", 200, 200],
      ["VB1", ckEv, "verify-bonus-ck:s", 1, "main", 100, 200], ["VB2", ckEv, "verify-bonus-ck:s", 2, "main", 100, 200],
      ["VB3", ckEv, "verify-bonus-ck:s", 3, "bonus", 200, 200],
    ];
    const base = Date.now();
    for (const [id, ev, series, no, role, win, g2team] of games) {
      await sqlClient().begin(async (tx) => {
        await insertSetInTx(tx, { match_id: id, event_id: ev, at: new Date(base + no * 3_600_000), series_id: series, game_no: no,
          winning_team: win, collected_via: "vod", set_role: role, set_label: role === "bonus" ? "범인찾기" : null });
        await tx`
          INSERT INTO match_participant (match_id, puuid, streamer_id, participant_id, team_id, team_position, champion_id, outcome)
          VALUES (${id}, ${pA}, NULL, 1, 100, 'MIDDLE', 157, ${win === 100 ? "win" : "loss"}),
                 (${id}, NULL, ${g2.id}::uuid, ${g2team === 100 ? 2 : 6}, ${g2team}, ${g2team === 100 ? "TOP" : "MIDDLE"}, 238,
                  ${win === g2team ? "win" : "loss"})`;
      });
    }
    await expectReject("본게임 시리즈 없이 보너스 판은 만들 수 없다", () => sqlClient()`
      INSERT INTO match (match_id, game_code, queue_id, game_creation, winning_team, collected_via, scope, set_role)
      VALUES ('VB_ORPHAN', 'lol', 0, now(), 100, 'vod', 'personal', 'bonus')`, "match_bonus_in_series");
    const ids = games.map((g) => g[0]);
    const listIn = async (view: string) => (await sqlClient().unsafe<{ match_id: string }[]>(
      `SELECT DISTINCT match_id FROM core_public.${view} WHERE match_id = ANY($1) ORDER BY 1`, [ids])).map((r) => r.match_id).join(",");
    check("★ 보너스 판은 집계용 세트·상대전적 뷰에 없고 경기 보기(펼친 목록)에만 있다",
      (await listIn("lol_versus_set")) === "VB1,VB2,VL1,VL2,VL3" && (await listIn("versus_pair_set")) === "VB1,VB2,VL1,VL2,VL3"
        && (await listIn("match_detail")) === "VB1,VB2,VB3,VL1,VL2,VL3",
      JSON.stringify({ s: await listIn("lol_versus_set"), p: await listIn("versus_pair_set"), d: await listIn("match_detail") }));
    const landPairs = (await opponents.listPairSets(g1.id, { format: "land" }, g2.id)).filter((r) => ["VL1", "VL3"].includes(r.match_id));
    check("★ 랜드 판의 시리즈는 그날 랜드 묶음이다 — 화면은 한 줄로 접고, 세는 건 tally 가 세트(판)·시리즈(묶음)로 한다",
      landPairs.length === 2 && landPairs.every((r) => r.series_id === "verify-land:land" && r.format === "land"), JSON.stringify(landPairs.map((r) => [r.match_id, r.series_id, r.format])));
    const landMatches = (await opponents.listOpponentHistoryMatches(g1.id, g2.id, { format: "land" })).matches;
    check("★ 프로필 상대전적: 랜드는 한 줄(묶음) — 적으로 만난 2판(1승 1패)이 세트, 그 묶음이 시리즈 1개(무)",
      landMatches.length === 1 && landMatches[0].record.win === 1 && landMatches[0].record.loss === 1 && landMatches[0].result === "draw",
      JSON.stringify(landMatches.map((m) => ({ record: m.record, result: m.result }))));
    const vs = await vsRecord(g1.id, g2.id, { format: "land" });
    const allyLand = (await opponents.listPairSets(g1.id, { format: "land" }, g2.id)).filter((r) => r.relation === "teammate");
    check("★ 랜드 상대전적: 적으로 2판(세트 1승 1패) · 시리즈 1무, 아군 1판은 상대전적에 없다",
      vs !== null && sameCounts(vs.sets, { win: 1, draw: 0, loss: 1, unknown: 0 }) && sameCounts(vs.series, { win: 0, draw: 1, loss: 0, unknown: 0 })
        && allyLand.length === 1 && allyLand[0].match_id === "VL2",
      JSON.stringify(vs));
    const ckVs = await vsRecord(g1.id, g2.id, { format: "ck" });
    check("★ CK 상대전적에 보너스 판이 없다 — 본게임 2:0 만 (세트 2승 · 시리즈 1승)",
      ckVs !== null && sameCounts(ckVs.sets, { win: 2, draw: 0, loss: 0, unknown: 0 }) && sameCounts(ckVs.series, { win: 1, draw: 0, loss: 0, unknown: 0 }),
      JSON.stringify(ckVs));
    const g1Sets = await personalDb.listPersonalSets(g1.id);
    const hist = (await personalDb.listPersonalMatches(g1.id, g1Sets, { limit: 100 })).rows;
    const landRow = hist.find((h) => h.series_id === "verify-land:land");
    const ckRow = hist.find((h) => h.series_id === "verify-bonus-ck:s");
    check("★ 히스토리: 랜드 3판은 한 줄(2승 1패 → 승), CK 는 한 줄에 보너스까지 펼쳐지되 스코어는 2:0",
      landRow?.record.win === 2 && landRow.record.loss === 1 && landRow.result === "win"
        && ckRow?.record.win === 2 && total(ckRow.record) === 2
        && ckRow.sets.length === 3 && ckRow.sets[2].set_role === "bonus" && ckRow.sets[2].set_label === "범인찾기"
        && ckRow.sets[0].set_label === null,
      JSON.stringify({ landRow: landRow && [landRow.record, landRow.result], ckRow: ckRow?.sets }));
    check("보너스 판의 참가자 명단은 펼친 히스토리에 남는다",
      (await publicContract.listMatchRosters(["VB3"])).length === 2);
    const landRec = tally(await personalDb.listPersonalSets(g1.id, { format: "land" }));
    const ckRec = tally(await personalDb.listPersonalSets(g1.id, { format: "ck" }));
    check("★ 개인 요약: 랜드는 세트 3판 2승 1패·시리즈 1승, CK 는 보너스 없이 세트 2승·시리즈 1승",
      sameCounts(landRec.sets, { win: 2, draw: 0, loss: 1, unknown: 0 }) && sameCounts(landRec.series, { win: 1, draw: 0, loss: 0, unknown: 0 })
        && sameCounts(ckRec.sets, { win: 2, draw: 0, loss: 0, unknown: 0 }) && sameCounts(ckRec.series, { win: 1, draw: 0, loss: 0, unknown: 0 }),
      JSON.stringify({ landRec, ckRec }));
    const statGames = (await personalDb.listChampionRecords(g1.id, 50, { format: "ck" })).reduce((n, c) => n + c.games, 0);
    check("★ 챔피언 기록에 보너스 판이 없다", statGames === 2, String(statGames));

    // 한 맵 탭 안에서 "전체" = 진행 방식 칩들의 합(계획 §5.3) — 이 사람의 실제 기록(코드 판·랜드·CK)으로 확인한다.
    const allRift = tally(await personalDb.listPersonalSets(g1.id, { map: "rift" }));
    const chips = await Promise.all(publicContract.FORMATS_BY_GAME.lol.map(async (f) => tally(await personalDb.listPersonalSets(g1.id, { map: "rift", format: f }))));
    const chipSum = (k: "sets" | "series") => chips.reduce<Counts>((acc, t) => ({ win: acc.win + t[k].win, draw: acc.draw + t[k].draw, loss: acc.loss + t[k].loss, unknown: acc.unknown + t[k].unknown }), { win: 0, draw: 0, loss: 0, unknown: 0 });
    check("★ 협곡 탭에서 '전체' = 진행 방식 칩 합 — 분류 전(코드 판)도 칩이 있어 몰래 빠지는 판이 없다",
      sameCounts(allRift.sets, chipSum("sets")) && sameCounts(allRift.series, chipSum("series")) && total(allRift.sets) > 0,
      `전체 ${counts(allRift.sets)} · 칩 합 ${counts(chipSum("sets"))}`);

    console.log("\n▸ 다른 시점에서 같은 판을 새 ID 로 또 만들 수 없다 (2026-10-07 중복 39건)");
    const T = new Date("2026-09-30T12:00:00Z");
    const roster = (flip: boolean, kdaShift = 0) => Array.from({ length: 10 }, (_, i) => ({
      participant_id: i + 1, observed_name: `중복검증${i}`,
      team_id: ((i < 5) !== flip ? 100 : 200) as 100 | 200, champion_id: i + 1,
      kills: i + kdaShift, deaths: i + 1, assists: i + 2,
    }));
    const game = (id: string, at: Date, flip: boolean, extra: Partial<Parameters<typeof ck.upsertMatchFromScan>[0]> = {}) =>
      ck.upsertMatchFromScan({ event_id: ckEvent, match_id: id, played_at: at, played_at_precision: "datetime", duration: 1500,
        winning_team: flip ? 200 : 100, participants: roster(flip), ...extra });
    await game("VD1", T, false);
    await expectReject("★★ 진영이 뒤집힌 다른 시점의 같은 판(새 ID)은 저장을 거부한다",
      () => game("VD2", new Date(T.getTime() + 60_000), true), "같은 판으로 보이는 공개 경기가 이미 있다 — VD1");
    check("  └ 거부되면 아무것도 남지 않는다",
      (await sqlClient()`SELECT 1 FROM match WHERE match_id = 'VD2'`).length === 0);
    await game("VD1", T, false, { duration: 1501 });
    check("같은 ID 로 다시 내는 것(시점 추가·정정)은 막지 않는다",
      (await sqlClient()<{ d: number }[]>`SELECT game_duration d FROM match WHERE match_id='VD1'`)[0]?.d === 1501);
    await game("VD3", new Date(T.getTime() + 10 * 60_000), false,
      { duration: 1800, participants: roster(false, 3) });
    check("★ 가까운 시각에 같은 챔피언으로 한 **다른 판**(경기 시간·KDA 다름)은 막지 않는다",
      (await sqlClient()`SELECT 1 FROM match WHERE match_id = 'VD3'`).length === 1);
    await game("VD2", new Date(T.getTime() + 60_000), true, { distinct_from: ["VD1"] });
    const distinctLog = await sqlClient()<{ after: unknown }[]>`
      SELECT after FROM review_change WHERE match_id = 'VD2' AND field = 'distinct_from'`;
    check("★ distinct_from 으로 다른 판임을 밝히면 저장되고 그 판단이 이력에 남는다",
      JSON.stringify(distinctLog[0]?.after) === JSON.stringify(["VD1"]), JSON.stringify(distinctLog));
  }

  await verifyCkDuplicatesDb();
  await verifyCkDuplicateMergeDb();
  await verifyMatchSeriesDb();
  await verifyScheduleDb(check, expectReject);
  await verifyPuuidMoveDb(check);
  await verifyNameHistoryDb(check);
  await verifyNormNameSqlDb(check);
  await verifyMemberDb(check, expectReject);
  await verifyCommunityDb(check, expectReject);
  await verifyCollectionDb(check, riotGame);
  await verifySubmissionDb(check, expectReject);
  await verifyScheduleReportDb(check, expectReject);
  await verifyVodRequestDb(check, expectReject);
} finally {
  await closeDb();
  await server.stop();
  await db.close();
}

console.log(failures === 0 ? "\n전부 통과.\n" : `\n${failures}건 실패.\n`);
process.exit(failures === 0 ? 0 : 1);
