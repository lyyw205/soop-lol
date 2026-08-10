/**
 * 멸망전 회차 시드 생성.
 *
 *   node --env-file-if-exists=apps/web/.env.local scripts/build-meljang.mjs meljang-2025-s2
 *     → seed/streamers-<회차>.json    (아직 등록 안 된 참가자만)
 *     → seed/tournaments-<회차>.json  (경기 전부, 승패 포함)
 *
 * 회차 데이터는 scripts/meljang-seasons.mjs 에 있다. 여기엔 로직만 있다.
 *
 * ── 승패를 어떻게 아는가 ─────────────────────────────────────────────
 * 공식 VOD 제목은 대진(A vs B)과 라운드만 준다. 승패는 없다.
 * 그런데 GSL 조별리그는 **진출 경로가 곧 결과**다:
 *
 *   승자전 = 1경기 승자 vs 2경기 승자      → 1·2경기 승자가 정해진다
 *   패자전 = 1경기 패자 vs 2경기 패자      → 위와 어긋나면 대진 복원이 틀린 것 (검사)
 *   최종전 = 승자전 패자 vs 패자전 승자    → 승자전·패자전 승자가 정해진다
 *   4강 진출 = 승자전 승자(조1위) + 최종전 승자(조2위) → 최종전 승자가 정해진다
 *   4강 대진 = A조1위 vs B조2위 / B조1위 vs A조2위 (크로스) → 조 순위 교차검증
 *   결승 대진 = 4강 두 경기의 승자          → 4강 승자가 정해진다
 *
 * 13경기 중 12경기가 이렇게 **유도**된다. 남는 결승 승자 하나만 외부 근거를 쓴다.
 * 어느 단계든 모순이 나오면 시드를 만들지 않고 멈춘다. 추측으로 메우지 않는다.
 *
 * ── 계정 근거 ────────────────────────────────────────────────────────
 * 로스터의 닉네임을 라이엇 ID 로 간주하지 않는다(§11-2). 두 단계로 되짚는다:
 *   1) SOOP 검색 API 로 닉네임 → 방송국 아이디 (정확히 하나로 좁혀질 때만)
 *   2) 그 아이디로 SOOP 공식 FA 등록(본인이 직접 입력한 라이엇 ID)을 찾는다
 * 둘 중 하나라도 안 되면 그 사람은 넣지 않고 보고한다.
 * 방송국 아이디가 이미 DB 에 있으면 **기존 slug 를 재사용한다** — 같은 사람을
 * 회차마다 다른 slug 로 중복 생성하면 상대전적이 갈라진다.
 */
import { writeFileSync } from "node:fs";

import { db, closeDb } from "@soop-lol/core/lib/db/client";

import { POSITION, ROMAN, SEASONS } from "./meljang-seasons.mjs";

const FA_PAGE = "https://bjmatchfa.sooplive.com/fa/27";
const FA_API = "https://gpapi.sooplive.com/api/v1/bjmatchfa/fa/list";
const SOOP_SEARCH = "https://sch.sooplive.co.kr/api.php";
const VODS = "https://ch.sooplive.co.kr/lolbjmatch/vods";

const key = process.argv[2];
const season = SEASONS[key];
if (!season) {
  console.error(`회차를 지정해라. 가능한 값: ${Object.keys(SEASONS).join(", ")}`);
  process.exit(1);
}

// ── 승패 유도 (GSL) ───────────────────────────────────────────────────

