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

import { placementRank } from "@soop-lol/core/lib/metrics/placement";

import {
  fetchAllSeries, fetchPersonLinks, fetchPlacements, fetchRosters, namuUrl, normTeam,
} from "./lib/namu.mjs";
import { POSITION, ROMAN, SEASONS } from "./meljang-seasons.mjs";
import { fetchFaList } from "./lib/soop-fa.mjs";
import { soopFetch } from "./lib/soop-http.mjs";

const FA_PAGE = "https://bjmatchfa.sooplive.com/fa/27";
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
    if (!r.winner) continue;
    const loser = r.winner === r.a ? r.b : r.a;
    losses.set(loser, (losses.get(loser) ?? 0) + 1);
  }
  return err;
}

// ── (2) 나무위키 스코어 ───────────────────────────────────────────────

const { series: rawSeries, missing } = await fetchAllSeries(season.namu ?? []);
if (missing.length) fail([`나무위키 문서를 못 읽었다: ${missing.join(", ")}`]);
if (rawSeries.length === 0) fail([`나무위키에서 경기 결과를 하나도 못 읽었다 (${(season.namu ?? []).join(", ")})`]);

// 참가팀 표는 뒤에서도 쓴다. 팀 이름을 모으기 전에 먼저 읽어야 해서 여기서 한 번만 부른다.
const rosterTable = (await fetchRosters(season.namu[0])) ?? {};

// 같은 대회 안에서도 팀명 표기가 흔들린다. 대표 표기 하나로 모은다.
const canon = new Map();
for (const s of rawSeries) for (const t of [s.a, s.b]) if (!canon.has(normTeam(t))) canon.set(normTeam(t), t);

// ★ 대회 도중 이름을 바꾼 팀은 참가팀 표에 'togings ▶ 토없기왕' 으로 적힌다.
//   두 이름이 **결과표에도 둘 다** 나오면 한 팀이 두 팀으로 쪼개진다. 그러면
//   로스터는 한쪽에만 붙고(한 대회 한 팀 제약), 다른 쪽 경기는 아무의 전적도 아니게 된다.
//   실제로 2019 시즌1 의 kimmingyo 가 7경기 중 2경기만 인정받고 있었다.
//   같은 팀이라고 출처가 직접 말했으니 앞 이름으로 합친다.
for (const t of Object.keys(rosterTable)) {
  const parts = t.split(/[▶→]/).map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) continue;
  const seen = parts.filter((p) => canon.has(normTeam(p)));
  if (seen.length < 2) continue;
  const head = canon.get(normTeam(seen[0]));
  for (const p of seen.slice(1)) canon.set(normTeam(p), head);
  console.log(`  대회 중 이름을 바꾼 팀을 하나로 합친다: ${seen.join(" = ")} → '${head}'`);
}

const nameOf = (t) => canon.get(normTeam(t)) ?? t;
// 세트 승자 배열도 같은 표기로 맞춘다 — 안 그러면 시드의 winner 가 blue/red 와 안 맞는다.
const namuSeries = rawSeries.map((s) => ({
  ...s,
  a: nameOf(s.a),
  b: nameOf(s.b),
  setWinners: s.setWinners?.map(nameOf) ?? null,
}));

/**
 * 대진을 데이터 파일에 안 적었으면 나무위키에서 그대로 가져온다.
 * 풀리그 회차가 그렇다 — 진출 경로로 유도할 게 없어서 대진을 손으로 옮길 이유가 없고,
 * 옮기면 그만큼 틀린다. 이 경우 승패 근거는 나무위키 한 곳뿐이고 시드에 그렇게 적는다.
 */
