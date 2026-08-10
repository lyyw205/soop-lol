/**
 * 2026 LoL 멸망전 시즌1 시드 생성 (스트리머 + 대회).
 *
 *   node scripts/build-meljang-2026-s1.mjs
 *     → seed/streamers-2026s1.json    (아직 없는 참가자만)
 *     → seed/tournaments-2026s1.json  (13경기)
 *
 * ── 이 회차의 승패를 어떻게 아는가 ───────────────────────────────────
 * 공식 VOD 제목은 대진(A vs B)과 라운드만 준다. 승패는 없다.
 * 그런데 이 회차는 **GSL 조별 + 4강 + 결승** 이고, GSL 은 진출 경로가 곧 결과다:
 *
 *   승자전 = 1경기 승자 vs 2경기 승자      → 1·2경기 승자가 정해진다
 *   패자전 = 1경기 패자 vs 2경기 패자      → 위와 모순이면 터진다 (검사)
 *   최종전 = 승자전 패자 vs 패자전 승자    → 승자전·패자전 승자가 정해진다
 *   4강 진출 = 승자전 승자(조1위) + 최종전 승자(조2위) → 최종전 승자가 정해진다
 *   4강 대진 = A조1위 vs B조2위 / B조1위 vs A조2위 (크로스) → 조 순위 교차검증
 *   결승 대진 = 4강 두 경기의 승자          → 4강 승자가 정해진다
 *
 * 13경기 중 12경기가 이렇게 **유도**된다. 남는 건 결승 승자 하나뿐이고,
 * 그건 언론 보도로 독립 확인한다(알아할게 3:1 팀 릴동파).
 * 아래 solve() 가 이 유도를 수행하면서 모순이 있으면 즉시 멈춘다.
 *
 * ── 계정 근거 ────────────────────────────────────────────────────────
 * 로스터의 닉네임을 라이엇 ID 로 간주하지 않는다(§11-2, seed/README.md 참고).
 * SOOP 검색 API 로 **방송국 아이디**를 얻고, 그 아이디로 SOOP 공식 FA 등록
 * (본인이 직접 입력한 라이엇 ID)을 찾아 쓴다. FA 에 없으면 넣지 않는다.
 */
import { writeFileSync } from "node:fs";

const OUT_STREAMERS = "seed/streamers-2026s1.json";
const OUT_TOURNAMENT = "seed/tournaments-2026s1.json";

const WIKI = "https://namu.wiki/w/2026%20LoL%20%EB%A9%B8%EB%A7%9D%EC%A0%84%20%EC%8B%9C%EC%A6%8C1";
const NEWS = "https://www.inven.co.kr/webzine/news/?news=314392&site=lol";
const VODS = "https://ch.sooplive.co.kr/lolbjmatch/vods";
const FA_PAGE = "https://bjmatchfa.sooplive.com/fa/27";
const FA_API = "https://gpapi.sooplive.com/api/v1/bjmatchfa/fa/list";
const SOOP_SEARCH = "https://sch.sooplive.co.kr/api.php";

// ── 로스터 (나무위키). 표기는 원문 그대로 ─────────────────────────────
const ROSTER = {
  "팀 릴동파": ["애디_", "봉준", "강만식", "한둬얼", "하하는하하루"],
  "왕밤빵이오": ["오리-3-", "피넛ㅁ", "박이언", "바밤바*", "나옹이빵"],
  "알아할게": ["항상#킴성태", "힐링동키", "권지인입니다", "나는상윤", "김야미♥"],
  "메가동하박스": ["칸_김동하", "주보리♥", "깐숙", "아이디_ID", "베르05"],
  "왜자꾸이기는건데": ["A-염보성!!", "이상호", "김민교.", "레이닝1", "애교용"],
  "샛수하밧누": ["히수레", "준밧드", "미누-", "하이브리드99", "임샛별♥"],
  "히어로즈": ["정현민.", "서도일", "R0se", "임아니", "김하선"],
  "사탄사용법": ["해기_", "승욱쨩", "존스미스1", "_오더", "성훈-"],
};

const POSITION = ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];

