/**
 * 0089 전환의 대조 — **리허설(운영 복사본)과 실제 전환(scripts/cutover-0089.ts)이 같은 코드로** 잰다.
 * 계획 docs/CLASSIFICATION-REDESIGN-PLAN.md §8 "대조": 건수가 아니라 ID·값 집합으로 본다.
 *
 *   captureBefore(sql)  — 0089 를 적용하기 전(같은 트랜잭션 안에서) 기준을 잰다
 *   checkAfter(sql, b)  — 적용한 뒤 기준과 대조한다. 실패 목록이 비어야 통과
 *
 * ★ 지워질 판의 기준은 0089 의 규칙을 그대로 옮긴 것이다(지명 계정 · 큐 420 · 2026-08-21 KST 이후 밖의 공개 큐 판).
 *   두 곳이 다르면 이 대조가 실패한다 — 그게 이 검사가 잡으려는 것이다.
 */
import type postgres from "postgres";

import { FORMATS_BY_GAME } from "../../packages/core/lib/metrics/format.ts";
import { mirror, pairSetOutcome, tally, type Outcome } from "../../packages/core/lib/metrics/tally.ts";

type Sql = postgres.Sql | postgres.TransactionSql;

/** 첫 지명(솔랭 도전 — 뜨교듀오). 0089 의 collection_target 씨앗과 같다. */
export const DESIGNATED = {
  puuids: ["jAu-Fy-yQ96GJFQtR4mbyYIiumZdM8v3dmyaPu4dQuAslWnjeiGfKLJmu2-yQe79gBdWbKDpZmTivA",
    "hmeMsJn7_kn3-w6SLpjVBC59hkbzfdiTi6hOWv2aSpbIgYBJCnf8hUigsdf7seukt7x0eV610pO9fw"],
  queue: 420,
  since: "2026-08-21 00:00+09",
};
const PUUIDS = () => `'${DESIGNATED.puuids.join("','")}'`;

const PART_COLS = `match_id, participant_id, puuid, streamer_id, observed_name, team_id, side_no, team_position,
  individual_position, champion_id, champion_name, champ_level, kills, deaths, assists, outcome`;
const STATE_COLS = `match_id, set_role, set_label, visibility, review_completed_at, review_version, reviewed_at,
  context_review_completed_at, context_review_version`;

export interface Before {
  matches: number;
  deleted: string[];
  keptDigest: string;
  partsDigest: string;
  stateDigest: string;
  seriesDigest: string;
  changes: { n: number; h: string | null };
  excludes: { event_id: string; match_id: string }[];
}

const one = async (sql: Sql, text: string) => (await sql.unsafe(text))[0]!;

export async function captureBefore(sql: Sql): Promise<Before> {
  const keep = `SELECT DISTINCT p.match_id FROM match_participant p JOIN match m ON m.match_id = p.match_id
                 WHERE m.source = 'public_queue' AND p.puuid IN (${PUUIDS()}) AND m.queue_id = ${DESIGNATED.queue}
                   AND m.game_creation >= '${DESIGNATED.since}'`;
  const deleted = (await sql.unsafe(`SELECT match_id FROM match WHERE source = 'public_queue' AND match_id NOT IN (${keep}) ORDER BY 1`))
    .map((r) => r.match_id as string);
  const kept = `(SELECT match_id FROM match WHERE source <> 'public_queue' UNION ${keep})`;
  return {
    matches: (await one(sql, `SELECT count(*)::int AS n FROM match`)).n,
    deleted,
    keptDigest: (await one(sql, `SELECT md5(string_agg(match_id, ',' ORDER BY match_id)) AS h FROM match WHERE match_id IN ${kept}`)).h,
    partsDigest: (await one(sql, `SELECT md5(string_agg(row(${PART_COLS})::text, '|' ORDER BY match_id, participant_id)) AS h
                                    FROM match_participant WHERE match_id IN ${kept}`)).h,
    stateDigest: (await one(sql, `SELECT md5(string_agg(row(${STATE_COLS})::text, '|' ORDER BY match_id)) AS h FROM match WHERE match_id IN ${kept}`)).h,
    seriesDigest: (await one(sql, `SELECT md5(string_agg(match_id || '=' || series_id || '#' || series_game_no, '|' ORDER BY match_id)) AS h
                                     FROM match WHERE series_id IS NOT NULL`)).h,
    changes: (await one(sql, `SELECT count(*)::int AS n, md5(string_agg(row(id, match_id, entity, entity_key, field, before, after, actor)::text, '|' ORDER BY id)) AS h
                              FROM review_change`)) as unknown as Before["changes"],
    excludes: (await sql.unsafe(`SELECT event_id::text AS event_id, match_id FROM (SELECT DISTINCT ON (event_id, match_id) * FROM fco_event_match_decision
        ORDER BY event_id, match_id, created_at DESC, (created_by = 'admin') DESC) d WHERE decision = 'exclude' ORDER BY 1, 2`)) as unknown as Before["excludes"],
  };
}

export interface AfterReport { failures: string[]; info: string[] }