if (!season.bouts) {
  const nth = (season.only_rounds ?? null);
  const picked = namuSeries.filter((s) => !nth || nth.some((r) => s.round.includes(r)));
  season.bouts = picked.map((s, i) => [i + 1, s.round, s.a, s.b, s.date ?? season.starts_at]);
  // ★ 원본에 경기 날짜가 없으면 회차 시작일로 채운다. 그러면 그 회차의 모든 경기가
  //   같은 날이 되어 '마지막으로 만난 날' 같은 표시가 틀린다. 채웠다는 사실을 남긴다 —
  //   조용히 지어낸 날짜가 진짜인 척하는 게 제일 나쁘다.
  season.dates_unknown = picked.filter((s) => !s.date).length;
  if (season.dates_unknown > 0) {
    console.log(`  ⚠ 원본에 날짜가 없는 경기 ${season.dates_unknown}건 — 회차 시작일(${season.starts_at})로 채운다`);
  }
}

// 로스터도 안 적었으면 참가팀 표에서 읽는다.
//
// ★ 예선에서 떨어진 팀도 **전부** 남긴다.
//   멸망전은 예선 참가팀이 30~40개인데 본선에 오르는 건 8~12개다. 예전엔 결과표
//   (=본선)에 나온 팀만 남겼는데, 그러면 예선 탈락한 회차가 통째로 사라진다.
//   이상호가 2021 시즌2·앙코르전에 나갔는데 우리 화면엔 안 나오던 이유가 이것이다.
//   나무위키 참가팀 표는 '1차예선 탈락' 까지 순위를 매겨 주므로 근거도 있다.
//   경기가 0건인 팀은 조우를 안 만들 뿐이고, "이 회차에 나가서 예선에서 떨어졌다" 는
//   그 자체로 사실이다. 안 적으면 우리가 모르는 게 아니라 **없었던 일이 된다.**
//
//   손으로 적은 teams 가 있어도 이 블록은 돈다. 손으로 적은 건 본선 명단(대개 8팀)이고
//   참가팀 표에는 예선 팀까지 40팀이 있다. **손으로 적은 쪽이 언제나 이기고**,
//   거기 없는 팀만 표에서 더한다. 예전엔 손으로 적었으면 표를 아예 안 봤는데,
//   그래서 2025 시즌1 은 40팀 순위가 나무위키에 있는데도 8팀만 들어갔다.
//
// ★ 다만 그 표가 **이 대회의 참가팀이 맞는지 먼저 확인한다.**
//   회차에 따라 문서의 '참가팀' 표가 본선과 전혀 다른 팀 집합이다 —
//   2025 시즌2·2026 시즌1 은 본선 8팀 중 1~2팀만 표에 있다(본선이 드래프트로 재편된다).
//   이걸 모르고 합쳤다가 이상호를 본선 팀 '왜자꾸이기는건데' 에서 예선 표기 '바밤바*' 로
//   옮겨 버렸고, 한 대회 한 팀 제약(PK) 때문에 **본선 경기가 성적에서 통째로 사라졌다.**
//   근거 없이 합치면 사람을 남의 팀에 넣는다. 확인되는 회차만 합친다.
{
  const handTeams = season.teams ?? null;
  // 참가팀 '표' 가 없는 회차가 있다 — 2014·2015 는 로스터가 산문으로 적혀 있다
  // ('팀원: 카카롯(탑), Mid Nexus(미드)…'). 그래도 경기는 사실이므로 넣는다.
  // 로스터가 비면 조우가 안 생길 뿐, 나중에 명단을 알게 되면 다시 돌려 살릴 수 있다.
  let rosters = rosterTable;
  if (!handTeams && Object.keys(rosters).length === 0) {
    console.log(`  ⚠ 참가팀 표를 못 읽었다 — 팀 이름만 넣는다 (조우는 생기지 않는다)`);
  }

  // 손으로 적은 본선 명단이 있을 때만 따진다. 없으면 이 표가 유일한 출처다.
  if (handTeams && Object.keys(rosters).length > 0) {
    const inTable = new Set(Object.keys(rosters).flatMap((t) =>
      t.split(/[▶→]/).map((x) => normTeam(x.trim())).filter(Boolean)));
    const overlap = Object.keys(handTeams).filter((t) => inTable.has(normTeam(t))).length;
    // 표가 이 대회의 판이라는 근거 두 가지 — 본선 팀이 표에 있거나, 표가 순위를 매기거나.
    // 둘 다 없으면 그 표가 무엇인지 우리가 모르는 것이다. 모르면 안 쓴다.
    const ranked = Object.keys((await fetchPlacements(season.namu[0])) ?? {}).length;
    if (overlap * 2 < Object.keys(handTeams).length && ranked === 0) {
      console.log(
        `  ⚠ 참가팀 표(${Object.keys(rosters).length}팀)를 쓰지 않는다 — ` +
          `본선 ${Object.keys(handTeams).length}팀 중 ${overlap}팀만 표에 있고 순위도 없다. ` +
          `이 대회의 판인지 확인되지 않는다`,
      );
      rosters = {};
    }
  }

  const inBouts = new Set(season.bouts.flatMap((b) => [normTeam(b[2]), normTeam(b[3])]));
  season.teams = { ...(handTeams ?? {}) };
  const known = new Set(Object.keys(season.teams).map(normTeam));
  let added = 0;
  for (const [team, members] of Object.entries(rosters)) {
    // 대회 도중 이름을 바꾼 팀은 'togings ▶ 토없기왕' 처럼 둘 다 적혀 있다.
    // 결과표에 나온 표기가 있으면 그쪽으로 건다(양쪽 다 나오면 양쪽 다).
    // 결과표에 아예 안 나오는 팀(=예선 탈락)은 **바꾼 뒤 이름 하나만** 쓴다 —
    // 안 그러면 한 팀이 두 팀으로 불어나 참가 횟수가 부풀려진다.
    const aliases = team.split(/[▶→]/).map((x) => x.trim()).filter(Boolean);
    const played = aliases.filter((a) => inBouts.has(normTeam(a)));
    for (const alias of played.length > 0 ? played : aliases.slice(-1)) {
      const name = nameOf(alias);
      if (known.has(normTeam(name))) continue;
      season.teams[name] = members;
      known.add(normTeam(name));
      added++;
    }
  }
  if (handTeams) {
    console.log(
      `  손으로 적은 본선 ${Object.keys(handTeams).length}팀 + 참가팀 표에서 더한 ${added}팀`,
    );
  }
  // 대진에만 있고 참가팀 표에 없는 팀 — 대개 예선에서 올라와 본선 표에 안 실린 팀이다.
  // 경기가 있었던 건 사실이므로 **로스터를 비운 채 남긴다**. 나중에 로스터를 알게 되면
  // 다시 돌려 그 팀의 조우가 살아난다. 지우면 그 경기 자체가 사라진다.
  const noRoster = [];
  for (const b of season.bouts) {
    for (const t of [b[2], b[3]]) {
      if (known.has(normTeam(t))) continue;
      season.teams[t] = [];
      known.add(normTeam(t));
      noRoster.push(t);
    }
  }
  if (noRoster.length) {
    console.log(`  ⚠ 참가팀 표에 없어 로스터를 비운 팀 ${noRoster.length}개: ${noRoster.join(", ")}`);
  }
}

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
    const score = want.filter((w) => (s.round ?? "").includes(w)).length;
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
  const flip = s.a !== a;
  const [wa, wb] = flip ? [s.sb, s.sa] : [s.sa, s.sb];
  // 2세트제 조별리그(2014~2017)는 1:1 로 끝나는 무승부가 있다. 승자를 만들어내지 않는다.
  const namuWinner = wa === wb ? null : wa > wb ? a : b;
  const setWinners = s.setWinners ?? null;

  // 결승은 진출 경로로 유도할 수 없다 — 다음 라운드가 없으니 결과가 대진에 안 드러난다.
  // 그래서 결승만 나무위키 스코어 한 곳에 기댄다. 나머지는 전부 두 출처가 대조된다.
  const isFinal = /결승/.test(round);
  if (season.format === "gsl" && !isFinal && namuWinner) {
    const d = derived.get(round);
    if (!d) errors.push(`경기 ${no}(${round}): 진출 경로로 승자를 유도하지 못했다`);
    else if (d !== namuWinner) {
      errors.push(
        `경기 ${no}(${round}) '${a} vs ${b}': 진출 경로는 '${d}' 승, ` +
          `나무위키는 '${namuWinner}' 승 (${wa}:${wb}) — 어긋난다`,
      );
    }
  }
  resolved.push({ no, round, a, b, date, wa, wb, winner: namuWinner, setWinners, namuRound: s.round });
}