/** 닉네임 → slug. 이미 등록된 사람은 기존 slug 를 그대로 쓴다. */
const SLUG = {
  "애디_": "addy", "한둬얼": "handweoreol", "베르05": "ber05", "이상호": "leesangho",
  "김민교.": "kimmingyo", "준밧드": "junbad", "정현민.": "junghyunmin", "서도일": "seodoil",
  "임아니": "imani", "성훈-": "seonghun",

  "봉준": "bongjun", "강만식": "kangmansik", "하하는하하루": "hahaneunhaharu",
  "오리-3-": "ori3", "피넛ㅁ": "peanutm", "박이언": "parkieon", "바밤바*": "babamba",
  "나옹이빵": "naongibbang", "항상#킴성태": "kimseongtae", "힐링동키": "healingdonkey",
  "권지인입니다": "kwonjiin", "나는상윤": "naneunsangyun", "김야미♥": "kimyami",
  "칸_김동하": "kimdongha", "주보리♥": "jubori", "깐숙": "kkansuk", "아이디_ID": "aidi",
  "A-염보성!!": "yeomboseong", "레이닝1": "raining1", "애교용": "aegyoyong",
  "히수레": "hisure", "미누-": "minu", "하이브리드99": "hybrid99", "임샛별♥": "imsaetbyeol",
  "김하선": "kimhaseon", "해기_": "haegi", "승욱쨩": "seungwook",
  "존스미스1": "johnsmith1", "_오더": "order",
  // R0se 는 닉네임이 바뀌어 방송국 아이디를 특정하지 못했다 → 넣지 않는다.
};

// ── 대진 (공식 VOD 제목에서 복원) ─────────────────────────────────────
// [경기번호, 라운드, 팀A, 팀B, 날짜]  ※ 승자는 아래 solve() 가 유도한다
const BOUTS = [
  [1, "A조 1경기", "팀 릴동파", "왕밤빵이오", "2026-03-06"],
  [2, "A조 2경기", "메가동하박스", "알아할게", "2026-03-06"],
  [3, "B조 1경기", "왜자꾸이기는건데", "샛수하밧누", "2026-03-07"],
  [4, "B조 2경기", "히어로즈", "사탄사용법", "2026-03-07"],
  [5, "A조 승자전", "팀 릴동파", "알아할게", "2026-03-08"],
  [6, "A조 패자전", "왕밤빵이오", "메가동하박스", "2026-03-08"],
  [7, "B조 승자전", "샛수하밧누", "사탄사용법", "2026-03-09"],
  [8, "B조 패자전", "왜자꾸이기는건데", "히어로즈", "2026-03-10"],
  [9, "A조 최종전", "알아할게", "메가동하박스", "2026-03-10"],
  [10, "4강 1경기", "팀 릴동파", "히어로즈", "2026-03-11"],
  [11, "B조 최종전", "사탄사용법", "히어로즈", "2026-03-11"],
  [12, "4강 2경기", "샛수하밧누", "알아할게", "2026-03-12"],
  [13, "결승전", "팀 릴동파", "알아할게", "2026-03-14"],
];

/** 결승 승자만 외부 근거. 나머지는 유도한다. */
const FINAL_WINNER = "알아할게";

// ── 승패 유도 ─────────────────────────────────────────────────────────

const err = [];
const bout = (round) => BOUTS.find((b) => b[1] === round);
const pair = (round) => {
  const b = bout(round);
  if (!b) err.push(`대진에 '${round}' 이 없다`);
  return b ? [b[2], b[3]] : [];
};
/** xs 중 ys 에 든 것 하나를 고른다. 정확히 하나가 아니면 모순이다. */
const only = (xs, ys, why) => {
  const hit = xs.filter((x) => ys.includes(x));
  if (hit.length !== 1) {
    err.push(`${why}: ${xs.join("/")} 중 ${ys.join("/")} 에 든 것이 ${hit.length}개 (1개여야 한다)`);
    return null;
  }
  return hit[0];
};
const other = (p, x) => (p[0] === x ? p[1] : p[0]);

const winner = new Map(); // round → 팀명
const standing = new Map(); // '<조>1위' | '<조>2위' → 팀명

