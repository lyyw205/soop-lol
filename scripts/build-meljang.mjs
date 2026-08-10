/**
 * 멸망전 회차 시드 생성.
 *
 *   node --env-file-if-exists=apps/web/.env.local scripts/build-meljang.mjs meljang-2025-s2
 *     → seed/streamers-<회차>.json    (아직 등록 안 된 참가자만)
 *     → seed/tournaments-<회차>.json  (세트 단위 경기 전부)
 *
 * 회차 데이터는 scripts/meljang-seasons.mjs 에 있다. 여기엔 로직만 있다.
 *
 * ── 승패의 출처가 둘이고, 서로를 검사한다 ────────────────────────────
 * (1) **진출 경로** — GSL 조별리그는 다음 라운드의 대진이 이전 라운드의 결과다.
 *     승자전 = 1·2경기 승자 / 패자전 = 1·2경기 패자 / 최종전 = 승자전 패자 vs 패자전 승자 /
 *     4강 진출 = 조 1·2위 / 4강은 크로스. 대진만 알면 승패가 정해진다.
 * (2) **나무위키 경기 결과표** — 스코어를 직접 읽는다 (scripts/lib/namu.mjs).
 *
 * 둘이 어긋나면 시드를 만들지 않고 멈춘다. 한쪽만 믿지 않는다.
 * 더블 엘리미네이션 회차는 (1) 대신 '2패한 팀은 다시 나오지 않는다' 를 검사한다.
 *
 * ── 왜 세트 단위인가 ─────────────────────────────────────────────────
 * 멸망전은 전 경기 다전제다. '경기'(시리즈) 하나를 1판으로 적으면 판수가 틀리고
 * 진 쪽이 따낸 세트가 통째로 사라진다. 2:1 이면 3판(2승·1패)으로 편다.
 * 세트의 순서는 맞대결 합계에 영향이 없으므로 순서까지는 필요 없다.
 *
 * ── 계정 근거 ────────────────────────────────────────────────────────
 * 로스터의 닉네임을 라이엇 ID 로 간주하지 않는다(§11-2). 두 단계로 되짚는다:
 *   1) SOOP 검색 API 로 닉네임 → 방송국 아이디 (정확히 하나로 좁혀질 때만)
 *   2) 그 아이디로 SOOP 공식 FA 등록(본인이 직접 입력한 라이엇 ID)을 찾는다
 * 방송국 아이디가 이미 DB 에 있으면 기존 slug 를 재사용한다 — 같은 사람을
 * 회차마다 다른 slug 로 만들면 상대전적이 갈라진다.
 */
import { writeFileSync } from "node:fs";

import { db, closeDb } from "@soop-lol/core/lib/db/client";

import { fetchAllSeries, namuUrl } from "./lib/namu.mjs";
import { POSITION, ROMAN, SEASONS } from "./meljang-seasons.mjs";

const FA_PAGE = "https://bjmatchfa.sooplive.com/fa/27";
const FA_API = "https://gpapi.sooplive.com/api/v1/bjmatchfa/fa/list";
const SOOP_SEARCH = "https://sch.sooplive.co.kr/api.php";
const VODS = "https://ch.sooplive.co.kr/lolbjmatch/vods";

const key = process.argv[2];
const season = SEASONS[key];
if (!season) {
  console.error(`회차를 지정해라. 가능한 값:\n  ${Object.keys(SEASONS).join("\n  ")}`);
  process.exit(1);
}

const fail = (msgs) => {
  console.error(`[${key}] 실패 — 아무것도 만들지 않았다:\n` + msgs.map((m) => "  ✖ " + m).join("\n"));
  process.exit(1);
};

// ── (1) 진출 경로로 승패 유도 (GSL) ───────────────────────────────────

function solveGsl(bouts) {
  const err = [];
  const winner = new Map();
  const standing = new Map();

  const pair = (round) => {
    const b = bouts.find((x) => x[1] === round);
    if (!b) err.push(`대진에 '${round}' 이 없다`);
    return b ? [b[2], b[3]] : [];
  };
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

  const fin = bouts.find((b) => /결승/.test(b[1]));
  if (fin) {
    const finPair = [fin[2], fin[3]];
    for (const s of semis) {
      const w = only(s, finPair, `4강 ${s.join(" vs ")} 승자`);
      const b = bouts.find((x) => x[1].startsWith("4강") && asSet([x[2], x[3]]) === asSet(s));
      if (w && b) winner.set(b[1], w);
    }
  }
  return { winner, err };
}

