/**
 * 분류·수집 뼈대 리허설 — 운영 데이터 복사본에 초안(db/migrations/0089_classification_skeleton.sql)을 돌려
 * 옮겨 담기 대조(계획 §8)와 공개 질의 속도(§5.1: 질의당 200ms 이하)를 잰다. 계획 §8 1단계(성능)·3단계(리허설).
 *
 *   CK_PG_BIN=<PostgreSQL 17 bin 디렉터리> node --env-file=apps/web/.env.local scripts/skeleton-rehearsal.ts
 *
 * ★ 운영 DB 는 **읽기 전용 트랜잭션**으로만 읽는다(default_transaction_read_only). 쓰는 곳은 이 PC 에 새로 띄운
 *   일회용 PostgreSQL(disposablePostgres — 외부 DATABASE_URL 을 받지 않는다)뿐이고, 끝나면 지운다.
 * ★ 공개 큐 판은 경기 행은 전부, 참가자는 지명 범위(솔랭 도전) 판만 복사한다 — 지울 판의 참가자 27만 행을 운영에서 읽지 않는다.
 *   지우는 규칙 자체는 경기 행 전부로 검사된다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";

import { FORMATS_BY_GAME } from "../packages/core/lib/metrics/format.ts";
import { mirror, pairSetOutcome, tally, type Outcome } from "../packages/core/lib/metrics/tally.ts";
import { disposablePostgres } from "./lib/disposable-postgres.ts";
import { applyAll, loadMigrations } from "./lib/migrations.ts";
import { runCutover } from "./cutover-0089.ts";

const ROOT = join(import.meta.dirname, "..");
const DRAFT = readFileSync(join(ROOT, "db/migrations/0089_classification_skeleton.sql"), "utf8");
const DUO = ["jAu-Fy-yQ96GJFQtR4mbyYIiumZdM8v3dmyaPu4dQuAslWnjeiGfKLJmu2-yQe79gBdWbKDpZmTivA",
  "hmeMsJn7_kn3-w6SLpjVBC59hkbzfdiTi6hOWv2aSpbIgYBJCnf8hUigsdf7seukt7x0eV610pO9fw"];
const BUDGET_MS = 200;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 이 없다 — node --env-file=apps/web/.env.local 로 실행");
const src = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const local = await disposablePostgres();
const dst = postgres(local.url, { max: 1, onnotice: () => {} });
const t0 = Date.now();
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);

let failed = 0;
const check = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${(e as Error).message.split("\n").slice(0, 12).join("\n    ")}`); }
};

try {
  await applyAll((s) => dst.unsafe(s).then(() => undefined), ROOT, { before: "0089" });
  log("빈 DB 에 0088 까지 적용");

  // ── 복사(운영 → 일회용) ────────────────────────────────────────────────
  const pqKeep = `SELECT DISTINCT p.match_id FROM match_participant p JOIN match m ON m.match_id = p.match_id
                   WHERE m.source = 'public_queue' AND p.puuid IN ('${DUO.join("','")}')`;
  // 남길 공개 큐 판 = 지명 범위(두 계정 · 솔랭 420 · 2026-08-21 KST 이후). 범위 밖(아레나·그 이전)은 지워질 판이다.
  const pqKeepRange = `SELECT DISTINCT p.match_id FROM match_participant p JOIN match m ON m.match_id = p.match_id
                   WHERE m.source = 'public_queue' AND p.puuid IN ('${DUO.join("','")}') AND m.queue_id = 420 AND m.game_creation >= '2026-08-21 00:00+09'`;
  const TABLES: [string, string][] = [
    ["streamer", "true"], ["riot_account", "true"], ["streamer_account", "true"],
    ["event", "true"], ["event_team", "true"], ["event_team_member", "true"], ["event_team_listed_name", "true"],
    ["event_stage", "true"], ["event_slot", "true"], ["event_route", "true"], ["event_slot_match", "true"],
    ["event_slot_decision", "true"], ["event_link", "true"], ["event_fact", "true"], ["career_event", "true"],
    ["schedule_entry", "true"], ["match_series", "true"], ["match", "true"],
    ["match_participant", `match_id IN (SELECT match_id FROM match WHERE source <> 'public_queue') OR match_id IN (${pqKeep})`],
    ["fco_account", "true"], ["streamer_fco_account", "true"], ["fco_match_participant", "true"],
    ["fco_event_match_decision", "true"], ["fco_match_context", "true"], ["review_change", "true"],
  ];
  await dst.unsafe("SET session_replication_role = replica");  // 적재 중에는 트리거·FK 를 끈다(원본 그대로 옮기기)
  // 운영은 읽기 전용 트랜잭션 하나로 — 한 시점의 일관된 사진이고, 쓰기는 시도조차 거부된다.
  await src.begin("isolation level repeatable read read only", async (tx) => {
    for (const [table, where] of TABLES) {
      const rows = await tx.unsafe(`SELECT coalesce(json_agg(t), '[]'::json) AS j FROM (SELECT * FROM ${table} WHERE ${where}) t`);
      const json = rows[0]!.j as unknown[];
      if (json.length) await dst.unsafe(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table}, $1::text::json)`, [JSON.stringify(json)]);
      log(`복사 ${table} ${json.length}행`);
    }
  });
  await dst.unsafe("SET session_replication_role = origin");
  // 복사한 일련번호를 시퀀스가 따라가게 — 운영의 시퀀스 위치와 같아진다.
  await dst.unsafe(`SELECT setval(pg_get_serial_sequence('review_change', 'id'), (SELECT max(id) FROM review_change))`);
  await dst.unsafe("ANALYZE");

  // ── 전환 — 실제 전환 도구(scripts/cutover-0089.ts)의 runCutover 를 그대로 쓴다(같은 잠금·기준·대조·장부) ──
  await dst.unsafe(`CREATE TABLE IF NOT EXISTS schema_migration (version text PRIMARY KEY, name text NOT NULL, checksum text,
                      applied_at timestamptz NOT NULL DEFAULT now())`);
  for (const m of loadMigrations(ROOT).filter((x) => x.version < "0089")) {
    await dst`INSERT INTO schema_migration (version, name, checksum) VALUES (${m.version}, ${m.name}, ${m.checksum}) ON CONFLICT DO NOTHING`;
  }
  const preview = await runCutover(dst, { apply: false, log });
  log(`미리보기: ${preview.committed ? "커밋됨(?!)" : "되돌림"} · 대조 실패 ${preview.failures.length}`);
  if (preview.committed || (await dst`SELECT count(*)::int AS n FROM schema_migration WHERE version = '0089'`)[0]!.n !== 0) {
    failed++; console.error("  ✗ 미리보기가 흔적을 남겼다");
  }
  const result = await runCutover(dst, { apply: true, log });
  console.log("\n대조:");
  for (const f of result.failures) { failed++; console.error(`  ✗ ${f}`); }
  if (!result.failures.length) console.log("  ✓ 전부 통과");
  for (const i of result.info) console.log(`  ${i}`);
  if (!result.committed) { failed++; console.error("  ✗ 커밋되지 않았다"); }
  await dst.unsafe("ANALYZE");

  const scalar = async (text: string) => (await dst.unsafe(text))[0]!;
  // ── 속도 ────────────────────────────────────────────────────────────────
  console.log(`\n속도(운영 복사본 · PostgreSQL ${(await scalar("SHOW server_version")).server_version} · 5회 중앙값, 기준 ${BUDGET_MS}ms):`);
  const top = await dst.unsafe(`SELECT streamer_id::text AS s, count(*)::int AS n FROM core_public.versus_set WHERE game_code = 'lol' GROUP BY 1 ORDER BY 2 DESC LIMIT 1`);
  const fcTop = await dst.unsafe(`SELECT streamer_id::text AS s FROM core_public.versus_set WHERE game_code = 'fconline' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`);
  const rival = await dst.unsafe(`SELECT b_streamer_id::text AS s FROM core_public.versus_pair_set WHERE a_streamer_id = '${top[0]!.s}' AND relation = 'opponent' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`);
  const S = top[0]!.s, R = rival[0]!.s, F = fcTop[0]!.s;
  const anyMatch = (await scalar(`SELECT match_id FROM core_public.versus_set WHERE streamer_id = '${S}' LIMIT 1`)).match_id;
  console.log(`  표본: 세트가 가장 많은 롤 스트리머(${top[0]!.n}세트)와 그 최다 상대, FC 최다 스트리머`);
  const QUERIES: [string, string][] = [
    ["프로필 요약·필터(롤)", `SELECT series_id, outcome, format, map FROM core_public.versus_set WHERE streamer_id = '${S}' AND game_code = 'lol'`],
    ["매치 히스토리 한 쪽", `SELECT * FROM core_public.versus_set WHERE streamer_id = '${S}' AND game_code = 'lol' ORDER BY series_started_on DESC, series_id, series_game_no LIMIT 200`],
    ["상대 전적 탭", `SELECT b_streamer_id, series_id, a_outcome, b_outcome, a_position, b_position FROM core_public.versus_pair_set WHERE a_streamer_id = '${S}' AND relation = 'opponent'`],
    ["상대전적 상세(두 사람)", `SELECT * FROM core_public.versus_pair_set WHERE a_streamer_id = '${S}' AND b_streamer_id = '${R}'`],
    ["챔피언 탭", `SELECT champion_id, count(*), count(*) FILTER (WHERE outcome = 'win') FROM core_public.versus_set WHERE streamer_id = '${S}' AND game_code = 'lol' GROUP BY 1`],
    ["FC 프로필 요약", `SELECT series_id, outcome, format FROM core_public.versus_set WHERE streamer_id = '${F}' AND game_code = 'fconline'`],
    ["스트리머 목록(전원 세트 수)", `SELECT streamer_id, count(*) FROM core_public.versus_set WHERE game_code = 'lol' GROUP BY 1`],
    ["홈 숫자", `SELECT count(DISTINCT match_id), count(DISTINCT streamer_id) FROM core_public.versus_set WHERE game_code = 'lol'`],
    // 사이드바는 한 사람 기준이다(versus 모듈 topLaneOpponents). 전체 쌍 집계 화면은 없다 — 전체 숫자는 공개 세트에서 판 단위로 센다.
    ["사이드바 자주 만난 매치업", `SELECT b_streamer_id, count(*) FROM core_public.versus_pair_set WHERE relation = 'opponent' AND a_streamer_id = '${S}' AND game_code = 'lol' AND map = 'rift' GROUP BY 1 ORDER BY 2 DESC LIMIT 3`],
    ["행사 날짜 전체", `SELECT * FROM core_public.event_dates`],
    ["경기 상세", `SELECT * FROM core_public.match_detail WHERE match_id = '${anyMatch}'`],
    ["솔랭 도전(개인 기록)", `SELECT * FROM core_public.personal_game WHERE puuid IN ('${DUO.join("','")}')`],
  ];
  if (process.env.SKEL_EXPLAIN_RAW) {  // 진단: {S}·{R}·{F} 를 표본 id 로 바꿔 실행 계획을 본다
    const raw = process.env.SKEL_EXPLAIN_RAW.replaceAll("{S}", S).replaceAll("{R}", R).replaceAll("{F}", F);
    for (const r of await dst.unsafe(`EXPLAIN (ANALYZE, COSTS OFF) ${raw}`)) console.log("   ", r["QUERY PLAN"]);
  }
  if (process.env.SKEL_EXPLAIN) {
    const [, sql] = QUERIES.find(([n]) => n === process.env.SKEL_EXPLAIN)!;
    for (const r of await dst.unsafe(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${sql}`)) console.log("   ", r["QUERY PLAN"]);
  }
  const slow: string[] = [];
  for (const [name, sql] of QUERIES) {
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) { const t = performance.now(); await dst.unsafe(sql); ms.push(performance.now() - t); }
    const med = ms.sort((a, b) => a - b)[2]!;
    if (med > BUDGET_MS) slow.push(name);
    console.log(`  ${med > BUDGET_MS ? "✗" : "✓"} ${name.padEnd(22)} ${med.toFixed(1).padStart(7)}ms`);
  }
  if (slow.length) { failed++; console.log(`  기준 초과: ${slow.join(", ")}`); }

  // ── 실제 화면 함수로 — 위 질의는 흉내다. 화면이 실제로 부르는 core·모듈 함수를 운영 복사본에 그대로 불러 잰다 ──
  // (질의 여러 개 + TS 세기까지 포함한 화면 한 칸의 시간). 연결은 이 일회용 PostgreSQL 이다.
  process.env.DATABASE_URL = local.url;
  const personal = await import("../packages/core/lib/db/personal.ts");
  const opp = await import("../packages/core/lib/db/opponent-history.ts");
  const pub = await import("../packages/core/lib/db/public.ts");
  const ranked = await import("../packages/core/lib/db/public-ranked.ts");
  const fco = await import("../packages/core/lib/db/fconline.ts");
  const versusMod = await import("../packages/modules/versus/server/index.ts");
  const { tally: tallyFn } = await import("../packages/core/lib/metrics/tally.ts");
  const { closeDb } = await import("../packages/core/lib/db/client.ts");
  const fcRival = (await dst.unsafe(`SELECT b_streamer_id::text AS s FROM core_public.versus_pair_set WHERE a_streamer_id = '${F}' AND game_code = 'fconline' AND relation = 'opponent' GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`))[0]?.s;
  const SCREENS: [string, () => Promise<unknown>][] = [
    ["프로필 요약(세트+세기)", async () => tallyFn(await personal.listPersonalSets(S, { map: "rift" }))],
    ["매치 히스토리 첫 쪽", async () => personal.listPersonalMatches(S, await personal.listPersonalSets(S, { map: "rift" }))],
    ["챔피언 탭", () => personal.listChampionRecords(S, 20, { map: "rift" })],
    ["상대 전적 탭", () => opp.listOpponentSummaries(S, { map: "rift" })],
    ["대회 탭", () => pub.listStreamerEvents(S, {})],
    ["상대전적 상세(두 사람)", () => opp.listPairSetsBetween(S, R)],
    ["  └ 쌍 세트(협곡)", () => opp.listPairSets(S, { map: "rift" }, R)],
    ["  └ 쌍 세트(칼바람)", () => opp.listPairSets(S, { map: "aram" }, R)],
    ["  └ 시리즈 형식", async () => opp.listSeriesMeta([...new Set((await opp.listPairSets(S, { map: "rift" }, R)).map((r) => r.series_id))])],
    ["사이드바 자주 만난 매치업", () => versusMod.topLaneOpponents(S, 3)],
    ["스트리머 목록", () => pub.listStreamerCards()],
    ["홈 숫자", () => pub.countPublic()],
    ["솔랭 도전", () => ranked.listPublicRankedGames(DUO, { since: new Date("2026-08-20T15:00:00Z"), queueIds: [420] })],
    ["FC 프로필 요약", () => fco.getFcoPersonalSummary(F)],
    ["FC 매치 히스토리", () => fco.listFcoStreamerGamesForPerson(F)],
    ...(fcRival ? [["FC 상대전적", () => fco.listFcoVersus(F, fcRival)] as [string, () => Promise<unknown>]] : []),
    ["FC 맞대결 순위", () => fco.listFcoTopPairs(8)],
  ];
  console.log(`\n속도 — 실제 화면 함수(5회 중앙값, 기준 ${BUDGET_MS}ms):`);
  const slowScreens: string[] = [];
  for (const [name, fn] of SCREENS) {
    const ms: number[] = [];
    try {
      for (let i = 0; i < 5; i++) { const t = performance.now(); await fn(); ms.push(performance.now() - t); }
    } catch (e) { failed++; console.log(`  ✗ ${name.padEnd(22)} 오류: ${(e as Error).message.slice(0, 120)}`); continue; }
    const med = ms.sort((a, b) => a - b)[2]!;
    if (med > BUDGET_MS) slowScreens.push(name);
    console.log(`  ${med > BUDGET_MS ? "✗" : "✓"} ${name.padEnd(22)} ${med.toFixed(1).padStart(7)}ms`);
  }
  if (slowScreens.length) { failed++; console.log(`  기준 초과: ${slowScreens.join(", ")}`); }
  await closeDb();
} finally {
  await dst.end().catch(() => {});
  await src.end().catch(() => {});
  await local.stop();
}
console.log(failed ? `\n실패 ${failed}건` : "\n전부 통과");
if (failed) process.exitCode = 1;
