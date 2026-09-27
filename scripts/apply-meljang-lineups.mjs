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
 * 3. `games[<id>]` — 그 경기의 `lineup`·`duration`·`result_evidence`·`winner`·`blue`/`red` 를 넣는다.
 *    ★ **이 파일이 정본이다.** 시드의 lineup 은 이 스크립트만 쓰므로 매번 이 파일 값으로 맞춘다.
 *      예전엔 "이미 있으면 건너뛴다" 였는데, 그러면 라인업이 있는 세트는 승자·진영 정정까지
 *      통째로 빠졌다(2026 with Gen.G g03 — 진영이 나무위키 세트 기록과 반대로 남았다).
 * 4. `set_order_known` — 세트 순서를 출처에서 확인한 회차면 true (0035). 시드 생성기는 순서를 지어낸다.
 * 5. 주최측 발표 사실(0039) — `team_placements`·`team_prizes`·`team_vote_ranks`·`captains`·
 *    `member_ratings`·`member_awards`·`series_formats`·`links`·`facts`. 생성기가 못 만드는 값이라
 *    이 파일이 정본이다.
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
  const originalGames = JSON.parse(JSON.stringify(ev.games ?? []));
  const byId = new Map((ev.games ?? []).map((g) => [g.id, g]));
  const put = [], skip = [], miss = [];
  for (const [gid, patch] of Object.entries(spec.games ?? {})) {
    const g = byId.get(gid);
    if (!g) { miss.push(gid); continue; }
    const before = JSON.stringify(g);
    if (patch.lineup) g.lineup = patch.lineup;
    // 진영 정정 — 같은 두 팀이어야 한다. 다른 팀을 넣으면 대진이 바뀌는 것이라 받지 않는다.
    if (patch.blue || patch.red) {
      const pair = [g.blue, g.red].sort().join("|");
      if ([patch.blue ?? g.blue, patch.red ?? g.red].sort().join("|") !== pair) {
        console.error(`   ✖ ${gid}: 진영 정정이 대진(${g.blue} vs ${g.red})과 다른 팀이다 — 건너뛴다`);
        process.exitCode = 1; continue;
      }
      g.blue = patch.blue ?? g.blue; g.red = patch.red ?? g.red;
    }
    if (patch.duration != null) g.duration = patch.duration;
    // ★ 승자도 여기서 고친다. `seed:meljang` 은 **시리즈 스코어를 세트로 펴서** 넣는다
    //   ('//승패근거' 참조) — 그래서 이긴 판이 먼저, 진 판이 뒤로 몰린 **가짜 순서**다.
    //   대전 기록·결과창으로 실제 순서를 알아내면 세트별 승자가 달라진다.
    //   ⚠ 시리즈 스코어(몇 대 몇)는 바뀌면 안 된다 — 승/패 개수를 세어 확인한다.
    if (patch.winner) g.winner = patch.winner;
    // 날짜 정정도 여기서 한다 — 나무위키는 **일정표 날짜**를 쓰므로 재경기·연기된 판이 어긋난다.
    if (patch.played_at) g.played_at = patch.played_at;
    if (patch.result_evidence) g.result_evidence = patch.result_evidence;
    if (patch.source_url) g.source_url = patch.source_url;
    if (JSON.stringify(g) === before) skip.push(gid); else put.push(gid);
  }

  // ★ 세트 순서·진영을 고쳐도 **시리즈 스코어는 그대로**여야 한다. 바뀌면 대진 결과를 바꾼 것이다.
  const scoreOf = (games) => {
    const m = new Map();
    for (const g of games) m.set(`${g.series ?? g.id}|${g.winner}`, (m.get(`${g.series ?? g.id}|${g.winner}`) ?? 0) + 1);
    return JSON.stringify([...m.entries()].sort());
  };
  if (scoreOf(originalGames) !== scoreOf(ev.games ?? [])) {
    console.error(`   ✖ ${slug}: 시리즈 스코어가 바뀐다 — 세트 승자 정정이 대진 결과와 맞지 않는다. 쓰지 않는다.`);
    process.exitCode = 1; continue;
  }
  if (spec.set_order_known !== undefined && ev.set_order_known !== spec.set_order_known) {
    ev.set_order_known = spec.set_order_known;
    put.push("set_order_known");
  }

  // ── 3. 주최측이 발표한 팀·선수 사실 (0039) ─────────────────────────
  // 나무위키 생성기가 못 만드는 값(3위 이하 순위·상금·팀장·등급·추가 출처)이다. 사람이 출처를 보고
  // 이 파일에 적었으므로 **이 파일이 정본이다** — 재생성 때마다 그대로 다시 붙인다.
  // `//` 로 시작하는 키는 주석이라 건너뛴다.
  const noComments = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.startsWith("//")));
  for (const field of ["team_placements", "team_prizes", "team_vote_ranks", "captains", "member_ratings",
    "member_awards", "series_formats"]) {
    if (!spec[field]) continue;
    const next = { ...(ev[field] ?? {}), ...noComments(spec[field]) };
    if (JSON.stringify(next) !== JSON.stringify(ev[field] ?? {})) { ev[field] = next; put.push(field); }
  }
  for (const field of ["links", "facts"]) {
    if (spec[field] && JSON.stringify(spec[field]) !== JSON.stringify(ev[field] ?? null)) {
      ev[field] = spec[field];
      put.push(field);
    }
  }

  console.log(`▸ ${slug}`);
  console.log(`   팀 명단 추가 ${added.length}${added.length ? ` (${added.join(", ")})` : ""}`);
  console.log(`   라인업 넣음 ${put.length}${put.length ? ` — ${put.join(" ")}` : ""}`);
  if (skip.length > 0) console.log(`   바뀐 것 없음 ${skip.length} — ${skip.join(" ")}`);
  if (miss.length > 0) console.log(`   ✖ 시드에 없는 경기 ${miss.length} — ${miss.join(" ")}`);
  totGames += put.length; totAdded += added.length; totSkipped += skip.length;

  if (APPLY && (put.length > 0 || added.length > 0)) {
    ev["//판독라인업"] =
      `seed/lineups/${file} 에서 ${put.length}경기의 라인업을 병합했다(판독·출처는 각 경기 result_evidence). ` +
      `재현: node scripts/apply-meljang-lineups.mjs --apply`;
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  }
}

console.log(`\n합계 — 라인업 ${totGames}경기 · 팀 명단 추가 ${totAdded} · 건너뜀 ${totSkipped}`);
if (!APPLY) console.log(`아무것도 쓰지 않았다. 반영하려면 --apply.`);
else console.log(`다음: npm run seed:tournament -- seed/tournaments-<회차>.json`);
