/**
 * 나무위키 대회 문서에서 경기별 [팀A, 점수A, 점수B, 팀B] 를 읽는다.
 *
 * ★ 요약 모델을 거치지 않는다. 나무위키는 원문 HTML 을 그대로 준다.
 *   산문을 요약시키면 스코어 좌우가 뒤집혀 읽히는 일이 실제로 있었다
 *   (2025 시즌2 우승팀이 반대로 나왔다). 표를 직접 읽는다.
 *
 * 경기 결과표를 평문으로 펴면 이 모양이다:
 *   8강 A조 1경기 (2025. 3. 19.) | 상황파악끄읏 | 2 | 0 | 중증매장센터 | O | O | X | X
 * 즉 [팀A, 점수A, 점수B, 팀B] 가 연달아 나온다. 이 패턴만 잡는다.
 */

const UA = "Mozilla/5.0 (X11; Linux x86_64)";

export function namuUrl(title) {
  return `https://namu.wiki/w/${encodeURIComponent(title).replace(/%2F/g, "/")}`;
}

const decode = (s) =>
  s
    .replace(/&#91;/g, "[").replace(/&#93;/g, "]").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));

// 팀명이 숫자로 시작할 수 있다 — '1.단애디를던져', '2모 3촌', '4:5:1'.
// 그래서 '숫자로 시작'이 아니라 '순수한 숫자'만 걸러낸다.
// 화살표(◀ ▶)와 조회수('… ) 2.8K')는 표가 아니라 네비게이션/메타라 걸러낸다.
// 승패 표시 기호(○ × 등)가 팀명 자리에 오면 없는 팀이 만들어진다.
const NOISE = new Set(["-", "–", "—", "◀", "▶", "…", "|",
  "○", "◯", "〇", "●", "×", "✕", "X", "x", "O", "△"]);
const isScore = (s) => /^\d$/.test(s); // 다전제 스코어는 한 자리다
// 2014~2017 회차는 세트마다 O/X 를 적고 마지막에 승/무/패를 적는다.
const isOx = (s) => s === "O" || s === "X" || s === "○" || s === "×";
const isOutcome = (s) => s === "승" || s === "패" || s === "무";
// 단판 풀리그는 숫자 대신 승/패 로 적혀 있다 — '감묻은마을 | 패 | 승 | 초보원딜녀'
const WL = { "승": 1, "패": 0, "W": 1, "L": 0 };
const isWl = (s) => s in WL;
// 순위표에는 'vs 라스투댄스', '+4'(득실), '2 : 0'(세트 합계) 같은 칸이 섞여 있다.
// 팀명이 아니라 요약 지표라 걸러야 한다 — 안 그러면 없는 팀이 대진에 생긴다.
const isTeam = (s) =>
  s.length >= 1 && s.length <= 24 &&
  !NOISE.has(s) && !/[)(\]]/.test(s) && !/\d+(\.\d+)?[KM]$/.test(s) &&
  !/^[\d\s.]+$/.test(s) && !/\//.test(s) && !/^\s*\d+\s*:\s*\d+\s*$/.test(s) &&
  !/^(vs|VS)\s/.test(s) && !/^[+\-]\d+$/.test(s) && !/:/.test(s) &&
  !/\d+\s*년|\d+\s*월|\d+\s*일|요일/.test(s) &&   // '2024년 9월 15일 일요일' 같은 날짜 칸
  !/^(1|2|3|4|5)세트$/.test(s) &&
  !/^(WIN|LOSE|밴|픽|결과|편집|O|X|경기|세트|다시보기|하이라이트)$/i.test(s);