export async function checkAfter(sql: Sql, b: Before): Promise<AfterReport> {
  const failures: string[] = [];
  const info: string[] = [];
  const expect = (name: string, ok: boolean, detail = "") => { if (!ok) failures.push(detail ? `${name} — ${detail}` : name); };

  const n = (await one(sql, `SELECT count(*)::int AS n FROM match`)).n;
  expect("경기 수 = 전 − 삭제 목록", n === b.matches - b.deleted.length, `${n} ≠ ${b.matches} − ${b.deleted.length}`);
  expect("남은 경기 ID 집합", (await one(sql, `SELECT md5(string_agg(match_id, ',' ORDER BY match_id)) AS h FROM match`)).h === b.keptDigest);
  expect("참가자 기본 칸 값", (await one(sql, `SELECT md5(string_agg(row(${PART_COLS})::text, '|' ORDER BY match_id, participant_id)) AS h FROM match_participant`)).h === b.partsDigest);
  expect("보너스·숨김·검수 완료·버전·잠금·FC 맥락 확인", (await one(sql, `SELECT md5(string_agg(row(${STATE_COLS})::text, '|' ORDER BY match_id)) AS h FROM match`)).h === b.stateDigest);
  expect("기존 시리즈 키·세트 번호", (await one(sql, `SELECT md5(string_agg(match_id || '=' || series_id || '#' || series_game_no, '|' ORDER BY match_id)) AS h
      FROM match WHERE series_id IS NOT NULL AND series_id NOT LIKE 'set:%'`)).h === b.seriesDigest);
  const ch = await one(sql, `SELECT count(*)::int AS n, md5(string_agg(row(id, match_id, entity, entity_key, field, before, after, actor)::text, '|' ORDER BY id)) AS h
      FROM review_change WHERE entity <> 'classification'`);
  expect("옛 review_change 한 줄도 그대로", ch.n === b.changes.n && ch.h === b.changes.h);
  const ex = await sql.unsafe(`SELECT event_id::text AS event_id, match_id FROM event_exclusion ORDER BY 1, 2`);
  expect("제외 표 = 옛 결정 표의 최신 exclude", JSON.stringify(ex) === JSON.stringify(b.excludes));
  expect("시리즈 밖 내전 판 없음", (await one(sql, `SELECT count(*)::int AS n FROM match WHERE scope = 'versus' AND series_id IS NULL`)).n === 0);
  expect("행사 없는 시리즈 없음", (await one(sql, `SELECT count(*)::int AS n FROM match_series WHERE event_id IS NULL`)).n === 0);
  expect("빈 시리즈 없음", (await one(sql, `SELECT count(*)::int AS n FROM match_series ms WHERE NOT EXISTS (SELECT 1 FROM match m WHERE m.series_id = ms.id)`)).n === 0);
  expect("공개 큐 상세는 지명 계정 행만", (await one(sql, `SELECT count(*)::int AS n FROM lol_participant_detail d JOIN match_participant p USING (match_id, participant_id)
      WHERE p.puuid NOT IN (${PUUIDS()})`)).n === 0);

  // 공개 뷰 — 칩 합·대칭. 행이 많지 않다(공개 세트 수만 행).
  const vs = await sql.unsafe(`SELECT game_code, streamer_id::text AS s, series_id, outcome, format, map FROM core_public.versus_set`) as unknown as
    { game_code: "lol" | "fconline"; s: string; series_id: string; outcome: Outcome; format: string; map: string | null }[];
  expect("FC 판이 공개 세트에 있다(맵 NULL 함정)", vs.some((r) => r.game_code === "fconline") || !(await one(sql, `SELECT count(*)::int AS n FROM match WHERE game_code = 'fconline' AND scope = 'versus' AND visibility = 'public'`)).n);
  const groups = new Map<string, typeof vs>();
  for (const r of vs) { const k = `${r.game_code}|${r.s}|${r.map}`; (groups.get(k) ?? groups.set(k, []).get(k)!).push(r); }
  let chipBad = 0;
  for (const rows of groups.values()) {
    const all = tally(rows);
    const sum = { win: 0, draw: 0, loss: 0, unknown: 0 }, sets = { ...sum };
    for (const f of FORMATS_BY_GAME[rows[0]!.game_code]) {
      const t = tally(rows.filter((r) => r.format === f));
      for (const o of ["win", "draw", "loss", "unknown"] as const) { sum[o] += t.series[o]; sets[o] += t.sets[o]; }
    }
    if (JSON.stringify(sum) !== JSON.stringify(all.series) || JSON.stringify(sets) !== JSON.stringify(all.sets)) chipBad++;
  }
  expect("모든 사람·맵 탭에서 전체 = 진행 방식 칩 합", chipBad === 0, `${chipBad}개 어긋남`);
  const pairs = await sql.unsafe(`SELECT a_streamer_id::text AS a, b_streamer_id::text AS b, series_id, a_outcome, b_outcome
      FROM core_public.versus_pair_set WHERE relation = 'opponent'`) as unknown as { a: string; b: string; series_id: string; a_outcome: Outcome; b_outcome: Outcome }[];
  const by = new Map<string, { series_id: string; outcome: Outcome }[]>();
  for (const p of pairs) { const k = `${p.a}|${p.b}`; (by.get(k) ?? by.set(k, []).get(k)!).push({ series_id: p.series_id, outcome: pairSetOutcome(p.a_outcome, p.b_outcome) }); }
  let asym = 0;
  for (const [k, rows] of by) {
    const [a, bb] = k.split("|");
    const ab = tally(rows), ba = tally(by.get(`${bb}|${a}`) ?? []);
    if (JSON.stringify(ab.sets) !== JSON.stringify(mirror(ba.sets)) || JSON.stringify(ab.series) !== JSON.stringify(mirror(ba.series))) asym++;
  }
  expect("상대전적 대칭", asym === 0, `${asym}쌍 어긋남`);

  info.push(`경기 ${b.matches} → ${n} (삭제 ${b.deleted.length}) · 공개 세트 ${vs.length} · 상대편 짝 ${pairs.length}`);
  for (const r of await sql.unsafe(`SELECT game_code, format, auto_bucket, count(*)::int AS events FROM event GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`)) {
    info.push(`행사 ${r.game_code} ${r.format}${r.auto_bucket ? "(자동 묶음)" : ""} ${r.events}`);
  }
  return { failures, info };
}