for (const g of ["A", "B"]) {
  const m1 = pair(`${g}조 1경기`);
  const m2 = pair(`${g}조 2경기`);
  const wb = pair(`${g}조 승자전`);
  const lb = pair(`${g}조 패자전`);
  const fin = pair(`${g}조 최종전`);
  if ([m1, m2, wb, lb, fin].some((p) => p.length !== 2)) continue;

  // 승자전 참가자 = 1·2경기 각각의 승자
  const w1 = only(m1, wb, `${g}조 1경기 승자`);
  const w2 = only(m2, wb, `${g}조 2경기 승자`);
  if (!w1 || !w2) continue;
  winner.set(`${g}조 1경기`, w1);
  winner.set(`${g}조 2경기`, w2);

  // 패자전 참가자는 1·2경기의 패자여야 한다 — 여기서 어긋나면 대진 복원이 틀린 것
  const wantLb = [other(m1, w1), other(m2, w2)].sort();
  if (JSON.stringify([...lb].sort()) !== JSON.stringify(wantLb)) {
    err.push(`${g}조 패자전이 '${lb.join(" vs ")}' 인데 1·2경기 패자는 '${wantLb.join(" vs ")}' 다`);
    continue;
  }

  // 최종전 = 승자전 패자 vs 패자전 승자
  const wbLoser = only(wb, fin, `${g}조 승자전 패자`);
  const lbWinner = only(lb, fin, `${g}조 패자전 승자`);
  if (!wbLoser || !lbWinner) continue;
  winner.set(`${g}조 승자전`, other(wb, wbLoser));
  winner.set(`${g}조 패자전`, lbWinner);
  standing.set(`${g}1위`, other(wb, wbLoser));

  // 조 2위 = 최종전 승자 = 4강에 나오는 쪽
  const semi = [...pair("4강 1경기"), ...pair("4강 2경기")];
  const second = only(fin, semi, `${g}조 최종전 승자(4강 진출)`);
  if (!second) continue;
  winner.set(`${g}조 최종전`, second);
  standing.set(`${g}2위`, second);
}

// 4강은 조 1위 × 다른 조 2위 크로스여야 한다
const s1 = pair("4강 1경기");
const s2 = pair("4강 2경기");
const cross = [
  [standing.get("A1위"), standing.get("B2위")],
  [standing.get("B1위"), standing.get("A2위")],
];
const asSet = (p) => JSON.stringify([...p].sort());
if (cross.every((c) => c.every(Boolean))) {
  const want = cross.map(asSet).sort();
  const got = [s1, s2].map(asSet).sort();
  if (JSON.stringify(want) !== JSON.stringify(got)) {
    err.push(`4강 대진이 크로스와 다르다 — 실제 ${got.join(" | ")} / 기대 ${want.join(" | ")}`);
  }
}

// 결승 참가자 = 4강 두 경기의 승자
const fin = pair("결승전");
const f1 = only(s1, fin, "4강 1경기 승자");
const f2 = only(s2, fin, "4강 2경기 승자");
if (f1) winner.set("4강 1경기", f1);
if (f2) winner.set("4강 2경기", f2);
if (!fin.includes(FINAL_WINNER)) err.push(`결승 승자 '${FINAL_WINNER}' 가 결승 대진에 없다`);
winner.set("결승전", FINAL_WINNER);

for (const [, round] of BOUTS.map((b) => [b[0], b[1]])) {
  if (!winner.has(round)) err.push(`'${round}' 의 승자를 유도하지 못했다`);
}
if (err.length) {
  console.error("대진/승패 유도 실패:\n" + err.map((e) => "  ✖ " + e).join("\n"));
  process.exit(1);
}
console.log(`승패 유도 OK — ${BOUTS.length}경기 중 ${BOUTS.length - 1}경기 유도 + 결승 1경기 외부 근거`);
for (const [, round, a, b] of BOUTS) {
  console.log(`  ${round.padEnd(11)} ${a} vs ${b} → ${winner.get(round)} 승`);
}

// ── SOOP 방송국 아이디 해석 → FA 등록에서 라이엇 ID ────────────────────

