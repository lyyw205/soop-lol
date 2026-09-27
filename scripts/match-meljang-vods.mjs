/**
 * 멸망전 **공식 채널들**의 VOD 를 시드 경기에 붙인다.
 *
 *   node scripts/match-meljang-vods.mjs            # 목록을 새로 받아 매칭
 *   node scripts/match-meljang-vods.mjs --cached   # 받아 둔 목록으로만 매칭
 *
 * ★ 공식 채널이 둘이다
 *   `afbjmatch`(SOOP멸망전) 가 2014~2018-02 를 맡았고, 2018-04 부터 `lolbjmatch`(LoL멸망전)
 *   가 이어받았다. 한쪽만 보면 2014·2015·2017·2018 시즌1 이 통째로 "영상 없음" 이 된다.
 *   찾은 방법: SOOP 검색 API(`m=bjSearch`, 키워드 "멸망전") — 추측이 아니다.
 *
 * 산출물
 *   out/meljang/vods-<채널>.json     — 채널별 VOD 전체(원본)
 *   out/meljang/vod-matches.json      — 시드 경기 ↔ VOD
 *
 * ★ 왜 제목으로 붙이나
 *   공식 채널은 경기마다 VOD 를 따로 올리고 제목에 **대진이 그대로** 있다
 *   (`[A 𝗩𝗦 B] UB 3R 11경기 | 2026 LoL 멸망전 with Gen.G`). 시드에도 팀 이름이
 *   있으므로 추측 없이 맞붙는다. 화면을 여는 건 그다음 일이다(ck:probe).
 *
 * ⚠ 제목에 대진이 없는 VOD 는 붙이지 않는다
 *   `조별리그 3일차 전체보기` 같은 하루치 통합본은 한 파일에 여러 경기가 들어 있다.
 *   그건 제목이 아니라 **VOD 안의 시각**으로 갈라야 하고, 그게 ck:probe 의 일이다.
 *   여기서 억지로 붙이면 근거 없는 연결이 된다(CLAUDE.md 원칙 2).
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { listBroadcasts } from "./lib/soop-vod.mjs";

/** 앞의 것이 더 최근 채널이다. 겹치는 시기는 없지만 순서를 고정해 결과가 흔들리지 않게 한다. */
const CHANNELS = ["lolbjmatch", "afbjmatch"];
const DIR = "out/meljang";
const listPath = (c) => `${DIR}/vods-${c}.json`;
const cached = process.argv.includes("--cached");

/**
 * `vs` 표기가 제각각이다 — 굵은 글꼴 𝗩𝗦, 전각 ＶＳ, 소문자 vs, **공백 없는** `로이조팀vs홀스팀`.
 * ⚠ 한글 사이에 낀 vs 는 공백이 없어도 구분자다. 라틴 글자 사이는 단어일 수 있어 건드리지 않는다.
 */
const norm = (s) => s
  .replace(/𝗩𝗦|ＶＳ/g, "VS")
  .replace(/(^|[\s\]])vs\.?(?=[\s\[]|$)/gi, "$1VS")
  .replace(/(?<=[가-힣])vs(?=[가-힣])/gi, " VS ")
  .replace(/\s+/g, " ").trim();

/**
 * 팀 이름 비교용 키.
 * ★ `팀`·공백·괄호·문장부호는 전부 뺀다 — 시드와 VOD 제목이 자주 어긋나는 자리다.
 *   실측: `이게내탓이라고?` ↔ `이게내탓이라고`, `캐뤼~` ↔ `캐뤼`.
 * ⚠ 한 시즌 안에서 문장부호만 다른 두 팀이 있으면 헷갈릴 수 있다. 대회 기간으로
 *   먼저 좁히므로 실제로는 안 겹치지만, 겹치면 `vods` 가 여러 개로 남아 눈에 띈다.
 */
const key = (s) => (s ?? "").replace(/team/gi, "").replace(/[\s팀·・()\[\]?!~.,'"“”‘’\-–—]/g, "").toLowerCase();

/**
 * 제목에서 대진 두 팀을 읽는다. 세 가지 꼴을 본다:
 *   `[A VS B] …`                     — 괄호 안이 대진
 *   `[BJ명] A VS [BJ명] B …`          — 앞 괄호는 BJ 이름이고 대진은 그 뒤 (2019)
 *   `A VS B | …`                     — 괄호 없음
 * 대진이 안 보이면 null — 하루치 통합본이 여기 걸린다.
 */
function parseMatchup(title) {
  const t = norm(title);
  const lead = t.match(/^\[([^\]]+)\]/);
  // 앞 괄호 안에 VS 가 있으면 그게 대진이다. 없으면 BJ 이름이므로 떼고 본다.
  const head = lead && /\sVS\s/.test(` ${lead[1]} `) ? lead[1] : t.replace(/^\[[^\]]+\]\s*/, "").split("|")[0];
  const parts = head.split(/\s+VS\s+/);
  if (parts.length !== 2) return null;
  /**
   * 팀 이름만 남긴다.
   *   `[이리아] 이리아와 조카들 2019 LoL BJ멸망전 …` → `이리아와 조카들`
   * ★ `|` 구분자가 없는 옛 제목은 팀 이름 뒤에 대회명이 그대로 붙어 온다(2019).
   *   대회명은 언제나 **네 자리 연도**로 시작하므로 거기서 자른다.
   */
  const clean = (s) => s
    .replace(/\[[^\]]*\]/g, "")
    .split(/\s(?=\d{4}\s)/)[0]
    .trim();
  const [a, b] = parts.map(clean);
  return a && b ? { a, b } : null;
}