function solveGsl({ bouts, final_winner }) {
  const err = [];
  const winner = new Map();
  const standing = new Map();

  const pair = (round) => {
    const b = bouts.find((x) => x[1] === round);
    if (!b) err.push(`대진에 '${round}' 이 없다`);
    return b ? [b[2], b[3]] : [];
  };
  /** xs 중 ys 에 든 것 하나. 정확히 하나가 아니면 모순이다. */
  const only = (xs, ys, why) => {
    const hit = xs.filter((x) => ys.includes(x));
    if (hit.length !== 1) {
      err.push(`${why}: ${xs.join("/")} 중 ${ys.join("/")} 에 든 것이 ${hit.length}개 (1개여야 한다)`);
      return null;
    }
    return hit[0];
  };
  const other = (p, x) => (p[0] === x ? p[1] : p[0]);
  const asSet = (p) => JSON.stringify([...p].sort());

  const groups = [...new Set(bouts.map((b) => /^([A-D])조 /.exec(b[1])?.[1]).filter(Boolean))];
  const semis = bouts.filter((b) => b[1].startsWith("4강")).map((b) => [b[2], b[3]]);
  const semiTeams = semis.flat();

  for (const g of groups) {
    const m1 = pair(`${g}조 1경기`);
    const m2 = pair(`${g}조 2경기`);
    const wb = pair(`${g}조 승자전`);
    const lb = pair(`${g}조 패자전`);
    const fi = pair(`${g}조 최종전`);
    if ([m1, m2, wb, lb, fi].some((p) => p.length !== 2)) continue;

    const w1 = only(m1, wb, `${g}조 1경기 승자`);
    const w2 = only(m2, wb, `${g}조 2경기 승자`);
    if (!w1 || !w2) continue;
    winner.set(`${g}조 1경기`, w1);
    winner.set(`${g}조 2경기`, w2);

    const wantLb = [other(m1, w1), other(m2, w2)];
    if (asSet(lb) !== asSet(wantLb)) {
      err.push(`${g}조 패자전이 '${lb.join(" vs ")}' 인데 1·2경기 패자는 '${wantLb.join(" vs ")}' 다`);
      continue;
    }

    const wbLoser = only(wb, fi, `${g}조 승자전 패자`);
    const lbWinner = only(lb, fi, `${g}조 패자전 승자`);
    if (!wbLoser || !lbWinner) continue;
    winner.set(`${g}조 승자전`, other(wb, wbLoser));
    winner.set(`${g}조 패자전`, lbWinner);
    standing.set(`${g}1위`, other(wb, wbLoser));

    const second = only(fi, semiTeams, `${g}조 최종전 승자(4강 진출)`);
    if (!second) continue;
    winner.set(`${g}조 최종전`, second);
    standing.set(`${g}2위`, second);
  }

  // 4강은 조 1위 × 다른 조 2위 크로스여야 한다
  if (groups.length === 2 && semis.length === 2) {
    const [g1, g2] = groups;
    const cross = [
      [standing.get(`${g1}1위`), standing.get(`${g2}2위`)],
      [standing.get(`${g2}1위`), standing.get(`${g1}2위`)],
    ];
    if (cross.every((c) => c.every(Boolean))) {
      const want = cross.map(asSet).sort();
      const got = semis.map(asSet).sort();
      if (JSON.stringify(want) !== JSON.stringify(got)) {
        err.push(`4강 대진이 크로스와 다르다 — 실제 ${got.join(" | ")} / 기대 ${want.join(" | ")}`);
      }
    }
  }

  // 결승 참가자 = 4강 두 경기의 승자
  const fin = pair("결승전");
  for (const [i, s] of semis.entries()) {
    const w = only(s, fin, `4강 ${i + 1}경기 승자`);
    if (w) winner.set(bouts.find((b) => b[1].startsWith("4강") && asSet([b[2], b[3]]) === asSet(s))[1], w);
  }
  if (fin.length === 2 && !fin.includes(final_winner)) {
    err.push(`결승 승자 '${final_winner}' 가 결승 대진 '${fin.join(" vs ")}' 에 없다`);
  }
  winner.set("결승전", final_winner);

  for (const b of bouts) if (!winner.has(b[1])) err.push(`'${b[1]}' 의 승자를 유도하지 못했다`);
  return { winner, err };
}

const { winner, err } = solveGsl(season);
if (err.length) {
  console.error(`[${key}] 승패 유도 실패 — 아무것도 만들지 않았다:\n` + err.map((e) => "  ✖ " + e).join("\n"));
  process.exit(1);
}
console.log(
  `[${key}] 승패 유도 OK — ${season.bouts.length}경기 중 ${season.bouts.length - 1}경기 유도 + 결승 1경기 외부 근거`,
);
for (const [, round, a, b] of season.bouts) {
  console.log(`  ${round.padEnd(11)} ${a} vs ${b} → ${winner.get(round)} 승`);
}

// ── 방송국 아이디 해석 → 기존 slug 재사용 또는 FA 로 신규 등록 ─────────

async function soopChannelId(nick) {
  const url =
    `${SOOP_SEARCH}?m=bjSearch&v=3.0&szOrder=&szKeyword=${encodeURIComponent(nick)}&nPageNo=1&nListCnt=10`;
  try {
    const r = await fetch(url, { headers: { Referer: "https://www.sooplive.co.kr/" } });
    if (!r.ok) return null;
    const rows = (await r.json())?.DATA ?? [];
    const exact = rows.filter((x) => x.user_nick === nick);
    return exact.length === 1 ? exact[0].user_id : null; // 동명이인이면 포기한다
  } catch {
    return null;
  }
}

const faRes = await fetch(FA_API, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    orderType: "point_desc", filter: [], searchBjNick: "", minPoint: 0, maxPoint: 1000,
    positionIdx: "", pageNo: 1, perPageNo: 500, seasonIdx: 27,
  }),
});
const faList = (await faRes.json()).data.faList;
const fa = new Map(faList.map((f) => [f.userId, f]));