async function soopChannelId(nick) {
  const url = `${SOOP_SEARCH}?m=bjSearch&v=3.0&szOrder=&szKeyword=${encodeURIComponent(nick)}&nPageNo=1&nListCnt=10`;
  const r = await fetch(url, { headers: { Referer: "https://www.sooplive.co.kr/" } });
  if (!r.ok) return null;
  const rows = (await r.json())?.DATA ?? [];
  const exact = rows.filter((x) => x.user_nick === nick);
  return exact.length === 1 ? exact[0].user_id : null; // 동명이인이면 포기한다
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
console.log(`\nFA 등록 ${faList.length}명 조회`);

const KNOWN = new Set(["addy", "handweoreol", "ber05", "leesangho", "kimmingyo",
  "junbad", "junghyunmin", "seodoil", "imani", "seonghun"]);

const teams = {};
const newStreamers = [];
const dropped = [];

for (const [team, members] of Object.entries(ROSTER)) {
  teams[team] = [];
  for (const [i, nick] of members.entries()) {
    const slug = SLUG[nick];
    if (!slug) { dropped.push(`${team} ${nick} — 방송국 아이디 미상`); continue; }
    teams[team].push(slug);
    if (KNOWN.has(slug)) continue;

    const channelId = await soopChannelId(nick);
    await new Promise((s) => setTimeout(s, 250));
    if (!channelId) { dropped.push(`${team} ${nick} — SOOP 검색에서 단일 해석 실패`); teams[team].pop(); continue; }
    const f = fa.get(channelId);
    if (!f) { dropped.push(`${team} ${nick} (${channelId}) — FA 등록에 없어 라이엇 ID 근거가 없다`); teams[team].pop(); continue; }

    const riotIds = (f.totalGameNickList?.length ? f.totalGameNickList : [f.gameNick]).filter(Boolean);
    newStreamers.push({
      slug,
      display_name: nick,
      platform: "soop",
      channel_id: channelId,
      channel_url: `https://ch.sooplive.co.kr/${channelId}`,
      note: `2026 LoL 멸망전 시즌1 '${team}' ${POSITION[i]}`,
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
            ` SOOP 표기 '${riot_id}'. 2026 시즌1 로스터(${WIKI})의 '${nick}' 과 방송국 아이디로 동일인 확인.`,
        },
      })),
    });
    console.log(`  ➕ ${slug.padEnd(15)} ${nick.padEnd(13)} ${channelId.padEnd(14)} ${riotIds.join(", ")}`);
  }
}

const games = BOUTS.map(([no, round, a, b, date]) => ({
  id: `g${String(no).padStart(2, "0")}`,
  round,
  played_at: `${date}T19:00:00+09:00`,
  blue: a,
  red: b,
  winner: winner.get(round),
  source_url: VODS,
}));

writeFileSync(OUT_STREAMERS, JSON.stringify(newStreamers, null, 2) + "\n");
writeFileSync(
  OUT_TOURNAMENT,
  JSON.stringify([{
    slug: "meljang-2026-s1",
    name: "2026 LoL 멸망전 시즌1",
    kind: "tournament",
    organizer: "SOOP",
    starts_at: "2026-03-06",
    ends_at: "2026-03-14",
    source_url: WIKI,
    "//승패근거":
      `대진은 공식 방송국 VOD 제목(${VODS})에서 복원. 승패는 GSL 조별리그의 진출 경로로 ` +
      `13경기 중 12경기가 유도된다(승자전=1·2경기 승자, 최종전=승자전 패자 vs 패자전 승자, ` +
      `4강 진출=조 1·2위, 4강은 크로스). 결승 승자만 언론으로 독립 확인: ${NEWS}`,
    teams,
    games,
  }], null, 2) + "\n",
);

console.log(`\n${OUT_STREAMERS} — 신규 스트리머 ${newStreamers.length}명`);
console.log(`${OUT_TOURNAMENT} — 팀 ${Object.keys(teams).length} · 경기 ${games.length}`);
if (dropped.length) {
  console.log(`\n⚠ 근거가 없어 뺀 참가자 ${dropped.length}명:`);
  for (const d of dropped) console.log(`   ${d}`);
}