/**
 * 제목의 세트 번호. `… 4강 1경기 3세트` → 3.
 * ⚠ `N경기` 는 세트가 아니라 **대진 번호**다(`LB 4R 13경기`). 세트는 `N세트` 뿐이다.
 */
const setOf = (title) => {
  // ⚠ `\b` 를 `세트` 뒤에 붙이면 안 된다 — 단어 경계는 [A-Za-z0-9_] 기준이라
  //   한글 뒤에서는 절대 성립하지 않는다. 실제로 한글 케이스가 통째로 죽었다.
  const m = norm(title).match(/(\d+)\s*(?:세트|set\b)/i);
  return m ? Number(m[1]) : null;
};

const shift = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dayGap = (a, b) => Math.round((new Date(a.slice(0, 10)) - new Date(b)) / 86_400_000);

async function loadVods() {
  const all = [];
  for (const c of CHANNELS) {
    let rows;
    if (cached && existsSync(listPath(c))) rows = JSON.parse(readFileSync(listPath(c), "utf8"));
    else {
      rows = await listBroadcasts(c, { maxPages: 60 });
      // ★ 잘렸으면 멈춘다. 적게 가져온 목록으로 "VOD 없음" 이라고 적으면 거짓말이 된다.
      if (rows.truncated) throw new Error(`${c}: VOD 목록이 잘렸다 — maxPages 를 늘리고 다시 돌려라`);
      mkdirSync(DIR, { recursive: true });
      writeFileSync(listPath(c), JSON.stringify(rows, null, 2));
    }
    console.log(`  ${c}: VOD ${rows.length}개`);
    all.push(...rows);
  }
  return all;
}

const vods = await loadVods();
const events = [];
for (const f of readdirSync("seed").filter((x) => x.startsWith("tournaments-meljang"))) {
  const arr = JSON.parse(readFileSync(`seed/${f}`, "utf8"));
  for (const t of Array.isArray(arr) ? arr : [arr]) events.push(t);
}

// 볼 만한 VOD: 하이라이트·짧은 클립 제외. 그중 대진이 읽히는 것이 직접 매칭 후보다.
const candidatesAll = vods.filter((v) => !/하이라이트/.test(v.title) && v.hours >= 0.5);
const candidates = [];
for (const v of vods) {
  if (/하이라이트/.test(v.title) || v.hours < 0.5) continue;
  const p = parseMatchup(v.title);
  if (p) candidates.push({ v, ...p });
}

