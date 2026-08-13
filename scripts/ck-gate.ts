/**
 * **조사 관문.** 다음 단계로 갈 자격이 되는지 검사하고, 안 되면 1 로 끝난다.
 *
 *   npm run ck:gate -- --event <대회 slug>          # 그 대회가 적재해도 되는 상태인가
 *   npm run ck:gate -- --range 2026-07-01:2026-07-31 --channel lshooooo
 *   npm run ck:gate -- --event <slug> --report out/report/leesangho-2026-07.md
 *
 * ★ 왜 만들었나 — 지침으로는 안 됐다
 *   `.claude/skills/ck-research` 에 "교차검증 최소 3 POV" 를 적어 뒀지만,
 *   그 전에도 같은 규칙이 있었고 **세 번 연속 건너뛰었다**(강만식·서도일·교CK).
 *   사람이 기억하는 규칙은 지켜지지 않는다. 검사로 바꾼다.
 *
 * ★ 무엇을 막나 (하나라도 걸리면 exit 1)
 *   1. 결과 근거가 없는 경기            — result_evidence 가 비었다
 *   2. 교차검증 시점이 3개 미만인 날     — 그 날 그 경기를 방송한 채널 수
 *   3. 로스터에 못 붙인 사람이 있는데    — 근거에 이름조차 안 남겼다
 *   4. 카테고리가 미정인 채로 적재       — kind 가 unknown 인 event
 *
 * ★ 무엇을 막지 않나
 *   "결과창을 못 구한 판" 자체는 막지 않는다. 그건 현실이고, **못 구했다고
 *   적혀 있으면 통과**시킨다. 막는 건 *조용히 비어 있는 것* 이다.
 *
 * `--report` 를 주면 10단계 이슈 문서를 같이 쓴다.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { closeDb, db } from "@soop-lol/core/lib/db/client";

import { makeOpt } from "./lib/cli.mjs";

const argv = process.argv.slice(2);
const opt = makeOpt(argv);
const EVENT = opt("--event", "");
const RANGE = opt("--range", "");
const CHANNEL = opt("--channel", "");
const REPORT = opt("--report", "");
/** 판마다 있어야 할 최소 시점 수. 과반수 판정을 하려면 3이 하한이다. */
const MIN_POV = Number(opt("--min-pov", 3));

if (!EVENT && !RANGE) {
  console.error("대회나 기간을 달라:  npm run ck:gate -- --event <slug>  |  --range <시작>:<끝>");
  process.exit(1);
}

const sql = db();
const problems: string[] = [];
const lines: string[] = [];
function say(s = "") { console.log(s); lines.push(s); }