/** 더블 엘리미네이션: 2패한 팀이 다시 나오면 대진이나 승패가 틀린 것이다. */
function checkDoubleElim(resolved) {
  const err = [];
  const losses = new Map();
  for (const r of resolved) {
    for (const t of [r.a, r.b]) {
      if ((losses.get(t) ?? 0) >= 2) err.push(`경기 ${r.no}(${r.round}): '${t}' 은 이미 2패인데 다시 나온다`);
    }
    const loser = r.winner === r.a ? r.b : r.a;
    losses.set(loser, (losses.get(loser) ?? 0) + 1);
  }
  return err;
}

// ── (2) 나무위키 스코어 ───────────────────────────────────────────────

const { series: namuSeries, missing } = await fetchAllSeries(season.namu ?? []);
if (missing.length) fail([`나무위키 문서를 못 읽었다: ${missing.join(", ")}`]);
if (namuSeries.length === 0) fail([`나무위키에서 경기 결과를 하나도 못 읽었다 (${(season.namu ?? []).join(", ")})`]);

/**
 * 대진(팀 두 개)으로 나무위키 경기를 찾는다.
 *
 * ★ 같은 두 팀이 한 대회에서 두 번 붙는 일이 흔하다 — 조별 승자전에서 만난 팀이
 *   결승에서 다시 만난다. 대진만으로는 짝이 안 지어지므로 라운드 이름이 얼마나
 *   겹치는지로 고른다. 그래도 못 가르면 남은 것 중 앞에서부터 쓴다.
 */
const pools = new Map();
for (const s of namuSeries) {
  const k = [s.a, s.b].sort().join(" ");
  if (!pools.has(k)) pools.set(k, []);
  pools.get(k).push({ ...s, taken: false });
}

/** 라운드 이름에서 구분에 쓸 토큰을 뽑는다 — 'A조 승자전' → ['A조','승자전'] */
function roundTokens(round) {
  const t = [];
  const g = /([A-D])조/.exec(round);
  if (g) t.push(`${g[1]}조`);
  const kind = /(승자전|패자전|최종전|\d+경기|결승|4강|준결승)/.exec(round);
  if (kind) t.push(kind[1]);
  const ubl = /(UB|LB)\s*(\d)R/i.exec(round);
  if (ubl) t.push(ubl[1].toUpperCase() === "UB" ? "승자조" : "패자조", `${ubl[2]}라운드`);
  return t;
}

function takeSeries(a, b, round) {
  const pool = (pools.get([a, b].sort().join(" ")) ?? []).filter((s) => !s.taken);
  if (pool.length === 0) return null;
  const want = roundTokens(round);
  let best = pool[0];
  let bestScore = -1;
  for (const s of pool) {
    const score = want.filter((w) => s.round.includes(w)).length;
    if (score > bestScore) { best = s; bestScore = score; }
  }
  best.taken = true;
  return best;
}

// ── 대조 ──────────────────────────────────────────────────────────────

const { winner: derived, err: gslErr } = season.format === "gsl"
  ? solveGsl(season.bouts)
  : { winner: new Map(), err: [] };

const errors = [...gslErr];
const resolved = [];

for (const [no, round, a, b, date] of season.bouts) {
  const s = takeSeries(a, b, round);
  if (!s) { errors.push(`경기 ${no}(${round}) '${a} vs ${b}': 나무위키에서 결과를 못 찾았다`); continue; }

  // 나무위키 표의 팀 순서를 우리 순서에 맞춘다
  const [wa, wb] = s.a === a ? [s.sa, s.sb] : [s.sb, s.sa];
  const namuWinner = wa > wb ? a : b;

  // 결승은 진출 경로로 유도할 수 없다 — 다음 라운드가 없으니 결과가 대진에 안 드러난다.
  // 그래서 결승만 나무위키 스코어 한 곳에 기댄다. 나머지는 전부 두 출처가 대조된다.
  const isFinal = /결승/.test(round);
  if (season.format === "gsl" && !isFinal) {
    const d = derived.get(round);
    if (!d) errors.push(`경기 ${no}(${round}): 진출 경로로 승자를 유도하지 못했다`);
    else if (d !== namuWinner) {
      errors.push(
        `경기 ${no}(${round}) '${a} vs ${b}': 진출 경로는 '${d}' 승, ` +
          `나무위키는 '${namuWinner}' 승 (${wa}:${wb}) — 어긋난다`,
      );
    }
  }
  resolved.push({ no, round, a, b, date, wa, wb, winner: namuWinner, namuRound: s.round });
}

if (season.format === "de") errors.push(...checkDoubleElim(resolved));
if (errors.length) fail(errors);

