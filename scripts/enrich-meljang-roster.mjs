/**
 * 멸망전 시드의 **로스터 구멍을 채운다.**
 *
 *   node --env-file-if-exists=apps/web/.env.local scripts/enrich-meljang-roster.mjs            # 확인만
 *   node --env-file-if-exists=apps/web/.env.local scripts/enrich-meljang-roster.mjs --apply    # 쓴다
 *
 * ── 왜 필요한가 ───────────────────────────────────────────────────────
 * `seed:meljang` 은 나무위키를 읽어 **닉네임 문자열**로 로스터를 만든다. 그런데
 * 닉네임은 SOOP 검색으로 되짚어야 사람이 되고, 동명이인·표기 변경·검색 실패로
 * 자주 끊긴다. 실측: 팀 509개 중 **250개가 로스터 통째로 빈 배열**이었고,
 * 채워진 자리는 2,545칸 중 568칸(22%)뿐이었다.
 *
 * 로스터가 비면 **경기만 들어가고 조우가 0**이다. 이 사이트의 존재 이유가
 * "스트리머끼리 누가 누구를 이겼나" 인데, 그 부분이 통째로 안 생긴다.
 *
 * ── 무엇으로 채우나 ───────────────────────────────────────────────────
 * `out/sooplol/teams.ndjson` — 2026-08-19 운영자 승인 하에 **1회만** 받은
 * 초기 시드 데이터다(경위는 `out/sooplol/README.md`). 여기엔 팀마다 5명의
 * **SOOP 방송국 아이디**가 들어 있다.
 *
 * ★ 이게 닉네임보다 나은 이유: 방송국 아이디는 `streamer_channel.channel_id`
 *   와 **정확히 같은 키**다. 검색·추측이 끼지 않는다. CLAUDE.md 원칙 1 이
 *   말하는 "표시명은 바뀐다" 문제를 그대로 피한다.
 *
 * ⚠ 재수집하지 않는다(CLAUDE.md 원칙 9). 파일이 없으면 그냥 멈춘다 —
 *   이 스크립트는 **있는 파일을 쓸 뿐** 어디에도 접속하지 않는다.
 *
 * ── 안 하는 것 ────────────────────────────────────────────────────────
 * 1. 등록 안 된 사람은 **만들지 않는다.** 방송국 아이디가 DB 에 없으면 건너뛰고
 *    보고만 한다(실측 203종). 스트리머 등록은 사람이 근거를 보고 하는 일이다.
 * 2. 이미 시드에 있는 자리는 **덮지 않는다.** 나무위키가 먼저다 — 그쪽은
 *    두 경로 교차검증을 통과한 값이고, 이건 외부 사이트 한 곳의 말이다.
 * 3. 한 팀이 **5명을 넘게** 되면 그 자리는 버리고 보고한다. 5명 중 4명이 같고
 *    한 자리만 다르면 교체 선수일 수도, 등록 명단과 실제 출전이 다른 것일 수도
 *    있다 — 근거 없이 못 정한다(CLAUDE.md 원칙 2).
 * 4. 한 사람이 한 대회에서 **두 팀**에 들어가지 않는다. `event_team_member` 의
 *    PK 가 `(event_id, streamer_id)` 라 나중 것이 앞의 것을 조용히 덮는다.
 *
 * ── seed:meljang 을 다시 돌리면 ───────────────────────────────────────
 * 시드가 나무위키 기준으로 새로 만들어지므로 **이 보강은 사라진다.**
 * 그때는 이 스크립트를 다시 돌리면 된다. 멱등이라 몇 번 돌려도 같다.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";

import { db, closeDb } from "@soop-lol/core/lib/db/client";

const APPLY = process.argv.includes("--apply");
const SRC = "out/sooplol/teams.ndjson";

/**
 * sooplol 대회 아이디 → 우리 event slug.
 *
 * ★ 2019 S3 · 2020 S1 · 2020 S2 는 저쪽이 **천상계/지상계로 쪼개** 두 대회로
 *   갖고 있는데 우리는 한 회차로 본다. 그래서 두 아이디가 한 slug 로 온다.
 * ★ 34(2024 앙코르전)는 **우리 시드에 없다.** 여기 넣지 않는다 — 없는 대회의
 *   로스터를 채울 수는 없다. 회차 자체를 추가하는 건 별개의 일이다.
 */