if (season.format === "de") errors.push(...checkDoubleElim(resolved));
if (errors.length) fail(errors);

const totalGames = resolved.reduce((n, r) => n + r.wa + r.wb, 0);
const HOW = {
  gsl: "진출 경로 유도 = 나무위키 스코어, 전건 일치",
  de: "더블 엘리미네이션 정합성 OK",
  table: "풀리그라 유도할 게 없다 — 나무위키 결과표를 그대로 읽었다",
};
console.log(`[${key}] 대조 OK — 경기 ${resolved.length}건 · 세트 ${totalGames}판 (${HOW[season.format]})`);
const drawnCount = resolved.filter((r) => !r.winner).length;
for (const r of resolved) {
  console.log(`  ${r.round.padEnd(11)} ${r.a} ${r.wa}:${r.wb} ${r.b}  → ${r.winner ?? "무승부"}`);
}
if (drawnCount > 0) console.log(`  (2세트제라 무승부 ${drawnCount}경기 — 승자를 만들지 않는다)`);

// ── 순위 ──────────────────────────────────────────────────────────────
//
// 1순위는 나무위키 참가팀 표의 행 배경색이다 — 주최 문서가 직접 매긴 순위이고
// 예선 탈락 단계까지 준다. 색이 없는 회차는 대진의 '결승'·'4강' 라운드에서 유도한다.
// 둘 다 안 되면 비워 둔다. 순위를 지어내지 않는다.