const totalGames = resolved.reduce((n, r) => n + r.wa + r.wb, 0);
console.log(
  `[${key}] 대조 OK — 경기 ${resolved.length}건 · 세트 ${totalGames}판` +
    (season.format === "gsl" ? " (진출 경로 유도 = 나무위키 스코어, 전건 일치)" : " (더블 엘리미네이션 정합성 OK)"),
);
for (const r of resolved) {
  console.log(`  ${r.round.padEnd(11)} ${r.a} ${r.wa}:${r.wb} ${r.b}  → ${r.winner}`);
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
const rows = await sql`
  select c.channel_id, s.slug from streamer_channel c join streamer s on s.id = c.streamer_id`;
await closeDb();
const known = new Map(rows.map((r) => [r.channel_id, r.slug]));
const slugSet = new Set(rows.map((r) => r.slug));
console.log(`\nFA 등록 ${faList.length}명 · 이미 등록된 방송국 ${known.size}개`);

const teams = {};
const newStreamers = [];
const dropped = [];
let reused = 0;

for (const [team, members] of Object.entries(season.teams)) {
  teams[team] = [];
  for (const [i, nick] of members.entries()) {
    if (!nick) { dropped.push(`${team} [${POSITION[i]}] — 로스터 미상`); continue; }

    // 이미 등록된 사람은 slug 로 바로 적어도 된다. SOOP 표시명이 그새 바뀌었을 수 있어서,
    // 닉네임 검색에 의존하지 않는 경로를 남겨 둔다.
    if (slugSet.has(nick)) { teams[team].push(nick); reused++; continue; }

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
            ` SOOP 표기 '${riot_id}'. ${season.name} 로스터(${namuUrl(season.namu[0])})의` +
            ` '${nick}' 과 방송국 아이디로 동일인 확인.`,
        },
      })),
    });
    known.set(channelId, slug);
    console.log(`  ➕ ${slug.padEnd(15)} ${nick.padEnd(13)} ${channelId.padEnd(14)} ${riotIds.join(", ")}`);
  }
}

// ── 세트 단위로 펴서 시드 작성 ────────────────────────────────────────

const games = [];
for (const r of resolved) {
  const loser = r.winner === r.a ? r.b : r.a;
  const wWins = Math.max(r.wa, r.wb);
  const lWins = Math.min(r.wa, r.wb);
  // 세트 순서는 맞대결 합계에 영향이 없다. 승자 세트를 먼저 적는다.
  const order = [...Array(wWins).fill(r.winner), ...Array(lWins).fill(loser)];
  for (const [k, setWinner] of order.entries()) {
    games.push({
      id: `g${String(r.no).padStart(2, "0")}s${k + 1}`,
      series: `g${String(r.no).padStart(2, "0")}`,
      set_no: k + 1,
      round: `${r.round} ${k + 1}세트`,
      played_at: `${r.date}T${String(19 + k).padStart(2, "0")}:00:00+09:00`,
      blue: r.a,
      red: r.b,
      winner: setWinner,
      source_url: VODS,
    });
  }
}

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
    source_url: namuUrl(season.namu[0]),
    "//승패근거":
      `승패의 출처가 둘이고 서로 대조했다. (1) 공식 방송국 VOD 제목(${VODS})에서 복원한 대진 + ` +
      (season.format === "gsl"
        ? `GSL 진출 경로 유도(승자전=1·2경기 승자, 최종전=승자전 패자 vs 패자전 승자, 4강은 크로스). `
        : `더블 엘리미네이션 정합성(2패한 팀은 다시 나오지 않는다). `) +
      `(2) 나무위키 경기 결과표의 스코어: ${(season.namu ?? []).map(namuUrl).join(" , ")}. ` +
      `${resolved.length}경기 전건이 일치했다. ` +
      `전 경기 다전제라 스코어대로 세트 단위(총 ${totalGames}판)로 펴서 넣는다 — ` +
      `시리즈를 1판으로 적으면 판수가 틀리고 진 쪽이 딴 세트가 사라진다.`,
    teams,
    games,
  }], null, 2) + "\n",
);

console.log(`\n${outStreamers} — 신규 ${newStreamers.length}명 (기존 재사용 ${reused}명)`);
console.log(`${outTournament} — 팀 ${Object.keys(teams).length} · 경기 ${resolved.length} · 세트 ${games.length}판`);
if (dropped.length) {
  console.log(`\n⚠ 근거가 없어 뺀 참가자 ${dropped.length}명:`);
  for (const d of dropped) console.log(`   ${d}`);
}
