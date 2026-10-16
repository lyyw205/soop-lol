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
import { applyAll } from "./lib/migrations.ts";

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

  // ── 이관 전 기준 ───────────────────────────────────────────────────────
  const scalar = async (sql: string) => (await dst.unsafe(sql))[0]!;
  const before = {
    ids: new Set((await dst.unsafe(`SELECT match_id FROM match`)).map((r) => r.match_id as string)),
    deleted: new Set((await dst.unsafe(`SELECT match_id FROM match m WHERE source = 'public_queue' AND match_id NOT IN (
        SELECT p.match_id FROM match_participant p JOIN match mm ON mm.match_id = p.match_id
         WHERE p.puuid IN ('${DUO.join("','")}') AND mm.queue_id = 420 AND mm.game_creation >= '2026-08-21 00:00+09')`)).map((r) => r.match_id as string)),
    parts: await scalar(`SELECT md5(string_agg(row(match_id, participant_id, puuid, streamer_id, observed_name, team_id, side_no, team_position,
        individual_position, champion_id, champion_name, champ_level, kills, deaths, assists, outcome)::text, '|' ORDER BY match_id, participant_id)) AS h
        FROM match_participant WHERE match_id IN (SELECT match_id FROM match WHERE source <> 'public_queue') OR match_id IN (${pqKeepRange})`),
    state: await scalar(`SELECT md5(string_agg(row(match_id, set_role, set_label, visibility, review_completed_at, review_version, reviewed_at,
        context_review_completed_at, context_review_version)::text, '|' ORDER BY match_id)) AS h FROM match WHERE source <> 'public_queue'`),
    series: await scalar(`SELECT md5(string_agg(match_id || '=' || series_id || '#' || series_game_no, '|' ORDER BY match_id)) AS h FROM match WHERE series_id IS NOT NULL`),
    changes: await scalar(`SELECT count(*)::int AS n, md5(string_agg(row(id, match_id, entity, entity_key, field, before, after, actor)::text, '|' ORDER BY id)) AS h FROM review_change`),
    excludes: await dst.unsafe(`SELECT event_id::text, match_id FROM (SELECT DISTINCT ON (event_id, match_id) * FROM fco_event_match_decision
        ORDER BY event_id, match_id, created_at DESC, (created_by = 'admin') DESC) d WHERE decision = 'exclude' ORDER BY 1, 2`),
    kinds: await dst.unsafe(`SELECT game_code, kind, count(*)::int AS n FROM event GROUP BY 1, 2 ORDER BY 1, 2`),
  };
  log(`기준: 경기 ${before.ids.size} · 삭제 예정 ${before.deleted.size} · 옛 행사 종류 ${JSON.stringify(before.kinds)}`);

  // ── 초안 적용 ─────────────────────────────────────────────────────────
  const tDraft = Date.now();
  await dst.unsafe(`BEGIN;\n${DRAFT}\nCOMMIT;`);
  log(`초안 적용 ${((Date.now() - tDraft) / 1000).toFixed(1)}초`);
  await dst.unsafe("ANALYZE");

  console.log("\n대조:");
  await check("남은 경기 ID = 전 − 삭제 목록", async () => {
    const ids = new Set((await dst.unsafe(`SELECT match_id FROM match`)).map((r) => r.match_id as string));
    const expected = [...before.ids].filter((i) => !before.deleted.has(i));
    assert.equal(ids.size, expected.length);
    for (const i of expected) assert.ok(ids.has(i), `없어졌다: ${i}`);
  });
  await check("참가자 기본 칸 값 그대로", async () => {
    const h = await scalar(`SELECT md5(string_agg(row(match_id, participant_id, puuid, streamer_id, observed_name, team_id, side_no, team_position,
        individual_position, champion_id, champion_name, champ_level, kills, deaths, assists, outcome)::text, '|' ORDER BY match_id, participant_id)) AS h FROM match_participant`);
    assert.equal(h.h, before.parts.h);
  });
  await check("보너스·숨김·검수 완료·버전·잠금·FC 맥락 확인 그대로", async () => {
    const h = await scalar(`SELECT md5(string_agg(row(match_id, set_role, set_label, visibility, review_completed_at, review_version, reviewed_at,
        context_review_completed_at, context_review_version)::text, '|' ORDER BY match_id)) AS h FROM match WHERE scope = 'versus' OR game_code = 'fconline'`);
    assert.equal(h.h, before.state.h);
  });
  await check("기존 시리즈 키·세트 번호 그대로", async () => {
    const h = await scalar(`SELECT md5(string_agg(match_id || '=' || series_id || '#' || series_game_no, '|' ORDER BY match_id)) AS h FROM match
        WHERE series_id IS NOT NULL AND series_id NOT LIKE 'set:%'`);
    assert.equal(h.h, before.series.h);
  });
  await check("옛 review_change 한 줄도 그대로", async () => {
    const h = await scalar(`SELECT count(*)::int AS n, md5(string_agg(row(id, match_id, entity, entity_key, field, before, after, actor)::text, '|' ORDER BY id)) AS h
        FROM review_change WHERE entity <> 'classification'`);
    assert.deepEqual(h, before.changes);
  });
  await check("제외 표 = 옛 결정 표의 최신 exclude", async () => {
    assert.deepEqual(await dst.unsafe(`SELECT event_id::text, match_id FROM event_exclusion ORDER BY 1, 2`), before.excludes);
  });

  console.log("\n옮겨 담은 결과(§6 표와 대조):");
  for (const r of await dst.unsafe(`SELECT m.game_code, m.scope, m.collected_via, coalesce(e.format, '-') AS format, coalesce(e.auto_bucket, false) AS bucket,
      (m.series_id LIKE 'set:%') AS new_set, m.visibility, count(*)::int AS n
      FROM match m LEFT JOIN match_series ms ON ms.id = m.series_id LEFT JOIN event e ON e.id = ms.event_id
     GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 1, 2, 3, 4, 5, 6, 7`)) console.log(`  ${JSON.stringify(r)}`);
  for (const r of await dst.unsafe(`SELECT game_code, format, auto_bucket, count(*)::int AS events FROM event GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)) console.log(`  행사 ${JSON.stringify(r)}`);

  // ── 공개 뷰: 대칭·칩 합 ──────────────────────────────────────────────────
  console.log("\n공개 뷰:");
  const vs = await dst.unsafe(`SELECT game_code, streamer_id::text, series_id, outcome, format, map FROM core_public.versus_set`) as unknown as
    { game_code: string; streamer_id: string; series_id: string; outcome: Outcome; format: string; map: string | null }[];
  console.log(`  versus_set ${vs.length}행 (롤 ${vs.filter((r) => r.game_code === "lol").length} · FC ${vs.filter((r) => r.game_code === "fconline").length})`);
  await check("FC 판이 공개 세트에 있다", () => assert.ok(vs.some((r) => r.game_code === "fconline")));
  await check("모든 사람·맵 탭에서 전체 = 진행 방식 칩 합(세트·시리즈)", () => {
    const groups = new Map<string, typeof vs>();
    for (const r of vs) { const k = `${r.game_code}|${r.streamer_id}|${r.map}`; const g = groups.get(k); if (g) g.push(r); else groups.set(k, [r]); }
    for (const [k, rows] of groups) {
      const game = rows[0]!.game_code as keyof typeof FORMATS_BY_GAME;
      const all = tally(rows);
      const sum = { sets: { win: 0, draw: 0, loss: 0, unknown: 0 }, series: { win: 0, draw: 0, loss: 0, unknown: 0 } };
      for (const f of FORMATS_BY_GAME[game]) {
        const t = tally(rows.filter((r) => r.format === f));
        for (const p of ["sets", "series"] as const) for (const o of ["win", "draw", "loss", "unknown"] as const) sum[p][o] += t[p][o];
      }
      assert.deepEqual(sum, all, k);
    }
  });
  const pairs = await dst.unsafe(`SELECT a_streamer_id::text AS a, b_streamer_id::text AS b, series_id, a_outcome, b_outcome FROM core_public.versus_pair_set WHERE relation = 'opponent'`) as unknown as
    { a: string; b: string; series_id: string; a_outcome: Outcome; b_outcome: Outcome }[];
  await check(`상대전적 대칭(상대편 짝 ${pairs.length}행)`, () => {
    const by = new Map<string, { series_id: string; outcome: Outcome }[]>();
    for (const p of pairs) { const k = `${p.a}|${p.b}`; const v = { series_id: p.series_id, outcome: pairSetOutcome(p.a_outcome, p.b_outcome) }; const g = by.get(k); if (g) g.push(v); else by.set(k, [v]); }
    for (const [k, rows] of by) {
      const [a, b] = k.split("|");
      const ab = tally(rows), ba = tally(by.get(`${b}|${a}`) ?? []);
      assert.deepEqual(ab.sets, mirror(ba.sets), k); assert.deepEqual(ab.series, mirror(ba.series), k);
    }
  });
  const contradictions = pairs.filter((p) => pairSetOutcome(p.a_outcome, p.b_outcome) === "unknown" && p.a_outcome !== "unknown" && p.b_outcome !== "unknown");
  console.log(`  상대편 결과 모순(정합성 목록 후보): ${contradictions.length / 2}쌍`);

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
    ["사이드바 자주 만난 매치업", `SELECT a_streamer_id, b_streamer_id, count(*) FROM core_public.versus_pair_set WHERE relation = 'opponent' AND a_streamer_id < b_streamer_id AND game_code = 'lol' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 4`],
    ["행사 날짜 전체", `SELECT * FROM core_public.event_dates`],
    ["경기 상세", `SELECT * FROM core_public.match_detail WHERE match_id = '${anyMatch}'`],
    ["솔랭 도전(개인 기록)", `SELECT * FROM core_public.personal_game WHERE puuid IN ('${DUO.join("','")}')`],
  ];
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
} finally {
  await dst.end().catch(() => {});
  await src.end().catch(() => {});
  await local.stop();
}
console.log(failed ? `\n실패 ${failed}건` : "\n전부 통과");
if (failed) process.exitCode = 1;