const wikiPlacements = (await fetchPlacements(season.namu[0])) ?? {};
const placements = {};
for (const [team, label] of Object.entries(wikiPlacements)) {
  // 결과표에 나온 팀은 그쪽 표기로 맞춘다. 안 나온 팀(=예선 탈락)은 맞출 대상이 없으니
  // 참가팀 표의 표기를 그대로 쓴다 — 예전엔 여기서 조용히 버려졌다.
  placements[canon.get(normTeam(team)) ?? team] = label;
}
const fromWiki = Object.keys(placements).length;

for (const r of resolved) {
  if (!r.winner) continue;                    // 무승부는 순위를 말해주지 않는다
  const loser = r.winner === r.a ? r.b : r.a;
  if (/결승|FINAL/i.test(r.round) && !/준결승/.test(r.round)) {
    placements[r.winner] ??= "우승";
    placements[loser] ??= "준우승";
  } else if (/4강|준결승/.test(r.round)) {
    placements[loser] ??= "4강";
  }
}
const fromBracket = Object.keys(placements).length - fromWiki;
console.log(
  `\n순위: 나무위키 색에서 ${fromWiki}팀` +
    (fromBracket > 0 ? ` + 대진에서 유도 ${fromBracket}팀` : "") +
    ` (참가팀 ${Object.keys(season.teams).length}개 중 · 그중 대진에 나온 팀 ${
      new Set(season.bouts.flatMap((b) => [b[2], b[3]])).size
    }개)`,
);

// ── 방송국 아이디 해석 → 기존 slug 재사용 또는 FA 로 신규 등록 ─────────

/**
 * SOOP 닉네임에서 **장식만** 떼어낸다 — 'BJ' 접두어, ♥ ^^ _ . ~ 같은 꾸밈 문자, 공백.
 * 옛 회차 로스터가 'BJ맛종욱'·'하이요♥'·'_구기리' 처럼 적혀 있어서 지금 표기와
 * 장식 하나 차이로 안 잡히는 일이 많다.
 */
