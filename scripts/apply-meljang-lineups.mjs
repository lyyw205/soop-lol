/**
 * **손으로 판독한 경기 라인업을 멸망전 시드에 넣는다.**
 *
 *   node scripts/apply-meljang-lineups.mjs            # 확인만
 *   node scripts/apply-meljang-lineups.mjs --apply    # 쓴다
 *
 * ── 왜 시드를 직접 고치지 않나 ────────────────────────────────────────
 * `seed:meljang` 은 나무위키에서 시드를 **통째로 다시 만든다.** 시드 JSON 에
 * 손으로 라인업을 적어 두면 다음 재생성 때 조용히 사라진다. 판독은 사람이
 * 프레임을 한 장씩 확대해서 읽은 결과라 다시 만들 수 없다 — 그래서 판독 결과는
 * `seed/lineups/<event>.json` 에 따로 두고, 이 스크립트가 매번 다시 붙인다.
 *
 * ── 왜 부분 시드 파일로 못 하나 ───────────────────────────────────────
 * `seed:tournament` 는 `saveEventTeams` 에서 **명단에 없는 팀을 지운다**
 * (packages/core/lib/db/tournaments.ts). 경기 하나만 담은 시드를 따로 올리면
 * 그 대회의 나머지 팀이 통째로 날아간다. 그래서 원본 시드에 병합해야 한다.
 *
 * ── 하는 일 ──────────────────────────────────────────────────────────
 * 1. `add_to_teams` — 판독으로 확인된 사람을 팀 명단에 **더한다.**
 *    이미 있는 사람은 건드리지 않고, 아무도 빼지 않는다.
 *    (로스터에 없는 slug 는 `seed:tournament` 가 조용히 버린다 — 그래서 필요하다)
 * 2. `roster_positions` — 더한 사람의 포지션.
 * 3. `games[<id>]` — 그 경기의 `lineup`·`duration`·`result_evidence` 를 넣는다.
 *    **이미 lineup 이 있으면 덮지 않는다.** 덮어써야 하면 시드에서 지우고 다시 돌려라.
 *
 * 멱등이다. 몇 번 돌려도 같다.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const APPLY = process.argv.includes("--apply");
const DIR = "seed/lineups";

if (!existsSync(DIR)) {
  console.log(`${DIR} 이 없다 — 판독한 라인업이 아직 없다는 뜻이다. 할 일 없음.`);
  process.exit(0);
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) { console.log(`${DIR} 이 비었다. 할 일 없음.`); process.exit(0); }

console.log(`${APPLY ? "쓴다" : "확인만 한다 (--apply 를 주면 쓴다)"}\n`);

let totGames = 0, totAdded = 0, totSkipped = 0;

for (const file of files) {
  const spec = JSON.parse(readFileSync(`${DIR}/${file}`, "utf8"));
  const slug = spec.event_slug;
  const path = `seed/tournaments-${slug}.json`;
  if (!existsSync(path)) {
    console.error(`✖ ${file} → ${path} 이 없다. seed:meljang 을 먼저 돌려라.`);
    process.exitCode = 1;
    continue;
  }

  const doc = JSON.parse(readFileSync(path, "utf8"));
  const ev = doc[0];
  ev.teams ??= {};
  ev.roster_positions ??= {};

  // ── 1. 팀 명단에 더한다 ────────────────────────────────────────────
  const added = [];
  for (const [team, slugs] of Object.entries(spec.add_to_teams ?? {})) {
    if (team.startsWith("//")) continue;
    if (!ev.teams[team]) { console.error(`   ✖ '${team}' 팀이 시드에 없다 — 건너뛴다`); continue; }
    for (const s of slugs) {
      if (ev.teams[team].includes(s)) continue;
      // 한 대회에서 한 사람은 한 팀이다 (event_team_member PK). 다른 팀에 있으면 넣지 않는다.
      const other = Object.entries(ev.teams).find(([t, l]) => t !== team && (l ?? []).includes(s));
      if (other) { console.error(`   ✖ ${s} 는 이미 '${other[0]}' 에 있다 — '${team}' 에 넣지 않는다`); continue; }
      ev.teams[team].push(s);
      added.push(`${team}+${s}`);
    }
  }
  for (const [s, pos] of Object.entries(spec.roster_positions ?? {})) {
    if (ev.roster_positions[s] === pos) continue;
    ev.roster_positions[s] = pos;
  }

  // ── 2. 경기별 라인업 ───────────────────────────────────────────────
  const byId = new Map((ev.games ?? []).map((g) => [g.id, g]));
  const put = [], skip = [], miss = [];
  for (const [gid, patch] of Object.entries(spec.games ?? {})) {
    const g = byId.get(gid);
    if (!g) { miss.push(gid); continue; }
    if (g.lineup) { skip.push(gid); continue; }   // 이미 있으면 덮지 않는다
    if (patch.lineup) g.lineup = patch.lineup;
    if (patch.duration != null) g.duration = patch.duration;
    // 날짜 정정도 여기서 한다 — 나무위키는 **일정표 날짜**를 쓰므로 재경기·연기된 판이 어긋난다.
    if (patch.played_at) g.played_at = patch.played_at;
    if (patch.result_evidence) g.result_evidence = patch.result_evidence;
    if (patch.source_url) g.source_url = patch.source_url;
    put.push(gid);
  }

  console.log(`▸ ${slug}`);
  console.log(`   팀 명단 추가 ${added.length}${added.length ? ` (${added.join(", ")})` : ""}`);
  console.log(`   라인업 넣음 ${put.length}${put.length ? ` — ${put.join(" ")}` : ""}`);
  if (skip.length > 0) console.log(`   이미 있어 건너뜀 ${skip.length} — ${skip.join(" ")}`);
  if (miss.length > 0) console.log(`   ✖ 시드에 없는 경기 ${miss.length} — ${miss.join(" ")}`);
  totGames += put.length; totAdded += added.length; totSkipped += skip.length;

  if (APPLY && (put.length > 0 || added.length > 0)) {
    ev["//판독라인업"] =
      `seed/lineups/${file} 에서 ${put.length}경기의 라인업을 병합했다(사람이 프레임을 판독한 결과). ` +
      `재현: node scripts/apply-meljang-lineups.mjs --apply`;
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  }
}

console.log(`\n합계 — 라인업 ${totGames}경기 · 팀 명단 추가 ${totAdded} · 건너뜀 ${totSkipped}`);
if (!APPLY) console.log(`아무것도 쓰지 않았다. 반영하려면 --apply.`);
else console.log(`다음: npm run seed:tournament -- seed/tournaments-<회차>.json`);