const EVENT = {
  1: "meljang-2014-s1", 2: "meljang-2015-s1", 3: "meljang-2017-s1",
  4: "meljang-2018-s1", 5: "meljang-2018-s2", 6: "meljang-2018-s3",
  7: "meljang-2019-s1", 10: "meljang-2019-s2",
  38: "meljang-2019-s3", 68: "meljang-2019-s3",   // 천상계 · 지상계
  39: "meljang-2020-s1", 71: "meljang-2020-s1",   // 천상계 · 지상계
  40: "meljang-2020-s2", 74: "meljang-2020-s2",   // 천상계 · 지상계
  17: "meljang-2020-s3", 19: "meljang-2020-encore",
  20: "meljang-2021-s1", 22: "meljang-2021-s2", 23: "meljang-2021-encore",
  25: "meljang-2022-s1", 26: "meljang-2022-s2",
  28: "meljang-2023-s1", 29: "meljang-2023-s2",
  32: "meljang-2024-s1",
  35: "meljang-2025-s1", 36: "meljang-2025-s2",
  110: "meljang-2026-s1", 115: "meljang-2026-geng",
};

/** 저쪽 컬럼 순서 = 우리 포지션 순서. 이 대응은 대회 페이지의 표기 그대로다. */
const SLOTS = [
  ["topId", "topName", "TOP"],
  ["jugId", "jugName", "JUNGLE"],
  ["midId", "midName", "MIDDLE"],
  ["adId", "adName", "BOTTOM"],
  ["supId", "supName", "UTILITY"],
];

/** 팀명 비교는 공백·대소문자만 무시한다. 그 이상 뭉개면 다른 팀이 붙는다. */
const norm = (s) => String(s ?? "").replace(/\s+/gu, "").toLowerCase();

let raw;
try {
  raw = readFileSync(SRC, "utf8");
} catch {
  console.error(`✖ ${SRC} 이 없다.`);
  console.error(`  이건 2026-08-19 에 1회만 받은 초기 시드 데이터다. 다시 받지 않는다`);
  console.error(`  (CLAUDE.md 원칙 9). 경위는 out/sooplol/README.md.`);
  process.exit(1);
}

/** slug → 팀명(정규화) → 저쪽 팀 레코드 */
const bySlug = new Map();
for (const line of raw.split("\n")) {
  if (!line.trim()) continue;
  const t = JSON.parse(line);
  const slug = EVENT[t.tournamentId];
  if (!slug) continue;
  if (!bySlug.has(slug)) bySlug.set(slug, new Map());
  bySlug.get(slug).set(norm(t.teamName), t);
}

const sql = db();
const chan = new Map(
  (await sql`SELECT channel_id, streamer_id FROM streamer_channel WHERE platform = 'soop'`)
    .map((r) => [r.channel_id.toLowerCase(), r.streamer_id]),
);
const slugById = new Map(
  (await sql`SELECT id, slug FROM streamer`).map((r) => [r.id, r.slug]),
);
await closeDb();

/** 방송국 아이디 → 우리 slug. 없으면 null (= 등록 안 된 사람). */
const toSlug = (cid) => {
  const id = chan.get(String(cid ?? "").trim().toLowerCase());
  return id ? slugById.get(id) : null;
};

const unregistered = new Map();   // 방송국아이디 → { name, n, events:Set }
const overflow = [];              // 5명을 넘겨서 버린 자리
const crossTeam = [];             // 같은 대회 다른 팀에 이미 있는 사람
let filesTouched = 0, teamsFilled = 0, slotsAdded = 0;

console.log(`${APPLY ? "쓴다" : "확인만 한다 (--apply 를 주면 쓴다)"}\n`);
console.log(`${"시드".padEnd(22)}${"채운자리".padStart(8)}${"팀".padStart(5)}${"미등록".padStart(7)}`);
console.log("─".repeat(42));