try {
  // ── 1. 근거 없는 경기 ────────────────────────────────────────────
  const noEvidence = EVENT
    ? await sql<{ match_id: string }[]>`
        SELECT m.match_id FROM match m JOIN event e ON e.id = m.event_id
         WHERE e.slug = ${EVENT} AND m.source = 'manual'
           AND (m.result_evidence IS NULL OR btrim(m.result_evidence) = '')`
    : [];
  if (noEvidence.length > 0) {
    problems.push(`결과 근거가 빈 경기 ${noEvidence.length}건`);
    say(`✖ 결과 근거(result_evidence)가 빈 경기 ${noEvidence.length}건`);
    for (const r of noEvidence.slice(0, 10)) say(`    ${r.match_id}`);
    say(`  무엇을 보고 정했는지 적어라. 못 구했으면 "못 구했다" 고 적는 것도 근거다.`);
    say();
  }

  // ── 2. 교차검증 시점 수 ──────────────────────────────────────────
  //   같은 날 같은 경기를 방송한 채널이 몇 개나 수집됐는지로 본다.
  //   (경기 단위로 정확히 세려면 프레임 판독이 필요해서, 날짜 단위 근사로 막는다)
  if (EVENT) {
    const pov = await sql<{ d: string; n: number; chans: string[] }[]>`
      WITH days AS (
        SELECT DISTINCT (m.game_creation AT TIME ZONE 'Asia/Seoul')::date AS d
          FROM match m JOIN event e ON e.id = m.event_id WHERE e.slug = ${EVENT}
      )
      SELECT d::text AS d, count(DISTINCT l.channel_id)::int AS n,
             array_agg(DISTINCT l.channel_id) AS chans
        FROM days
        LEFT JOIN event_lead l
               ON l.source = 'vod_title'
              AND l.state <> 'rejected'
              AND (l.observed_at AT TIME ZONE 'Asia/Seoul')::date BETWEEN days.d - 1 AND days.d + 1
       GROUP BY d ORDER BY d`;
    for (const p of pov) {
      if (p.n < MIN_POV) {
        problems.push(`${p.d} 시점 ${p.n}개 (최소 ${MIN_POV})`);
        say(`✖ ${p.d} — 수집된 시점 ${p.n}개, 최소 ${MIN_POV} 필요`);
        say(`    지금: ${(p.chans ?? []).filter(Boolean).join(", ") || "(없음)"}`);
        say(`    npm run ck:cross -- --event ${EVENT}`);
      } else {
        say(`  ${p.d} — 시점 ${p.n}개 ✓`);
      }
    }
    say();
  }

  // ── 3. 카테고리 미정 ─────────────────────────────────────────────
  if (EVENT) {
    const [ev] = await sql<{ kind: string; name: string }[]>`
      SELECT kind, name FROM event WHERE slug = ${EVENT}`;
    if (!ev) { console.error(`대회 '${EVENT}' 가 없다.`); process.exit(1); }
    if (!ev.kind || ev.kind === "unknown" || ev.kind === "other") {
      problems.push(`카테고리 미정 (kind=${ev.kind})`);
      say(`✖ 매치 카테고리가 정해지지 않았다 (kind=${ev.kind})`);
      say(`  CK·대회·랜드·스크림 중 무엇인지 정하고 넣어라. 애매하면 적재를 미뤄라 —`);
      say(`  잘못 확정한 카테고리에 끼워 맞추면 세트 수와 승패가 통째로 틀어진다.`);
      say();
    } else {
      say(`  카테고리 ${ev.kind} ✓`);
      say();
    }
  }

  // ── 4. 못 붙인 사람이 근거에 남아 있는가 ─────────────────────────
  //   로스터가 10명이 아닌 경기는 누군가를 뺐다는 뜻이다.
  //   그 사실이 근거에 적혀 있지 않으면 조용히 사라진 것이다.
  if (EVENT) {
    const short = await sql<{ match_id: string; n: number; ev: string | null }[]>`
      SELECT m.match_id, count(mp.*)::int AS n, m.result_evidence AS ev
        FROM match m JOIN event e ON e.id = m.event_id
        LEFT JOIN match_participant mp ON mp.match_id = m.match_id
       WHERE e.slug = ${EVENT}
       GROUP BY m.match_id, m.result_evidence
      HAVING count(mp.*) < 10`;
    for (const s of short) {
      const noted = s.ev && /미등록|못 붙|뺐다|없어/.test(s.ev);
      if (!noted) {
        problems.push(`${s.match_id} 참가자 ${s.n}명인데 사유 없음`);
        say(`✖ ${s.match_id} — 참가자 ${s.n}명(10명 미만)인데 근거에 사유가 없다`);
        say(`    누구를 왜 뺐는지 result_evidence 에 적어라.`);
      } else {
        say(`  ${s.match_id} — 참가자 ${s.n}명, 사유 적힘 ✓`);
      }
    }
    say();
  }

  // ── 10단계 이슈 문서 ─────────────────────────────────────────────
  if (REPORT) {
    const leads = RANGE || CHANNEL
      ? await sql<{ state: string; n: number }[]>`
          SELECT state, count(*)::int AS n FROM event_lead
           WHERE source = 'vod_title'
             ${CHANNEL ? sql`AND channel_id = ${CHANNEL}` : sql``}
             ${RANGE ? sql`AND (observed_at AT TIME ZONE 'Asia/Seoul')::date
                          BETWEEN ${RANGE.split(":")[0]}::date AND ${RANGE.split(":")[1]}::date` : sql``}
           GROUP BY state ORDER BY state`
      : [];
    const body = [
      `# 조사 리포트${EVENT ? ` — ${EVENT}` : ""}${RANGE ? ` — ${RANGE}` : ""}`,
      ``,
      `> 이 문서는 \`npm run ck:gate\` 가 DB 에서 계산해 쓴다. 손으로 고치지 말고 다시 돌려라.`,
      ``,
      `## 단서 상태`,
      ...(leads.length ? leads.map((l) => `- ${l.state} ${l.n}건`) : ["- (범위 미지정)"]),
      ``,
      `## 관문 결과`,
      problems.length === 0 ? `통과 — 막을 것 없음` : problems.map((p) => `- ✖ ${p}`).join("\n"),
      ``,
      `## 자세히`,
      "```",
      ...lines,
      "```",
      ``,
      `## 다음에 할 일`,
      `- 위 ✖ 를 지운다. 특히 시점 부족은 \`ck:cross\` 로 채운다`,
      `- 못 붙인 인게임명은 채널을 등록하면 재파생으로 조우가 살아난다`,
    ].join("\n");
    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, body + "\n");
    console.log(`이슈 문서: ${REPORT}`);
  }

  if (problems.length > 0) {
    console.error(`\n관문 ${problems.length}건 걸림 — 다음 단계로 못 간다.`);
    process.exit(1);
  }
  console.log(`관문 통과.`);
} finally {
  await closeDb();
}