const sql = db();
const known = new Map(
  (await sql`select c.channel_id, s.slug from streamer_channel c join streamer s on s.id = c.streamer_id`)
    .map((r) => [r.channel_id, r.slug]),
);
await closeDb();
console.log(`\nFA 등록 ${faList.length}명 · 이미 등록된 방송국 ${known.size}개`);

const teams = {};
const newStreamers = [];
const dropped = [];
let reused = 0;

for (const [team, members] of Object.entries(season.teams)) {
  teams[team] = [];
  for (const [i, nick] of members.entries()) {
    if (!nick) { dropped.push(`${team} [${POSITION[i]}] — 로스터 미상`); continue; }

    const channelId = await soopChannelId(nick);
    await new Promise((s) => setTimeout(s, 250));
    if (!channelId) { dropped.push(`${team} ${nick} — SOOP 검색에서 단일 해석 실패`); continue; }

    const existing = known.get(channelId);
    if (existing) { teams[team].push(existing); reused++; continue; }

    const slug = ROMAN[nick];
    if (!slug) { dropped.push(`${team} ${nick} (${channelId}) — ROMAN 에 slug 가 없다`); continue; }
    const f = fa.get(channelId);
    if (!f) { dropped.push(`${team} ${nick} (${channelId}) — FA 등록에 없어 라이엇 ID 근거가 없다`); continue; }

    teams[team].push(slug);
    const riotIds = (f.totalGameNickList?.length ? f.totalGameNickList : [f.gameNick]).filter(Boolean);
    newStreamers.push({
      slug,
      display_name: nick,
      platform: "soop",
      channel_id: channelId,
      channel_url: `https://ch.sooplive.co.kr/${channelId}`,
      note: `${season.name} '${team}' ${POSITION[i]}`,
      accounts: riotIds.map((riot_id, k) => ({
        riot_id,
        label: k === 0 ? "본계" : "부계",
        is_main: k === 0,
        confidence: "verified",
        evidence: {
          source: "self_declared",
          url: FA_PAGE,
          note:
            `SOOP 공식 '2026 LoL 멸망전 with Gen.G' FA 등록에 본인이 직접 입력한 라이엇 ID` +
            ` (등록 ${String(f.regDate).slice(0, 10)}). SOOP 아이디 ${channelId}.` +
            ` SOOP 표기 '${riot_id}'. ${season.name} 로스터(${season.wiki})의 '${nick}' 과` +
            ` 방송국 아이디로 동일인 확인.`,
        },
      })),
    });
    known.set(channelId, slug); // 같은 회차 안에서 중복 생성 방지
    console.log(`  ➕ ${slug.padEnd(15)} ${nick.padEnd(13)} ${channelId.padEnd(14)} ${riotIds.join(", ")}`);
  }
}

const games = season.bouts.map(([no, round, a, b, date]) => ({
  id: `g${String(no).padStart(2, "0")}`,
  round,
  played_at: `${date}T19:00:00+09:00`,
  blue: a,
  red: b,
  winner: winner.get(round),
  source_url: VODS,
}));

const outStreamers = `seed/streamers-${key}.json`;
const outTournament = `seed/tournaments-${key}.json`;
writeFileSync(outStreamers, JSON.stringify(newStreamers, null, 2) + "\n");
writeFileSync(
  outTournament,
  JSON.stringify([{
    slug: key,
    name: season.name,
    kind: "tournament",
    organizer: season.organizer,
    starts_at: season.starts_at,
    ends_at: season.ends_at,
    source_url: season.wiki,
    "//승패근거":
      `대진은 공식 방송국 VOD 제목(${VODS})에서 복원. 승패는 GSL 진출 경로로 ` +
      `${season.bouts.length}경기 중 ${season.bouts.length - 1}경기를 유도했다(승자전=1·2경기 승자, ` +
      `최종전=승자전 패자 vs 패자전 승자, 4강 진출=조 1·2위, 4강은 크로스). ` +
      `결승 승자만 외부 근거: ${season.final_evidence}`,
    teams,
    games,
  }], null, 2) + "\n",
);

console.log(`\n${outStreamers} — 신규 ${newStreamers.length}명 (기존 재사용 ${reused}명)`);
console.log(`${outTournament} — 팀 ${Object.keys(teams).length} · 경기 ${games.length}`);
if (dropped.length) {
  console.log(`\n⚠ 근거가 없어 뺀 참가자 ${dropped.length}명:`);
  for (const d of dropped) console.log(`   ${d}`);
}