/** 문서 하나에서 경기 목록을 뽑는다. 문서가 없으면 빈 배열. */
export async function fetchSeries(title) {
  const res = await fetch(namuUrl(title), { headers: { "User-Agent": UA } });
  if (!res.ok) return { title, ok: false, series: [] };
  const html = await res.text();

  const lines = decode(html.replace(/<[^>]+>/g, "\n"))
    .split("\n").map((s) => s.trim()).filter(Boolean);

  // 절마다 '날짜 : 2022년 4월 6일' 이 앞서 나온다. 가장 가까운 것을 그 경기의 날짜로 쓴다.
  const dateAt = [];
  let cur = null;
  for (const [i, l] of lines.entries()) {
    // 회차마다 표기가 다르다: '2022년 4월 6일' · '날짜: 2020-3-12' · '2020.03.13'
    const m = /(20\d\d)\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(l)
      ?? /(20\d\d)[-.](\d{1,2})[-.](\d{1,2})(?!\d)/.exec(l);
    if (m) cur = `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
    dateAt[i] = cur;
  }

  /** 앞쪽에서 라운드 이름을 찾는다. 없으면 표가 아니라 네비게이션이다. */
  const roundOf = (ls, i) => {
    const hit = ls.slice(Math.max(0, i - 30), i).reverse().find((c) =>
      /(\d+경기|\d+라운드|\d+일차|조별리그|승자전|패자전|최종전|결승|4강|8강|10강|준결승|플레이오프|UB\s*\d|LB\s*\d)/.test(c),
    );
    return hit
      ? hit.replace(/\s*\([^)]*\)\s*$/, "").replace(/^\d{4}\s+LoL\s+[^\s]+\s+\S+\s*/i, "").trim()
      : null;
  };

  const raw = [];
  for (let i = 0; i + 3 < lines.length; i++) {
    // 배치가 두 가지다:
    //   (1) 팀A | 점수A | 점수B | 팀B      — 조별·일반 결과표
    //   (2) 점수A | 점수B | 팀A | 팀B      — 결승 배너 (앞에 날짜가 온다)
    const numeric = isScore(lines[i + 1]) && isScore(lines[i + 2]);
    const winLose = isWl(lines[i + 1]) && isWl(lines[i + 2]);
    let a, b, sa, sb;
    if (numeric || winLose) {
      [a, b] = [lines[i], lines[i + 3]];
      sa = numeric ? Number(lines[i + 1]) : WL[lines[i + 1]];
      sb = numeric ? Number(lines[i + 2]) : WL[lines[i + 2]];
    } else if (isScore(lines[i]) && isScore(lines[i + 1]) && !isScore(lines[i + 2])) {
      [a, b] = [lines[i + 2], lines[i + 3]];
      sa = Number(lines[i]);
      sb = Number(lines[i + 1]);
    } else if (isOx(lines[i + 1])) {
      // (4) 팀A | O | X | 무 | 팀B | X | O | 무   — 2014~2017 회차의 세트별 O/X 표
      //     세트마다 O/X 가 있어 **어느 세트를 이겼는지까지** 알 수 있다.
      //     2세트제라 1승 1패로 끝나는 '무' 가 존재한다 — 다른 회차엔 없는 결과다.
      const runA = [];
      let k = i + 1;
      while (isOx(lines[k])) runA.push(lines[k++]);
      if (!isOutcome(lines[k])) continue;
      const bAt = k + 1;
      if (!isTeam(lines[bAt])) continue;
      const runB = [];
      let k2 = bAt + 1;
      while (isOx(lines[k2])) runB.push(lines[k2++]);
      if (runB.length !== runA.length || runA.length === 0) continue;
      a = lines[i];
      b = lines[bAt];
      sa = runA.filter((x) => x === "O").length;
      sb = runB.filter((x) => x === "O").length;
      if (sa + sb !== runA.length) continue;   // O/X 가 서로 어긋나면 표를 잘못 읽은 것
      if (!isTeam(a) || a === b) continue;
      // 세트마다 O/X 가 있으니 **어느 세트를 누가 이겼는지**까지 그대로 넘긴다.
      // 다른 회차는 시리즈 스코어만 있어 세트 순서를 우리가 지어내야 하는데,
      // 이 회차들은 진짜 순서를 알 수 있다.
      raw.push({
        // O/X 표는 패턴이 워낙 구체적이라 라운드 이름이 없어도 표가 맞다.
        // 빈 문자열로 두고, 짝짓기는 대진으로 한다.
        round: roundOf(lines, i) ?? "", a, sa, sb, b,
        date: dateAt[i] ?? null,
        drawn: sa === sb,
        setWinners: runA.map((x) => (x === "O" || x === "○" ? a : b)),
      });
      continue;
    } else if (isWl(lines[i + 1]) && isWl(lines[i + 3]) && lines[i + 1] !== lines[i + 3]) {
      // (3) 팀A | 승 | 팀B | 패  — 2021 이전 회차의 '팀명/결과' 표
      [a, b] = [lines[i], lines[i + 2]];
      sa = WL[lines[i + 1]];
      sb = WL[lines[i + 3]];
    } else continue;
    if (!isTeam(a) || !isTeam(b) || a === b) continue;
    if (sa === sb) continue;                       // 무승부는 없다
    if (Math.max(sa, sb) > 3 || Math.max(sa, sb) < 1) continue;

    // 앞쪽에서 라운드 이름을 찾는다. 없으면 표가 아니라 네비게이션이라 버린다.
    const hit = lines.slice(Math.max(0, i - 30), i).reverse().find((c) =>
      /(\d+경기|\d+라운드|\d+일차|조별리그|승자전|패자전|최종전|결승|4강|8강|10강|준결승|플레이오프|UB\s*\d|LB\s*\d)/.test(c),
    );
    if (!hit) continue;
    const round = hit
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replace(/^\d{4}\s+LoL\s+[^\s]+\s+\S+\s*/i, "")
      .trim();
    raw.push({ round, a, sa, sb, b, date: dateAt[i] ?? null });
  }

  // ── (5) RESULT 행 ─────────────────────────────────────────────────
  //   팀A | vs | 팀B
  //   X | MATCH 1 | O   …
  //   패 | 0 | RESULT | 2 | 승
  // 2020 앙코르 이벤트전이 이 모양이다. RESULT 양옆이 곧 스코어다.
  for (let i = 1; i + 1 < lines.length; i++) {
    if (lines[i] !== "RESULT") continue;
    const sa = Number(lines[i - 1]);
    const sb = Number(lines[i + 1]);
    if (!Number.isInteger(sa) || !Number.isInteger(sb) || sa === sb) continue;
    if (Math.max(sa, sb) > 5) continue;
    // 뒤로 훑어 'A | vs | B' 를 찾는다
    let a = null;
    let b = null;
    for (let j = i - 2; j > Math.max(0, i - 40); j--) {
      if (lines[j] === "vs" && isTeam(lines[j - 1]) && isTeam(lines[j + 1])) {
        a = lines[j - 1];
        b = lines[j + 1];
        break;
      }
    }
    if (!a || !b || a === b) continue;
    raw.push({ round: roundOf(lines, i) ?? "", a, sa, sb, b, date: dateAt[i] ?? null });
  }

  // ── (6) 행렬형 표 ─────────────────────────────────────────────────
  //   구분 | 1경기 | 2경기 | 승자전 | 패자전 | 최종전
  //   팀   | <팀들…>      ← 팀명이 <br> 로 쪼개져 여러 줄이 된다
  //   승리팀| <승자들…>
  // 2019 시즌3 의 8강이 이 모양이다. 쪼개진 조각을 **문서에 실제로 있는 팀 이름**과
  // 맞춰 되붙인다 — 조각만 보고 팀을 만들어내지 않는다.
  const known = knownTeamNames(lines);
  if (known.size > 0) {
    for (let i = 0; i + 2 < lines.length; i++) {
      if (lines[i] !== "구분") continue;
      const rounds = [];
      let j = i + 1;
      while (j < lines.length && lines[j] !== "팀") rounds.push(lines[j++]);
      if (lines[j] !== "팀") continue;
      const teamTok = [];
      let k = j + 1;
      while (k < lines.length && lines[k] !== "승리팀") teamTok.push(lines[k++]);
      if (lines[k] !== "승리팀") continue;
      const winTok = [];
      let m = k + 1;
      while (m < lines.length && winTok.length < rounds.length * 3 && !/경기 밴픽|다시보기/.test(lines[m])) {
        winTok.push(lines[m++]);
      }
      const pairs = joinTeams(teamTok, known);
      const wins = joinTeams(winTok, known);
      if (pairs.length !== rounds.length * 2 || wins.length < rounds.length) continue;
      for (const [n, round] of rounds.entries()) {
        const a = pairs[n * 2];
        const b = pairs[n * 2 + 1];
        const w = wins[n];
        if (!a || !b || a === b || (w !== a && w !== b)) continue;
        // 이 표는 승자만 준다. 세트 스코어가 없으므로 단판으로 넣는다 —
        // 실제로 이 회차의 조별 경기는 밴픽 표가 경기당 하나뿐이라 단판이 맞다.
        raw.push({
          round, a, b, sa: w === a ? 1 : 0, sb: w === b ? 1 : 0,
          date: dateAt[i] ?? null,
        });
      }
    }
  }

  const seen = new Map();
  for (const r of raw) {
    const k = `${r.round}|${r.a}|${r.b}|${r.sa}|${r.sb}`;
    if (!seen.has(k)) seen.set(k, r);
  }
  return { title, ok: true, series: [...seen.values()] };
}

/** 여러 문서(본문·8강·승자조…)를 합친다. */
export async function fetchAllSeries(titles) {
  const out = [];
  const missing = [];
  for (const t of titles) {
    const r = await fetchSeries(t);
    if (!r.ok) missing.push(t);
    out.push(...r.series);
    await new Promise((s) => setTimeout(s, 300));
  }
  return { series: out, missing };
}

/** 팀 두 개(순서 무관)로 경기를 찾는다. */
export function findSeries(series, a, b) {
  const key = [a, b].sort().join(" ");
  const hits = series.filter((s) => [s.a, s.b].sort().join(" ") === key);
  return hits;
}

/** 목차만 뽑는다 (구조 파악용). 문서가 없으면 null. */
export async function fetchToc(title) {
  const res = await fetch(namuUrl(title), { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const html = await res.text();
  return [...html.matchAll(/<a href=['"]#s-([\d.]+)['"][^>]*>[\d.]+<\/a>\.\s*([^<]{1,80})<\/span>/g)]
    .map((m) => ({ no: m[1], depth: m[1].split(".").length, text: decode(m[2]).trim() }));
}

/**
 * 참가팀 로스터를 뽑는다 — `TEAM | TOP | JGL | MID | BOT | SUP` 표.
 *
 * ★ 포지션이 필요한 이유: 이게 없으면 대회 맞라인 전적이 통째로 안 생긴다.
 *   한 경기에서 상대 5명 모두와 조우가 맺히는데, 그중 "같은 라인에서 맞붙은 1:1"은
 *   포지션을 알아야 가려낼 수 있다. 팀 대 팀 상대전적과 1:1 맞라인은 다른 사실이다.
 *
 * 나무위키 표는 여섯 칸이 한 줄이라 평문으로 펴면 6개씩 끊어 읽으면 된다.
 * 헤더가 정확히 6칸인 표만 쓴다 — 투표 순위 같은 칸이 붙은 표는 열 수가 달라
 * 잘못 끊긴다.
 */
export async function fetchRosters(title) {
  const res = await fetch(namuUrl(title), { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const html = await res.text();
  const lines = decode(html.replace(/<[^>]+>/g, "\n"))
    .split("\n").map((s) => s.trim()).filter(Boolean);

  const JGL = new Set(["JGL", "JUG", "JUNGLE", "정글"]);
  const SUP = new Set(["SUP", "SPT", "SUPPORT", "서포터"]);
  const looksLikeName = (s) =>
    s.length >= 1 && s.length <= 24 && !/^\d+위$/.test(s) &&
    !/^(편집|본선|예선|진출|탈락|TEAM|TOP|MID|BOT)$/.test(s) &&
    !JGL.has(s) && !SUP.has(s) && !/^\[\d+\]$/.test(s);

  let start = -1;
  for (let i = 0; i + 5 < lines.length; i++) {
    if (
      lines[i] === "TEAM" && lines[i + 1] === "TOP" && JGL.has(lines[i + 2]) &&
      lines[i + 3] === "MID" && lines[i + 4] === "BOT" && SUP.has(lines[i + 5])
    ) { start = i + 6; break; }
  }
  // 한 줄 표가 없으면 **팀마다 블록**인 형식을 본다 (2020 회차):
  //   팀명 | 닉네임 | LoL 티어 | TOP | <닉> | <티어> | JUNGLE | <닉> | <티어> | …
  if (start < 0) return blockRosters(lines, JGL, SUP);

  // 각주 표시([1])와 겸업 표기(탑/정글)가 칸 사이에 끼어 있다. 빼야 6칸으로 끊긴다.
  const ROLE = /^(탑|정글|미드|원딜|바텀|서폿|서포터)(\/(탑|정글|미드|원딜|바텀|서폿|서포터))+$/;
  // 각주([1])와 조 표시([A]) 처럼 **괄호만 있는 짧은 토큰**은 칸이 아니라 표시다.
  // '[BJ]테리' 처럼 뒤에 이름이 붙은 건 진짜 닉네임이라 남긴다.
  const cells = lines.slice(start).filter((s) => !/^\[[^\]]{1,3}\]$/.test(s) && !ROLE.test(s));

  const teams = {};
  for (let i = 0; i + 5 < cells.length; i += 6) {
    const row = cells.slice(i, i + 6);
    if (!row.every(looksLikeName)) break;
    if (/^[\d.]+$/.test(row[0])) break;   // 점수표가 섞여 들어온 것
    const [team, ...members] = row;
    if (teams[team]) break;              // 같은 표가 두 번 잡히면 거기서 멈춘다
    teams[team] = members;
  }
  return Object.keys(teams).length > 0 ? teams : null;
}

/**
 * 팀명 표기 흔들림을 흡수한다.
 * 같은 대회 안에서도 '하마가…말대꾸?' 와 '하마가...말대꾸?', '너만오면고' 와
 * '너만오면 고' 가 섞여 있다. 공백과 말줄임표만 맞춰도 대부분 붙는다.
 */
export function normTeam(s) {
  return String(s).replace(/\s+/g, "").replace(/[…⋯]/g, "...").replace(/[·ㆍ]/g, "");
}

/** 팀마다 (포지션, 닉네임, 티어) 블록으로 적힌 형식 (2020 회차). */
function blockRosters(lines, JGL, SUP) {
  const order = ["TOP", "JGL", "MID", "BOT", "SUP"];
  const kindOf = (s) =>
    s === "TOP" || s === "탑" ? "TOP" :
    JGL.has(s) ? "JGL" :
    s === "MID" || s === "미드" ? "MID" :
    s === "BOT" || s === "ADC" || s === "AD" || s === "원딜" || s === "바텀" ? "BOT" :
    SUP.has(s) ? "SUP" : null;

  const teams = {};
  for (let i = 1; i + 2 < lines.length; i++) {
    if (lines[i] !== "닉네임" || !/티어/.test(lines[i + 1] ?? "")) continue;
    const team = lines[i - 1];
    if (!team || team.length > 24) continue;
    const slot = {};
    for (let j = i + 2; j + 2 < lines.length; j += 3) {
      const k = kindOf(lines[j]);
      if (!k) break;
      slot[k] = lines[j + 1];
    }
    if (Object.keys(slot).length >= 3) teams[team] = order.map((k) => slot[k] ?? null);
  }
  return Object.keys(teams).length > 0 ? teams : null;
}

/**
 * 참가팀 표의 **행 배경색**에서 순위를 읽는다.
 *
 * 나무위키 대회 문서는 참가팀 표 위에 범례를 둔다:
 *   ■우승 ■준우승 ■4강 ■8강 ■2차예선 탈락 ■1차예선 탈락
 * 그리고 각 팀 행의 배경을 그 색으로 칠한다. 순위가 **텍스트가 아니라 색**에 있다.
 *
 * ★ 대진에서 유도하지 않는 이유: 라운드 이름이 회차마다 백 가지가 넘고
 *   (`8강 A조 승자전`·`풀리그 3일차 B조 5경기`·`10강 A조 재경기`…), 풀리그 회차는
 *   '어디까지 갔나' 가 대진에 안 드러난다. 색은 주최 문서가 직접 매긴 순위다.
 *
 * 못 읽으면 null 을 준다. 순위를 지어내지 않는다 — 화면에서 그냥 안 보이면 된다.
 */
export async function fetchPlacements(title) {
  const res = await fetch(namuUrl(title), { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const html = await res.text();

  const hexToRgb = (h) => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h);
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)].join(",") : null;
  };
  // 순위처럼 생긴 말만 범례로 인정한다 — 티어 표시(■ C 1746)도 같은 모양이라서다.
  const PLACEMENT = /^(우승|준우승|공동\s*\d|\d+강|\d+위|.*탈락|.*진출|본선|예선.*)$/;

  const legend = new Map();
  for (const m of html.matchAll(/color:\s*(#[0-9a-fA-F]{6})[^>]*>■<\/span><\/span>\s*([^<]{1,20})/g)) {
    const label = decode(m[2]).trim();
    const rgb = hexToRgb(m[1]);
    if (rgb && PLACEMENT.test(label)) legend.set(rgb, label);
  }
  if (legend.size === 0) return null;

  // 팀 셀: <td style='background-color: rgb(r,g,b) …'> … 팀명 …
  // 팀명이 <strong> 인 회차도 있고 <div> 인 회차도 있다. 둘 다 받는다.
  const out = {};
  for (const m of html.matchAll(
    /background-color:\s*rgb\((\d+),\s*(\d+),\s*(\d+)\)[^>]*>((?:(?!<\/td>)[\s\S]){0,600})/g,
  )) {
    const label = legend.get(`${m[1]},${m[2]},${m[3]}`);
    if (!label) continue;
    const cell = m[4];
    const name = /<strong[^>]*>([^<]{1,24})<\/strong>/.exec(cell)
      ?? /<div[^>]*>([^<>]{1,24})<\/div>/.exec(cell);
    if (!name) continue;
    const team = decode(name[1]).trim();
    if (!team || PLACEMENT.test(team)) continue;   // 범례 셀 자신은 뺀다
    if (!(team in out)) out[team] = label;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** 문서 안에 실제로 적혀 있는 팀 이름들 (로스터 블록 머리글에서 딴다). */
function knownTeamNames(lines) {
  const out = new Set();
  for (let i = 1; i + 1 < lines.length; i++) {
    if (lines[i] === "닉네임" && /티어/.test(lines[i + 1] ?? "")) {
      const t = lines[i - 1];
      if (t && t.length <= 24) out.add(t);
    }
  }
  return out;
}

/**
 * `<br>` 로 쪼개진 팀명 조각을 되붙인다.
 *
 * '기바견', '분양중' 두 줄이 실제로는 '기바견분양중' 한 팀이다.
 * 아는 팀 이름과 맞을 때까지만 붙인다 — 안 맞으면 버린다.
 * 조각을 임의로 이어 팀을 만들어내면 없는 팀이 대진에 생긴다.
 */
function joinTeams(tokens, known) {
  const norm = (x) => String(x).replace(/\s+/g, "");
  const byNorm = new Map([...known].map((t) => [norm(t), t]));
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    let acc = "";
    for (let k = 0; k < 4 && i + k < tokens.length; k++) {
      acc += norm(tokens[i + k]);
      const hit = byNorm.get(acc);
      if (hit) { out.push(hit); i += k; break; }
    }
  }
  return out;
}

/**
 * 로스터 셀의 **인물 문서 링크**를 뽑는다 — 표기 → 문서.
 *
 * '이상호'·'BJ이상호'·'탈론장인이상호' 가 전부 `/w/이상호` 로 링크된다.
 * 출처가 직접 동일인이라고 말하는 것이라, 닉네임 유사도 추측보다 훨씬 단단하다.
 *
 * 회차 문서 링크(2026 LoL 멸망전 …)는 사람이 아니므로 걸러낸다.
 */
export async function fetchPersonLinks(title) {
  const res = await fetch(namuUrl(title), { headers: { "User-Agent": UA } });
  if (!res.ok) return new Map();
  const html = await res.text();
  const out = new Map();
  for (const m of html.matchAll(/<a[^>]+href='\/w\/([^'#]+)'[^>]*>([^<]{1,24})<\/a>/g)) {
    const nick = decode(m[2]).trim();
    const page = decodeURIComponent(m[1]);
    if (!nick || nick.length > 24) continue;
    if (/^\d/.test(page) || /멸망전|시즌|리그|대회|분류:/.test(page)) continue;
    if (!out.has(nick)) out.set(nick, page);
  }
  return out;
}