const stripDeco = (s) => String(s)
  .replace(/^BJ\s*/i, "")
  .replace(/[♥♡★☆♬♪~!?:;,*`'"^_.\-\s]/g, "")
  .toLowerCase();

async function search(q) {
  const url =
    `${SOOP_SEARCH}?m=bjSearch&v=3.0&szOrder=&szKeyword=${encodeURIComponent(q)}&nPageNo=1&nListCnt=20`;
  try {
    const r = await soopFetch(url, { headers: { Referer: "https://www.sooplive.co.kr/" } });
    if (!r.ok) return [];
    return (await r.json())?.DATA ?? [];
  } catch {
    return [];
  }
}

/**
 * 닉네임 → 방송국 아이디. **유일하게 좁혀질 때만** 돌려준다.
 *
 * 1) 표기가 정확히 같은 게 하나면 그것 (가장 단단하다)
 * 2) 없으면 장식을 뗀 문자열로 다시 찾아, 장식을 떼고 같은 게 **하나뿐일 때만** 그것
 *
 * ★ 2)를 유일할 때만 받는 게 핵심이다. 'BJ이상호' 를 장식만 떼면 '이상호' 인데
 *   검색하면 lshooooo(이상호) 와 tlshtkw(이상호^) 둘이 나온다 — 둘 중 누구인지
 *   알 수 없으므로 **포기한다**. 여기서 하나를 고르면 남의 전적이 된다(§11-2).
 */
async function soopChannelId(nick) {
  const exact = (await search(nick)).filter((x) => x.user_nick === nick);
  if (exact.length === 1) return { id: exact[0].user_id, via: "exact", nick: exact[0].user_nick };

  const key = stripDeco(nick);
  if (!key) return null;
  const near = (await search(key)).filter((x) => stripDeco(x.user_nick) === key);
  if (near.length === 1) return { id: near[0].user_id, via: "deco", nick: near[0].user_nick };
  return null;
}

// FA 호출은 lib/soop-fa 가 단일 출처다 — 여기만 perPageNo 500 으로 남아
// 501번째 등록자부터 잘려 나가고 있었다(적대 리뷰에서 발견).
const faList = await fetchFaList(27);
// ★ 0건이면 멈춘다. 예전 코드는 응답 형태가 바뀌면 TypeError 로 죽어서 **아무 파일도
//   안 만들었는데**, lib 이 `?? []` 로 삼키게 되면서 그 안전망이 사라졌다.
//   그대로 두면 참가자 전원이 '근거 없음'으로 드롭된 채 시드 파일이 만들어진다 —
//   조용히 적게 가져오는 게 실패보다 나쁘다는 규칙에 정면으로 어긋난다.
//   같은 API 를 쓰는 build-soop-fa·identify-candidates 에는 이미 이 가드가 있다.
if (faList.length === 0) fail(["FA 명단이 0건이다 (API 형태 변경 의심). 시드를 만들지 않는다."]);
const fa = new Map(faList.map((f) => [f.userId, f]));

const sql = db();
const rows = await sql`
  select c.channel_id, s.slug from streamer_channel c join streamer s on s.id = c.streamer_id`;
// 나무위키 인물 문서 → slug. 옛 표기('BJ이상호')를 잇는 근거다.
// 출처가 직접 동일인이라고 말한 것만 쓴다 — npm run link:namu 가 채운다.
const slugByPage = new Map(
  (await sql`select namu_page, slug from streamer where namu_page is not null`)
    .map((r) => [r.namu_page, r.slug]),
);
await closeDb();
const personLinks = await fetchPersonLinks(season.namu[0]);
const known = new Map(rows.map((r) => [r.channel_id, r.slug]));
const slugSet = new Set(rows.map((r) => r.slug));
console.log(`\nFA 등록 ${faList.length}명 · 이미 등록된 방송국 ${known.size}개`);

const teams = {};
/**
 * slug → 로스터 포지션. 이게 없으면 대회 맞라인 전적이 통째로 안 생긴다 —
 * 한 경기에서 상대 5명 전부와 조우가 맺히는데, 그중 '같은 라인 1:1'은
 * 포지션을 알아야 가려낼 수 있다. 팀 대 팀 상대전적과 1:1 맞라인은 다른 사실이다.
 */
const positions = {};
/**
 * 한 대회에서 한 사람은 한 팀이다 — 스키마도 그렇다(`event_team_member` PK 는
 * `(event_id, streamer_id)`). 같은 사람이 두 팀에 나오면 나중 것이 앞의 것을
 * **조용히 덮어쓰고**, 하필 덮이는 쪽이 경기를 가진 본선 팀이면 그 사람의 대회
 * 기록이 통째로 사라진다. 실제로 그렇게 이상호의 2026 시즌1 본선 경기를 날렸다.
 * 먼저 배정된 쪽(= 손으로 적은 본선 명단이 앞에 온다)을 지키고, 뒤엣것은 버리되
 * **반드시 보고한다** — 조용히 버리면 출처가 어긋난 걸 아무도 모른다.
 */
const placedIn = new Map();
const dupPlaced = [];
const place = (team, slug, i) => {
  const prev = placedIn.get(slug);
  if (prev !== undefined) {
    if (prev !== team) dupPlaced.push(`${slug} — '${prev}' 에 이미 있는데 '${team}' 에도 나온다`);
    return false;
  }
  teams[team].push(slug);
  positions[slug] = POSITION[i];
  placedIn.set(slug, team);
  return true;
};
const newStreamers = [];
const dropped = [];
// 장식만 떼서 이어붙인 건 따로 남겨 사람이 훑어볼 수 있게 한다.
const decoMatched = [];
// 나무위키 인물 문서로 이어붙인 것 — 검토용으로 따로 남긴다.
const viaNamu = [];
let reused = 0;

for (const [team, members] of Object.entries(season.teams)) {
  teams[team] = [];
  for (const [i, nick] of members.entries()) {
    if (!nick) { dropped.push(`${team} [${POSITION[i]}] — 로스터 미상`); continue; }

    // 이미 등록된 사람은 slug 로 바로 적어도 된다. SOOP 표시명이 그새 바뀌었을 수 있어서,
    // 닉네임 검색에 의존하지 않는 경로를 남겨 둔다.
    if (slugSet.has(nick)) { if (place(team, nick, i)) reused++; continue; }

    // ★ 나무위키가 이 표기를 어느 인물 문서로 링크했고, 그 문서가 이미 우리 스트리머의
    //   것이면 그게 가장 단단한 근거다. SOOP 검색이 동명이인으로 갈리는 표기
    //   ('BJ이상호' → 다른 두 사람) 도 이걸로는 정확히 이어진다.
    const page = personLinks.get(nick);
    const byPage = page ? slugByPage.get(page) : null;
    if (byPage) {
      if (place(team, byPage, i)) {
        viaNamu.push(`${team} ${nick} → ${byPage} (문서 ${page})`);
        reused++;
      }
      continue;
    }

    const found = await soopChannelId(nick);
    if (!found) { dropped.push(`${team} ${nick} — SOOP 검색에서 단일 해석 실패`); continue; }
    const channelId = found.id;
    if (found.via === "deco") {
      decoMatched.push(`${team} ${nick} → ${channelId} (현재 표기 '${found.nick}')`);
    }

    const existing = known.get(channelId);
    if (existing) { if (place(team, existing, i)) reused++; continue; }

    const slug = ROMAN[nick];
    if (!slug) { dropped.push(`${team} ${nick} (${channelId}) — ROMAN 에 slug 가 없다`); continue; }
    const f = fa.get(channelId);
    if (!f) { dropped.push(`${team} ${nick} (${channelId}) — FA 등록에 없어 라이엇 ID 근거가 없다`); continue; }

    if (!place(team, slug, i)) continue;
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
            ` '${nick}' 과 방송국 아이디로 동일인 확인` +
            (found.via === "deco"
              ? ` (로스터 표기와 현재 표기가 장식만 다르다: '${nick}' ↔ '${found.nick}'.` +
                ` 장식을 떼고 유일하게 일치하는 방송국이 하나뿐이라 채택).`
              : `.`),
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
  const wWins = Math.max(r.wa, r.wb);
  const lWins = Math.min(r.wa, r.wb);
  // ★ 출처는 시리즈 스코어만 준다 — 세트별로 누가 이겼는지는 없다.
  //   그래서 승자 세트를 앞에 몰아 넣는다. 합계는 맞지만 **순서는 우리가 만든 것**이다.
  //   화면에서 '1세트 승 / 2세트 패' 식으로 보여주면 모르는 걸 아는 척하게 되므로
  //   세트 단위 목록은 두지 않는다 (마이그레이션 0009 주석 참고).
  //  세트별 승자가 출처에 있으면(2014~2017 의 O/X 표) 그 순서를 그대로 쓴다.
  //  없으면 승자 세트를 앞에 몰아 넣는다 — 합계는 맞지만 순서는 우리가 만든 것이다.
  const order = r.setWinners
    ? r.setWinners
    : [...Array(wWins).fill(r.winner), ...Array(lWins).fill(r.winner === r.a ? r.b : r.a)];
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
      (season.format === "table"
        ? `⚠ 이 회차는 조별 **풀리그**라 진출 경로로 승패를 유도할 수 없다(이겨도 져도 남은 경기를 다 치른다). ` +
          `그래서 근거가 나무위키 경기 결과표 한 곳뿐이다: ${(season.namu ?? []).map(namuUrl).join(" , ")}. `
        : `승패의 출처가 둘이고 서로 대조했다. (1) 공식 방송국 VOD 제목(${VODS})에서 복원한 대진 + ` +
          (season.format === "gsl"
            ? `GSL 진출 경로 유도(승자전=1·2경기 승자, 최종전=승자전 패자 vs 패자전 승자, 4강은 크로스). `
            : `더블 엘리미네이션 정합성(2패한 팀은 다시 나오지 않는다). `) +
          `(2) 나무위키 경기 결과표의 스코어: ${(season.namu ?? []).map(namuUrl).join(" , ")}. ` +
          `${resolved.length}경기 전건이 일치했다. `) +
      `전 경기 다전제라 스코어대로 세트 단위(총 ${totalGames}판)로 펴서 넣는다 — ` +
      `시리즈를 1판으로 적으면 판수가 틀리고 진 쪽이 딴 세트가 사라진다.` +
      (season.dates_unknown
        ? ` ⚠ 원본에 경기 날짜가 없어 ${season.dates_unknown}경기를 회차 시작일(${season.starts_at})로 통일했다 — 그 회차 안의 경기 순서·날짜는 신뢰할 수 없다.`
        : ``),
    teams,
    team_placements: Object.fromEntries(
      Object.keys(teams)
        .filter((t) => placements[t])
        .map((t) => [t, placements[t]]),
    ),
    roster_positions: positions,
    games,
  }], null, 2) + "\n",
);

console.log(`\n${outStreamers} — 신규 ${newStreamers.length}명 (기존 재사용 ${reused}명)`);
console.log(`${outTournament} — 팀 ${Object.keys(teams).length} · 경기 ${resolved.length} · 세트 ${games.length}판`);
if (dupPlaced.length) {
  console.log(
    `\n⚠ 한 대회에서 두 팀에 나온 참가자 ${dupPlaced.length}명 — 먼저 나온 팀만 남겼다.` +
      ` 출처가 어긋난 것이니 확인해라:`,
  );
  for (const d of dupPlaced) console.log(`   ${d}`);
}
if (viaNamu.length) {
  console.log(`\n· 나무위키 인물 문서로 이어붙인 참가자 ${viaNamu.length}명:`);
  for (const v of viaNamu) console.log(`   ${v}`);
}
if (decoMatched.length) {
  console.log(`\n· 장식(BJ 접두어·♥ ^^ _ 등)만 떼어 이어붙인 참가자 ${decoMatched.length}명 — 검토용:`);
  for (const d of decoMatched) console.log(`   ${d}`);
}
if (dropped.length) {
  console.log(`\n⚠ 근거가 없어 뺀 참가자 ${dropped.length}명:`);
  for (const d of dropped) console.log(`   ${d}`);
}