for (const file of readdirSync("seed").filter((f) => /^tournaments-meljang-.*\.json$/u.test(f)).sort()) {
  const path = `seed/${file}`;
  const doc = JSON.parse(readFileSync(path, "utf8"));
  const ev = doc[0];
  const theirs = bySlug.get(ev.slug);
  if (!theirs) { console.log(`${ev.slug.padEnd(22)}${"—".padStart(8)}  (저쪽에 없는 회차)`); continue; }

  ev.teams ??= {};
  ev.roster_positions ??= {};

  /** 이 대회에서 각 사람이 이미 어느 팀에 있는지. 두 팀 배정을 막는다. */
  const placed = new Map();
  for (const [team, roster] of Object.entries(ev.teams)) {
    for (const s of roster ?? []) placed.set(s, team);
  }

  let added = 0, filled = 0, unreg = 0;
  const credited = [];

  for (const [team, roster] of Object.entries(ev.teams)) {
    const t = theirs.get(norm(team));
    if (!t) continue;
    const before = (roster ?? []).length;
    const take = [];

    for (const [idKey, nameKey, pos] of SLOTS) {
      const cid = String(t[idKey] ?? "").trim();
      if (!cid) continue;
      const slug = toSlug(cid);
      if (!slug) {
        unreg++;
        const cur = unregistered.get(cid) ?? { name: t[nameKey], n: 0, events: new Set() };
        cur.n++; cur.events.add(ev.slug);
        unregistered.set(cid, cur);
        continue;
      }
      const where = placed.get(slug);
      if (where === team) continue;                                  // 이미 이 팀 — 할 일 없음
      if (where !== undefined) { crossTeam.push(`${ev.slug}  ${slug}  시드 '${where}' vs 저쪽 '${team}'`); continue; }
      take.push({ slug, pos, name: t[nameKey] });
    }

    if (take.length === 0) continue;
    if (before + take.length > 5) {
      overflow.push(`${ev.slug}  ${team}  시드 ${before}명 + ${take.length}명 = ${before + take.length}명 — 통째로 건너뛴다 (${take.map((x) => `${x.name}/${x.pos}`).join(", ")})`);
      continue;
    }

    ev.teams[team] = [...(roster ?? []), ...take.map((x) => x.slug)];
    for (const x of take) {
      ev.roster_positions[x.slug] = x.pos;
      placed.set(x.slug, team);
      credited.push(x.slug);
    }
    added += take.length;
    if (before === 0) filled++;
  }

  console.log(`${ev.slug.padEnd(22)}${String(added).padStart(8)}${String(filled).padStart(5)}${String(unreg).padStart(7)}`);
  if (added === 0) continue;
  slotsAdded += added; teamsFilled += filled; filesTouched++;

  if (APPLY) {
    // 어느 자리가 어디서 왔는지 시드에 박아 둔다. 나중에 이 시드를 읽는 사람이
    // 나무위키 값과 외부 값을 구분할 수 있어야 한다 (CLAUDE.md 원칙 8).
    ev["//로스터보강"] =
      `sooplol.com 대회 로스터(2026-08-19 1회 수집, out/sooplol/README.md)의 SOOP 방송국 아이디로 ` +
      `${added}자리를 채웠다. 나머지는 나무위키 출처다. 재현: scripts/enrich-meljang-roster.mjs`;
    ev["//로스터보강_대상"] = credited.sort().join(" ");
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  }
}

console.log("─".repeat(42));
console.log(`${"합계".padEnd(22)}${String(slotsAdded).padStart(8)}${String(teamsFilled).padStart(5)}\n`);
console.log(`시드 ${filesTouched}개 · 자리 ${slotsAdded}칸 · 로스터가 통째로 비었던 팀 ${teamsFilled}개`);

if (overflow.length > 0) {
  console.log(`\n△ 5명을 넘겨 버린 팀 ${overflow.length}건 — 사람이 봐야 한다`);
  for (const m of overflow) console.log(`   ${m}`);
}
if (crossTeam.length > 0) {
  console.log(`\n△ 같은 대회에서 팀이 어긋난 사람 ${crossTeam.length}건`);
  for (const m of crossTeam) console.log(`   ${m}`);
}
if (unregistered.size > 0) {
  const total = [...unregistered.values()].reduce((a, b) => a + b.n, 0);
  console.log(`\n△ 등록 안 된 방송국 ${unregistered.size}종 (자리로는 ${total}칸) — 여기가 남은 구멍이다`);
  console.log(`   등록하면 그만큼 조우가 더 생긴다. 등록은 근거를 보고 사람이 한다.`);
  const top = [...unregistered.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20);
  for (const [cid, v] of top) console.log(`   ${cid.padEnd(18)} ${String(v.name ?? "?").padEnd(14)} ${String(v.n).padStart(2)}회`);
  if (unregistered.size > top.length) console.log(`   … 그리고 ${unregistered.size - top.length}종 더`);
  if (APPLY) {
    writeFileSync("out/sooplol/unregistered-channels.json",
      `${JSON.stringify([...unregistered.entries()]
        .sort((a, b) => b[1].n - a[1].n)
        .map(([cid, v]) => ({ channel_id: cid, name: v.name, slots: v.n, events: [...v.events].sort() })), null, 2)}\n`);
    console.log(`\n   전체 목록 → out/sooplol/unregistered-channels.json`);
  }
}

if (!APPLY) console.log(`\n아무것도 쓰지 않았다. 반영하려면 --apply.`);
else console.log(`\n다음: npm run seed:tournament -- seed/tournaments-meljang-*.json`);