const out = [];
let total = 0, hit = 0;
for (const e of events) {
  const days = (e.games ?? []).map((g) => (g.played_at ?? "").slice(0, 10)).filter(Boolean).sort();
  const from = days[0], to = days.at(-1);
  const games = [];
  for (const g of e.games ?? []) {
    total++;
    const day = (g.played_at ?? "").slice(0, 10);
    const [ka, kb] = [key(g.blue), key(g.red)];
    // ★ 대회 기간(±3일)으로 먼저 좁힌다 — 팀 이름은 시즌마다 재활용된다.
    const hits = candidates.filter(({ v, a, b }) => {
      const d = v.ended_at.slice(0, 10);
      if (from && (d < shift(from, -3) || d > shift(to, 3))) return false;
      const [pa, pb] = [key(a), key(b)];
      // ★ 1순위는 정확 일치. 옛 제목(`천하제패 멸망전! 홀스형 vs 불양`)은 팀 이름 앞뒤에
      //   수식어가 붙어서 정확히는 안 맞는다 — 그때만 «포함» 으로 한 번 더 본다.
      //   양쪽 다 맞아야 하고 한 글자 이름은 제외한다(우연히 들어맞기 쉽다).
      const exact = (pa === ka && pb === kb) || (pa === kb && pb === ka);
      const loose = ka.length > 1 && kb.length > 1
        && ((pa.includes(ka) && pb.includes(kb)) || (pa.includes(kb) && pb.includes(ka)));
      if (!exact && !loose) return false;
      // 제목이 세트를 밝혔는데 그 세트가 아니면 이 경기의 영상이 아니다.
      const vs = setOf(v.title);
      return vs == null || g.set_no == null || vs === g.set_no;
    }).sort((x, y) => {
      // ★ 순서: 같은 날 → 세트 번호 일치 → 날짜가 가까운 것.
      //   같은 대진이 조별리그와 플레이오프에서 또 붙는다(실측 2018 시즌2) — 날짜가 먼저다.
      const same = (h) => (dayGap(h.v.ended_at, day) === 0 ? 0 : 1);
      const exactHit = (h) => {
        const [pa, pb] = [key(h.a), key(h.b)];
        return (pa === ka && pb === kb) || (pa === kb && pb === ka) ? 0 : 1;
      };
      const setHit = (h) => (g.set_no != null && setOf(h.v.title) === g.set_no ? 0 : 1);
      return same(x) - same(y) || exactHit(x) - exactHit(y) || setHit(x) - setHit(y)
        || Math.abs(dayGap(x.v.ended_at, day)) - Math.abs(dayGap(y.v.ended_at, day))
        // 같은 날 후보가 둘이면 대개 «경기별 컷» + «생방송 통짜» 다. 짧은 쪽이 그 경기다.
        || x.v.hours - y.v.hours;
    });
    if (hits.length) hit++;
    /**
     * 대진이 안 붙은 경기에는 **같은 날 통합본**을 조사 후보로 달아 둔다.
     * ⚠ 이건 "이 경기가 저기 있다" 가 아니라 "저기부터 봐라" 다. 한 파일에 여러 경기가
     *   들어 있으므로 시각은 ck:probe 로 찾아야 한다 — 여기서 단정하지 않는다.
     */
    const dayVods = hits.length ? [] : candidatesAll.filter((v) =>
      v.ended_at.slice(0, 10) === day && !parseMatchup(v.title));
    games.push({
      game: g.id, series: g.series, set_no: g.set_no, round: g.round ?? null,
      played_at: day, blue: g.blue, red: g.red,
      vods: hits.map(({ v }) => ({
        channel: v.channel_id, title_no: v.title_no, url: v.url, title: v.title, set: setOf(v.title),
        ended_at: v.ended_at, hours: +v.hours.toFixed(2), day_gap: dayGap(v.ended_at, day),
      })),
      probe_candidates: dayVods.map((v) => ({
        channel: v.channel_id, title_no: v.title_no, url: v.url, title: v.title, hours: +v.hours.toFixed(2),
      })),
    });
  }
  out.push({ slug: e.slug, name: e.name, from, to, games });
}

mkdirSync(DIR, { recursive: true });
writeFileSync(`${DIR}/vod-matches.json`, JSON.stringify(out, null, 2));

console.log(`\n공식 채널 ${CHANNELS.length}곳 · VOD ${vods.length}개 · 대진이 읽히는 경기 VOD ${candidates.length}개`);
console.log(`시드 경기 ${total}건 중 VOD 붙은 것 ${hit}건 (${(hit / total * 100).toFixed(0)}%)\n`);
console.log("시즌                      경기   VOD    비고");
for (const e of out) {
  const n = e.games.length, m = e.games.filter((g) => g.vods.length).length;
  // 기간 안에 채널 VOD 가 아예 없으면 "제목 형식 문제" 가 아니라 "영상이 없다" 다.
  const inRange = e.from ? vods.filter((v) => { const d = v.ended_at.slice(0, 10); return d >= e.from && d <= e.to; }).length : 0;
  const note = m === n ? "" : inRange === 0 ? "채널에 그 시기 VOD 자체가 없음" : `그 기간 VOD ${inRange}개 — 제목에 대진 없는 통합본 추정`;
  console.log(`${e.slug.padEnd(24)} ${String(n).padStart(4)} ${String(m).padStart(6)}    ${note}`);
}
/**
 * 사람이 읽을 목록도 같이 낸다. 한 줄 = 한 경기이고 **상태를 꼭 적는다** —
 * `없음` 을 빈칸으로 두면 "아직 안 찾았다" 와 "찾아보니 없다" 가 구분되지 않는다.
 */
const tsv = ["시즌\t경기\t날짜\t라운드\t블루\t레드\t상태\t채널\tVOD\t제목"];
for (const e of out) {
  for (const g of e.games) {
    const v = g.vods[0];
    const state = v ? (g.vods.length > 1 ? `매칭(후보 ${g.vods.length})` : "매칭")
      : g.probe_candidates.length ? "통합본만" : "영상없음";
    const link = v?.url ?? g.probe_candidates[0]?.url ?? "";
    const title = v?.title ?? g.probe_candidates[0]?.title ?? "";
    const ch = v?.channel ?? g.probe_candidates[0]?.channel ?? "";
    tsv.push([e.slug, g.game, g.played_at, g.round ?? "", g.blue, g.red, state, ch, link, title].join("\t"));
  }
}
writeFileSync(`${DIR}/vod-links.tsv`, tsv.join("\n") + "\n");

const noVod = out.flatMap((e) => e.games).filter((g) => !g.vods.length);
const withProbe = noVod.filter((g) => g.probe_candidates.length);
console.log(`\nVOD 없는 경기 ${noVod.length}건 중 — 같은 날 통합본이 있는 것 ${withProbe.length}건(ck:probe 대상)`);
console.log(`                         영상 자체가 없는 것 ${noVod.length - withProbe.length}건`);
console.log(`\n→ ${DIR}/vod-matches.json\n→ ${DIR}/vod-links.tsv`);
