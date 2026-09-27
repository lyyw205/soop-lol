/**
 * 2026 LoL 멸망전 with Gen.G 시드 생성.
 *
 * 승패의 근거: 더블 엘리미네이션은 **진출 경로가 곧 결과**다.
 * 승자조 1라운드의 승자만 승자조 2라운드에 나타나고 패자는 패자조 1라운드로 떨어진다.
 * 공식 VOD 제목에서 뽑은 14경기 대진이 이 규칙과 모순 없이 맞물리고,
 * 결승 승자는 뉴스로 독립 확인된다(교권보호국 우승).
 */
import { writeFileSync } from "node:fs";

// ★ 절대경로를 박아 두면 이 저장소를 받은 다른 사람 기계에서 안 돈다.
//   시드 파일은 gitignore 라 **이 빌더가 유일한 재현 경로**인데, 그게 내 기계에서만
//   돌면 재현이 아니다.
const OUT = new URL("../seed/tournaments-meljang-2026-geng.json", import.meta.url).pathname;
const WIKI = "https://namu.wiki/w/2026%20LoL%20%EB%A9%B8%EB%A7%9D%EC%A0%84%20with%20Gen.G";
const NEWS = "https://www.betanews.net/article/view/beta202608030040";
const VODS = "https://ch.sooplive.co.kr/lolbjmatch/vods";

const teams = {
  "교권보호국": ["nyongi", "clid1", "kimmingyo", "kimrain", "ber05"],
  "딕닦꺼 브라더즈": ["junghyunmin", "junbad", "jangjisu", "handweoreol", "kimgugeogugeo"],
  "명 수": ["smebim", "seodoil", "haku", "urimming", "annyeongsuya"],
  "막차타요": ["ssodaejang", "natali", "minchangi", "danuri", "rakoxd"],
  "노종뀨뀨낭": ["shacotime0", "jungyunjong", "kkyuppi", "okkyu", "maunang"],
  "임부장": ["baekjirago", "yeongjae", "kimjinsol", "imani", "ppuri"],
  "저로듀스lol": ["addy", "jeoradet", "eunaengi", "mingjuindeyo", "huijinirago"],
  "고점폭발": ["rancho", "leesangho", "ivory", "sangeonyeo", "seonghun"],
};

// [경기번호, 라운드, 팀A, 팀B, 승자, 날짜]
const raw = [
  [1,  "승자조 1라운드",  "명 수",          "노종뀨뀨낭",       "노종뀨뀨낭",       "2026-07-19"],
  [2,  "승자조 1라운드",  "막차타요",        "저로듀스lol",     "막차타요",        "2026-07-19"],
  [3,  "승자조 1라운드",  "교권보호국",       "임부장",         "교권보호국",       "2026-07-20"],
  [4,  "승자조 1라운드",  "딕닦꺼 브라더즈",   "고점폭발",        "고점폭발",        "2026-07-21"],
  [5,  "승자조 2라운드",  "노종뀨뀨낭",       "막차타요",        "막차타요",        "2026-07-22"],
  [6,  "패자조 1라운드",  "명 수",          "저로듀스lol",     "저로듀스lol",     "2026-07-23"],
  [7,  "승자조 2라운드",  "교권보호국",       "고점폭발",        "고점폭발",        "2026-07-23"],
  [8,  "패자조 1라운드",  "임부장",         "딕닦꺼 브라더즈",   "딕닦꺼 브라더즈",   "2026-07-23"],
  [9,  "패자조 2라운드",  "노종뀨뀨낭",       "저로듀스lol",     "노종뀨뀨낭",      "2026-07-24"],
  [10, "패자조 2라운드",  "교권보호국",       "딕닦꺼 브라더즈",   "교권보호국",      "2026-07-26"],
  [11, "승자조 3라운드",  "막차타요",        "고점폭발",        "고점폭발",        "2026-07-26"],
  [12, "패자조 3라운드",  "노종뀨뀨낭",       "교권보호국",       "교권보호국",      "2026-07-27"],
  [13, "패자조 4라운드",  "막차타요",        "교권보호국",       "교권보호국",      "2026-07-28"],
  [14, "결승", "고점폭발",        "교권보호국",       "교권보호국",      "2026-08-01"],
];

// ── 무결성 검사: 진출 경로가 승패와 모순이 없는지 ──────────────────
const eliminated = new Set();
const errors = [];
for (const [no, round, a, b, w] of raw) {
  if (![a, b].includes(w)) errors.push(`경기 ${no}: 승자 '${w}' 가 대진에 없다`);
  for (const t of [a, b]) {
    if (!teams[t]) errors.push(`경기 ${no}: 팀 '${t}' 이 로스터에 없다`);
    if (eliminated.has(t)) errors.push(`경기 ${no}: '${t}' 은 이미 2패로 탈락했는데 다시 나온다`);
  }
  const loser = w === a ? b : a;
  if (round.startsWith("패자조") || round === "결승") eliminated.add(loser);
}
if (errors.length) {
  console.error("대진 정합성 오류:\n" + errors.map((e) => "  ✖ " + e).join("\n"));
  process.exit(1);
}
console.log(`대진 정합성 OK — 14경기, 최종 탈락 ${eliminated.size}팀`);

const games = raw.map(([no, round, a, b, w, date]) => ({
  id: `g${String(no).padStart(2, "0")}`,
  // 공식 경기 번호를 붙인다(VOD 제목 "UB 1R 1경기"). 결승은 제목에도 번호가 없다.
  round: round === "결승" ? round : `${round} · ${no}경기`,
  played_at: `${date}T20:00:00+09:00`,
  blue: a,
  red: b,
  winner: w,
  source_url: VODS,
}));

const doc = [{
  slug: "meljang-2026-geng",
  name: "2026 LoL 멸망전 with Gen.G",
  kind: "tournament",
  organizer: "SOOP",
  starts_at: "2026-07-19",
  ends_at: "2026-08-01",
  source_url: WIKI,
  "//승패근거": `대진은 공식 방송국 VOD 제목(${VODS})에서 복원. 승패는 더블 엘리미네이션의 ` +
    `진출 경로로 결정된다(승자조 승자만 다음 승자조 라운드에 나타난다). 결승 승자는 뉴스로 독립 확인: ${NEWS}`,
  teams,
  games,
}];

writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");
console.log(`seed/tournaments.json 생성 — 팀 ${Object.keys(teams).length} · 경기 ${games.length}`);
