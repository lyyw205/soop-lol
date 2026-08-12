/**
 * SOOP VOD 접근 + 내전 구간 탐지. **세 스크립트의 단일 출처다.**
 *   collect-leads.ts · prep-ck-frames.mjs · scan-vod-*.mjs · build-soop-fa.mjs · set-watchlist.ts
 *
 * ★ 왜 모아 뒀나
 *   이 API 는 함정이 세 개인데 셋 다 조용히 틀린다 — 에러가 아니라 **빈 결과**로 온다:
 *     · 상세 조회는 **POST** 여야 한다. GET 은 "This VOD does not exist" 를 돌려준다
 *     · `files[].duration` 은 **밀리초**다. 초로 알고 비교하면 2분짜리 조각을
 *       본편으로 고른다 (실제로 채팅 43,917건이 227건으로 줄었다)
 *     · 채팅은 `startTime` 없이 부르면 404 다
 *   각자 들고 있으면 한 곳만 고치고 나머지는 틀린 채로 남는다.
 *
 * ★ 남의 API 다
 *   예고 없이 바뀐다. 값이 안 오면 우리 코드보다 이쪽을 먼저 의심한다.
 */

import jpeg from "jpeg-js";

import { soopFetch } from "./soop-http.mjs";

const UA = { "User-Agent": "Mozilla/5.0" };
/** 제목에 이게 있으면 내전으로 본다. 넓게 잡고 뒤에서 거른다. (내부용 — 검색 함수들이 쓴다) */
const CK_TITLE = /ck|씨케이|내전|멸망전|스크림|대회/i;
/**
 * SOOP VOD 카테고리 — 리그 오브 레전드.
 * ★ 같은 값이 API 마다 표기가 다르다: 전역 검색(vodSearch)은 문자열 "00040019",
 *   채널 VOD 의 ucc 는 숫자 40019. 한동안 호출부와 여기에 두 벌로 흩어져 있었다.
 *   **문자열이 정본**이고(전역 검색·event_lead.raw 에 그대로 저장됨) 숫자는 여기서 파생한다.
 */
export const LOL_CATEGORY = "00040019";
const LOL_CATEGORY_UCC = Number(LOL_CATEGORY); // = 40019

export const hms = (s) =>
  `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// ── 방송국 ───────────────────────────────────────────────────────────

/**
 * 애청자 수. SOOP 이 직접 세는 값이라 **인지도의 관측 지표**로 쓴다.
 *
 * ★ `User-Agent` 가 없으면 404 가 온다. 남의 API 라 이유는 모르지만 재현된다.
 * ★ 못 읽으면 `null` 이다. **0 으로 채우지 않는다** — 못 읽은 것과 정말 0 인 것을
 *   섞으면 "인지도 순" 이 조용히 거짓말이 된다.
 */
export async function fanCount(channelId) {
  try {
    const r = await soopFetch(`https://chapi.sooplive.co.kr/api/${channelId}/station`, {
      headers: { ...UA, Referer: `https://ch.sooplive.co.kr/${channelId}` },
    });
    if (!r.ok) return null;
    const n = (await r.json())?.station?.upd?.fan_cnt;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

// ── VOD 찾기 ─────────────────────────────────────────────────────────

/**
 * **전역** VOD 검색. 채널을 순회하지 않고 SOOP 전체를 한 번에 훑는다.
 * 우리가 등록하지 않은 채널의 내전까지 잡히므로 **로스터 확장 경로이기도 하다.**
 *
 * 날짜 필터가 없다. 최신순으로 받다가 목표일을 지나면 그 검색어를 멈춘다.
 * 검색어 하나로는 못 잡는다 — 사람마다 부르는 이름이 다르다.
 */
export async function searchVods(date, { keywords = ["ck", "내전", "멸망전", "스크림"], maxPages = 40 } = {}) {
  const found = new Map();
  // ★ 목표일에 **닿지 못하고** 페이지 상한에서 멈춘 검색어. 조용히 넘기면 안 된다.
  //   실측: maxPages=8 로는 이틀 전까지 못 갔고, 그래서 이상호 시그니처ck 가
  //   통째로 빠졌는데 결과는 "80건 찾음" 이라 정상처럼 보였다.
  const truncated = [];
  for (const kw of keywords) {
    let reached = false;
    for (let page = 1; page <= maxPages; page++) {
      const url = "https://sch.sooplive.co.kr/api.php?m=vodSearch&v=3.0"
        + `&szKeyword=${encodeURIComponent(kw)}&nPageNo=${page}&nListCnt=60&szOrder=reg_date`;
      // ★ 실패를 빈 배열로 삼키면 **그 페이지가 조용히 사라진다.**
      //   실측: 같은 날짜를 두 번 돌렸는데 한 번은 채널 4개, 한 번은 1개가 나왔다.
      //   원인이 이것이었다 — 페이지 하나가 빠지면 그만큼 결과가 줄어드는데
      //   로그는 정상으로 보인다. 한 번 다시 치고, 그래도 안 되면 기록한다.
      let rows = null;
      for (let attempt = 0; attempt < 2 && rows === null; attempt++) {
        if (attempt > 0) await new Promise((s) => setTimeout(s, 1500));
        rows = await soopFetch(url, { headers: UA })
          .then((r) => (r.ok ? r.json() : null)).then((d) => d?.DATA ?? null).catch(() => null);
      }
      if (rows === null) { truncated.push(`${kw}(p${page} 실패)`); break; }
      if (rows.length === 0) break;
      let passed = false;
      for (const r of rows) {
        const day = String(r.reg_date ?? "").slice(0, 10);
        if (day > date) continue;                       // 아직 목표일에 못 왔다
        if (day < date) { passed = true; continue; }    // 지나쳤다
        // 본방만. CATCH·CLIP 은 편집본이라 경기 전체가 없다.
        if (r.file_type !== "REVIEW") continue;
        if (!CK_TITLE.test(String(r.title ?? ""))) continue;
        // ★ vodSearch 는 title_no 를 **문자열**로, vods/all 은 **숫자**로 준다.
        //   섞이면 Set·Map 비교가 조용히 전부 어긋난다(실측: 같은 VOD 15건이
        //   '겹치는 것 0건' 으로 나왔다). 경계에서 숫자로 못 박는다.
        found.set(Number(r.title_no), {
          title_no: Number(r.title_no),
          channel_id: String(r.user_id),
          title: String(r.title ?? ""),
          at: String(r.reg_date),
          category: String(r.vod_category ?? ""),
          views: Number(r.vod_view_cnt ?? 0),
        });
      }
      if (passed) { reached = true; break; }
      if (page === maxPages) truncated.push(kw);
    }
    // 결과가 동나서 끝난 것도 '도달' 로 본다 — 그 검색어엔 더 없다는 뜻이다.
    if (!reached && !truncated.includes(kw)) reached = true;
  }
  const vods = [...found.values()];
  vods.truncated = truncated;
  return vods;
}

/**
 * 채널의 롤 **본방**(REVIEW) VOD. 클립은 뺀다 — 편집본이라 경기 전체가 없다.
 *
 * `vod_category=40019`(롤)로 걸러지므로 LCK 시청·다른 게임이 애초에 안 들어온다.
 * 이게 전역 검색보다 나은 이유다 — 실측에서 전역은 317건 중 93% 가 노이즈였다.
 *
 * @param {string} channelId
 * @param {{ since?: string, onlyCk?: boolean, maxPages?: number }} [opts]
 *   `since` 는 'YYYY-MM-DD'. 그 날짜보다 오래된 것을 만나면 멈춘다.
 */
export async function findVods(channelId, { since, onlyCk = true, maxPages = 30 } = {}) {
  const out = [];
  // ★ 상한에 걸려 `since` 까지 못 내려갔으면 **그만큼 빠진 것**이다.
  //   실측: 상한이 6장(360건)이었는데 김민교는 10일에 900건을 올린다 —
  //   3일 전 '시그니처CK' 가 통째로 빠졌고 결과는 정상처럼 보였다.
  //   조용히 적게 가져오는 건 실패보다 나쁘다. 못 닿았으면 그렇다고 말한다.
  out.truncated = false;
  for (let page = 1; page <= maxPages; page++) {
    let rows = null;
    for (let attempt = 0; attempt < 2 && rows === null; attempt++) {
      if (attempt > 0) await new Promise((s) => setTimeout(s, 1000));
      try {
        const r = await soopFetch(
          `https://chapi.sooplive.co.kr/api/${channelId}/vods/all?page=${page}&per_page=60&orderby=reg_date`,
          { headers: { ...UA, Referer: `https://ch.sooplive.co.kr/${channelId}` } },
        );
        rows = r.ok ? ((await r.json())?.data ?? []) : null;
      } catch { rows = null; }
    }
    if (rows === null) { out.truncated = true; return out; }
    if (rows.length === 0) return out;
    if (page === maxPages && since) out.truncated = true;
    for (const v of rows) {
      // 최신순으로 오므로 경계를 지나면 더 볼 필요가 없다.
      if (since && v.reg_date.slice(0, 10) < since) return out;
      const u = v.ucc ?? {};
      if (u.file_type !== "REVIEW" || u.vod_category !== LOL_CATEGORY_UCC) continue;
      if (onlyCk && !CK_TITLE.test(v.title_name)) continue;
      out.push({
        channel_id: channelId,
        title_no: Number(v.title_no),
        title: v.title_name,
        // reg_date 는 **VOD 등록(=방송 종료) 시각**이다. 시작은 길이를 빼야 나온다.
        ended_at: v.reg_date,
        hours: (u.total_file_duration ?? 0) / 3_600_000,
        // ★ `count` 는 객체다(`{like_cnt, read_cnt, vod_read_cnt, …}`).
        //   그냥 넣으면 `[object Object]` 가 되고 조회수 정렬이 통째로 무의미해진다.
        views: v.count?.vod_read_cnt ?? 0,
        url: `https://vod.sooplive.com/player/${v.title_no}`,
      });
    }
  }
  return out;
}

/** VOD 상세. **POST 여야 한다.** */
export async function vodDetail(titleNo) {
  const r = await soopFetch("https://api.m.sooplive.co.kr/station/video/a/view", {
    method: "POST",
    headers: { ...UA, Referer: "https://vod.sooplive.com/", "Content-Type": "application/x-www-form-urlencoded" },
    body: `nTitleNo=${titleNo}&nApiLevel=10&nPlaylistIdx=0`,
  });
  const j = await r.json();
  return j?.result === 1 ? j.data : null;
}

/** 훑을 만한 파일만. duration 은 **밀리초**다. */
export const playableFiles = (detail) =>
  (detail?.files ?? []).filter((f) => f.duration > 600_000);

const rowKeyOf = (url) => new URL(url, "https://videoimg.sooplive.co.kr").searchParams.get("rowKey");

// ── 썸네일 시트 ───────────────────────────────────────────────────────

const FW = 192, FH = 108;   // 시트 한 칸 (1920×1080 을 10×10 으로 나눈 것)
const PER_SHEET = 100;

/** 시트 한 장에서 100칸의 밝기·채도를 뽑는다. 3픽셀씩 건너뛴다 — 통계라 충분하다. */
function statsOfSheet(buf) {
  const img = jpeg.decode(buf, { useTArray: true });
  const out = [];
  for (let fy = 0; fy < 10; fy++) {
    for (let fx = 0; fx < 10; fx++) {
      let r = 0, g = 0, b = 0, sat = 0, n = 0;
      for (let y = 0; y < FH; y += 3) {
        for (let x = 0; x < FW; x += 3) {
          const i = ((fy * FH + y) * img.width + fx * FW + x) * 4;
          const R = img.data[i], G = img.data[i + 1], B = img.data[i + 2];
          r += R; g += G; b += B; n++;
          const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
          sat += mx === 0 ? 0 : (mx - mn) / mx;
        }
      }
      out.push({ lum: (0.299 * r + 0.587 * g + 0.114 * b) / n, sat: (sat / n) * 100 });
    }
  }
  return out;
}

/** 파일 하나의 프레임 전체를 훑는다. 5시간이면 시트 60장 45MB. LLM 을 부르지 않는다. */
export async function scanSheets(file) {
  // snapshot 이 없는 파일이 실재한다(짧은 조각 등). rowKey=null 로 남의 서버를
  // 두드리거나, HTML 오류 페이지를 jpeg.decode 에 넣어 **무인 실행 전체를 죽이는**
  // 것보다 빈 결과가 낫다 — 호출부는 frames.length 로 구분한다.
  if (!file.snapshot) return { frames: [], bytes: 0, total: file.duration / 1000, sec: 0 };
  const rowKey = rowKeyOf(file.snapshot);
  const frames = [];
  let bytes = 0;
  for (let c = 0; ; c++) {
    const r = await soopFetch(`https://videoimg.sooplive.co.kr/php/SnapshotLoad.php?rowKey=${rowKey}&column=${c}`,
      { headers: { ...UA, Referer: "https://vod.sooplive.com/" } });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 1000) break;      // 빈 응답 = 마지막 시트를 지났다
    bytes += buf.length;
    try {
      frames.push(...statsOfSheet(buf));
    } catch {
      break;   // JPEG 가 아니다(오류 페이지 등) — 여기서 멈추고 그때까지의 프레임으로 간다
    }
  }
  const total = file.duration / 1000;
  return { frames, bytes, total, sec: frames.length ? total / frames.length : 0 };
}

// ── 판정 ──────────────────────────────────────────────────────────────
//
// 규칙은 프레임 6,000장의 통계를 **채팅이 알려준 정답과 맞춰가며** 골랐다.
// docs/CK-COLLECTION.md §4 에 근거와 한계가 있다.

/** 협곡 화면 = 어둡고 알록달록하다. (게임 중 밝기 56~70/채도 30~40, 브라우저는 84~230) */
const isGame = (f) => f.lum < 75 && f.sat > 28;
/** 밴픽·로딩·대진표 = 채도가 튄다. (전체 중앙 34, 99%tile 48) */
const isDraft = (f) => f.sat > 45 && f.lum < 110;

/**
 * 참/거짓 배열을 구간으로 묶는다. `gap` 프레임 이하의 끊김은 이어 붙인다.
 * 안 이어 붙이면 한 판이 256조각까지 부서진다(실측). 상점·Tab·잠깐 딴짓이다.
 */
function mergeRuns(flags, gap) {
  const runs = [];
  let start = null, last = null;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i]) { if (start === null) start = i; last = i; }
    else if (start !== null && i - last > gap) { runs.push([start, last]); start = null; last = null; }
  }
  if (start !== null) runs.push([start, last]);
  return runs;
}

/**
 * 프레임 통계 → 경기 구간과 **판독할 지점**.
 *
 * 판독 지점은 밴픽 후보 + 120초다. 밴픽이 끝나고 2분이면 로딩 화면이나
 * Tab 스코어보드가 떠서 10명이 한 장에 다 잡힌다.
 * ⚠ 경기 **종료 시각은 못 맞춘다** — 종료 화면과 로비도 어두워서 구간이 3~8분 끌린다.
 */
export function detect(frames, sec) {
  const games = mergeRuns(frames.map(isGame), 40)
    .filter(([a, b]) => (b - a) * sec > 15 * 60)
    .map(([a, b]) => ({ start: a * sec, end: b * sec }));
  const shots = mergeRuns(frames.map(isDraft), 10)
    .filter(([a, b]) => b - a >= 3)
    .map(([a]) => a * sec + 120);
  return { games, shots, gameRatio: frames.filter(isGame).length / (frames.length || 1) };
}

// ── 채팅 ──────────────────────────────────────────────────────────────

/**
 * 채팅에서 **`!공지` 만 훑어낸다. 나머지는 즉시 버린다.**
 *
 * ★ 왜 따로 있나
 *   `loadChat` 은 채팅을 통째로 메모리에 든다 — 5시간 방송이 43,917건 10MB 다.
 *   매일 10개 VOD 를 그렇게 받으면 쓸데없이 100MB 를 들고 있게 되는데,
 *   **우리가 쓰는 건 `!공지` 몇 줄뿐**이다.
 *
 *   그래서 300초 창을 하나씩 받아 `!공지` 만 골라 담고 그 창은 바로 놓는다.
 *   메모리에 남는 건 보통 열 줄 안쪽이고, 디스크에는 아무것도 안 쓴다.
 *   방송 채팅을 우리가 보관할 이유가 없다 — 필요한 건 "몇 대 몇으로 끝났나" 다.
 */
export async function noticesFrom(file) {
  const rowKey = rowKeyOf(file.chat);
  const total = file.duration / 1000;
  const kept = [];
  let bytes = 0;
  for (let t = 0; t < total; t += 300) {
    const r = await soopFetch(`https://videoimg.sooplive.co.kr/php/ChatLoadSplit.php?rowKey=${rowKey}&startTime=${t}`,
      { headers: { ...UA, Referer: "https://vod.sooplive.com/" } });
    if (!r.ok) continue;
    const x = await r.text();      // ← 이 창의 원문. 아래 루프가 끝나면 참조가 끊긴다
    bytes += x.length;
    for (const m of x.matchAll(
      /<chat><m><!\[CDATA\[\s*(!공지[\s\S]*?)\]\]><\/m>[\s\S]*?<n><!\[CDATA\[([\s\S]*?)\]\]><\/n>[\s\S]*?<t>([\d.]+)<\/t><\/chat>/g,
    )) kept.push({ t: Number(m[3]), who: m[2], msg: m[1] });
  }
  kept.sort((a, b) => a.t - b.t);
  // 창이 겹쳐 같은 공지가 두 번 들어온다.
  const uniq = kept.filter((m, i) => i === 0 || m.t !== kept[i - 1].t || m.msg !== kept[i - 1].msg);
  return { ...gameEndsFromNotice(uniq), bytes };
}

/** 채팅 전체. **진단용이다** — 매일 도는 수집에는 `noticesFrom` 을 쓴다. */
export async function loadChat(file) {
  const rowKey = rowKeyOf(file.chat);
  const total = file.duration / 1000;
  const msgs = [];
  let bytes = 0;
  for (let t = 0; t < total; t += 300) {
    const r = await soopFetch(`https://videoimg.sooplive.co.kr/php/ChatLoadSplit.php?rowKey=${rowKey}&startTime=${t}`,
      { headers: { ...UA, Referer: "https://vod.sooplive.com/" } });
    if (!r.ok) continue;
    const x = await r.text();
    bytes += x.length;
    for (const m of x.matchAll(
      /<chat><m><!\[CDATA\[([\s\S]*?)\]\]><\/m>[\s\S]*?<n><!\[CDATA\[([\s\S]*?)\]\]><\/n>[\s\S]*?<t>([\d.]+)<\/t><\/chat>/g,
    )) msgs.push({ t: Number(m[3]), who: m[2], msg: m[1] });
  }
  msgs.sort((a, b) => a.t - b.t);
  // 창이 겹쳐 같은 메시지가 두 번 들어온다.
  return { msgs: msgs.filter((m, i) => i === 0 || m.t !== msgs[i - 1].t || m.msg !== msgs[i - 1].msg), bytes };
}

/**
 * `!공지` 로 갱신되는 시리즈 스코어에서 경기 종료 시각과 승자를 뽑는다.
 *
 * ★ 누가 올렸는지로 거르지 않는다 — **점수 진행이 말이 되는지**로 거른다.
 *   한쪽만 오르면 그 팀이 이긴 것이고, 0:0 이면 새 시리즈다. 그 밖의 전이는 버린다.
 *   시청자가 장난으로 올린 반대 점수(2:1 다음에 1:2)가 실제로 있었고 이게 걸러냈다.
 *
 * ⚠ **10개 채널 중 1개에만 있었다.** 대형 조직 내전의 습관이지 규격이 아니다.
 *
 * ★ 공지를 올리는 건 사람이라 **틀리고, 몇십 초 뒤에 고친다.** 같은 경기를 두고
 *   서로 다른 승자를 말하는 공지가 둘 오면 `winner: null` 에 `conflict` 를 달아
 *   넘긴다 — 어느 쪽이 맞는지는 결과 화면(프레임)을 봐야 안다.
 */
const CORRECTION_WINDOW = 300;   // 초. 이 안에 들어온 모순 공지는 '정정' 후보로 본다

export function gameEndsFromNotice(msgs) {
  // ★ 팀명을 헐겁게 잡으면 쓰레기가 팀이 된다.
  //   실측: `깐숙VS민교( 1 : 0 )` 에서 팀명이 `깐숙VS민교(` 와 `)` 로 잡혔다.
  //   그래서 (1) `3/2)` 같은 Bo 표기를 먼저 떼고
  //        (2) 팀명은 **괄호·구두점이 없는 1~14자**만 인정한다.
  //   못 읽으면 버린다 — 이상한 팀명이 전적에 남는 것보다 낫다.
  const TEAM = "[^\\s()\\[\\]{}:,.<>]{1,14}";
  // ★ 문자열 전체에 앵커를 걸면 안 된다. 실측한 공지 형식이 이렇게 제각각이다:
  //     `!공지 3/2) 상호팀 0 : 1 성훈팀`
  //     `!공지 [3/2] 민교팀 1 : 0 깐숙팀`
  //     `!공지 첫 3/2 메펀 3만개빵<br> 민교팀 0 : 0 깐숙팀`
  //   앵커를 걸었더니 세 번째 형식이 통째로 안 잡혀 김민교 내전이 0건이 됐다.
  //   → **점수 패턴을 문장 안에서 찾되, 양옆 팀명은 여전히 깐깐하게** 본다.
  //     (`깐숙VS민교( 1 : 0 )` 같은 건 팀명 문자 제약으로 걸러진다)
  const SCORE = new RegExp(`(${TEAM})\\s*(\\d+)\\s*:\\s*(\\d+)\\s*(${TEAM})`);
  const notices = msgs
    .filter((m) => m.msg.trim().startsWith("!공지"))
    .map((m) => ({
      ...m,
      sc: SCORE.exec(
        m.msg.trim()
          .replace(/^!공지\s*/, "")
          .replace(/<br\s*\/?>/gi, " ")                    // 공지에 개행 태그가 섞인다
          .replace(/[[(]\s*\d+\s*\/\s*\d+\s*[\])]?/g, " ")  // '3/2)' · '[3/2]' 다전제 표기
          .trim(),
      ),
    }))
    .filter((m) => m.sc);
  if (notices.length < 2) return { ends: [], notices: notices.length, rejected: 0 };

  const ends = [];
  let prev = null;          // 지금까지 인정한 마지막 점수
  let before = null;        // **그 직전** 점수 = 마지막 경기가 시작될 때의 점수
  let rejected = 0, conflicts = 0;

  for (const n of notices) {
    const [, aName, a, b, bName] = n.sc;
    const cur = { a: Number(a), b: Number(b) };
    if (!prev) { prev = cur; continue; }
    const da = cur.a - prev.a, db = cur.b - prev.b;
    if (cur.a === 0 && cur.b === 0) { prev = cur; before = null; continue; }  // 새 시리즈
    if (da === 0 && db === 0) continue;                                       // 같은 점수 재공지
    if (da > 0 && db === 0) {
      before = prev; prev = cur;
      ends.push({ t: n.t, at: hms(n.t), winner: aName, score: `${cur.a}:${cur.b}`, skipped: da - 1 });
      continue;
    }
    if (db > 0 && da === 0) {
      before = prev; prev = cur;
      ends.push({ t: n.t, at: hms(n.t), winner: bName, score: `${cur.a}:${cur.b}`, skipped: db - 1 });
      continue;
    }

    // ★ 여기가 실제로 틀렸던 자리다.
    //   1:1 다음에 `2:1`(4:45:37) 과 `1:2`(4:46:04) 가 27초 사이로 들어왔다.
    //   **둘 다 1:1 에서 한 칸 나아간 유효한 점수**라 앞의 것만 보고는 못 고른다.
    //   예전 코드는 먼저 온 것을 채택하고 뒤엣것을 '역행'으로 버렸는데,
    //   실제로는 먼저 온 쪽이 오기였고 뒤엣것이 정정이었다.
    //   프레임(결과 화면)으로 확인하기 전까지는 **승자를 만들지 않는다.**
    //   틀린 상대전적이 들어가는 것보다 비어 있는 편이 낫다(§11-2·§11-3).
    const last = ends[ends.length - 1];
    if (before && last && n.t - last.t <= CORRECTION_WINDOW) {
      const ea = cur.a - before.a, eb = cur.b - before.b;
      if ((ea > 0 && eb === 0) || (eb > 0 && ea === 0)) {
        if (last.winner !== null) conflicts++;
        last.conflict = {
          first: { score: last.score, winner: last.winner },
          second: { score: `${cur.a}:${cur.b}`, winner: ea > 0 ? aName : bName },
          gap: Math.round(n.t - last.t),
        };
        last.winner = null;                       // 고르지 않는다
        last.score = `${cur.a}:${cur.b}`;         // 이후 경기를 세려면 하나는 이어야 한다
        prev = cur;                               // 나중 것을 잇는다 — 보통 정정이 뒤에 온다
        continue;
      }
    }
    rejected++;                                                              // 앞뒤가 안 맞는다
  }
  return { ends, notices: notices.length, rejected, conflicts };
}

/**
 * **경기 종료 지점마다 결과 화면을 반드시 잡는다.** 선택이 아니라 마지막 검증 관문이다.
 *
 * ★ 왜 여기가 정본인가
 *   LoL 최종 결과 화면 한 장에 승리/패배 · 10명 챔피언 · KDA · 게임 길이가 다 있고
 *   사람이 잘못 칠 여지가 없다. 반면 채팅 `!공지` 는 사람이 치는 거라 틀리고
 *   뒤늦게 고쳐진다 — 실제로 승자가 뒤집힌 채 사이트에 올라간 적이 있다.
 *   공지는 **어디를 볼지 알려주는 단서**로만 쓴다.
 *
 * ★ 왜 한 장으로는 모자란가 (2026-08-08 시그니처CK 실측)
 *   화면이 떠 있는 시간이 25초 안쪽이다 — 스트리머가 바로 리플레이를 켠다.
 *   게다가 공지 시각이 종료보다 **앞설 때도 뒤설 때도** 있다:
 *     1세트 공지 +14초 · 2세트 +10초 · 3세트 **−9초** · 4세트 −4초 · 5세트 −4초
 *   그래서 한 지점을 찍으면 절반은 빗나간다. 앞뒤로 셋을 잡는다.
 *
 * 종료 표시는 두 곳에서 온다 — 채팅 공지(정확)와 시트 판독의 경기 구간 끝(대략).
 * 공지가 없는 방송이 열에 아홉이라 구간 끝도 같이 쓴다.
 */
/**
 * 종료 표시 기준 오프셋(초). **실측으로 정했다** (2026-08-08 시그니처CK 5세트).
 *
 *   공지 대비 결과 화면 위치:  1세트 +12~+21 · 2세트 +10 · 3세트 +5~+11 · 4세트 −4 · 5세트 −4~+22
 *   화면이 떠 있는 시간:        9초(1세트)부터 27초(5세트)까지
 *
 * 앞뒤 −6~+24 를 6초 간격으로 훑는다. 제일 짧았던 9초보다 촘촘해야 확실히 걸린다.
 * 처음엔 [−6, +8, +22] 셋만 잡았다가 1세트를 놓쳤다 — +8 은 이르고 +22 는 1초 늦었다.
 */
export const RESULT_OFFSETS = [-6, 0, 6, 12, 18, 24];

export function resultShots({ games = [], chatEnds = [], total = Infinity }) {
  // ★ 공지가 있으면 **공지만** 쓴다.
  //   시트 판독의 경기 구간 끝은 종료 지점으로는 못 쓴다 — 스트리머가 끝나고
  //   리플레이를 켜면 그것도 '롤 화면' 이라 구간이 몇 분씩 늘어난다.
  //   실측에서 구간 끝이 실제 종료보다 5~8분 뒤였다. 공지가 없을 때의 차선일 뿐이다.
  const marks = chatEnds.map((e) => e.t).filter(Number.isFinite);
  if (marks.length === 0) {
    marks.push(...games.map((g) => g.endSec ?? g.end).filter(Number.isFinite));
  }
  const out = new Set();
  for (const m of marks) {
    for (const d of RESULT_OFFSETS) {
      const t = Math.round(m + d);
      if (t >= 0 && t < total) out.add(t);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** `!공지` 가 없는 방송용 대비책. 경기가 끝나면 채팅이 튄다. */
export function chatSpikes(msgs, total, { bin = 60, ratio = 2.5 } = {}) {
  const n = Math.ceil(total / bin);
  const c = new Array(n).fill(0);
  for (const m of msgs) c[Math.min(n - 1, Math.floor(m.t / bin))]++;
  const mean = c.reduce((s, v) => s + v, 0) / n;
  const out = [];
  for (let i = 1; i < n - 1; i++) {
    if (c[i] > mean * ratio && c[i] >= c[i - 1] && c[i] >= c[i + 1]) out.push({ t: i * bin, n: c[i] });
  }
  return { spikes: out, mean };
}

// ── 영상 ──────────────────────────────────────────────────────────────

/**
 * HLS 세그먼트 목록. 6초짜리라 **원하는 시각의 세그먼트 하나만** 받으면 된다
 * (1080p 세그먼트 ~6MB). 전체를 내려받을 이유가 없다.
 */
export async function hlsSegments(file) {
  const master = await soopFetch(file.file, { headers: UA }).then((r) => r.text());
  const lines = master.split("\n");
  let rel = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("1920x1080") && lines[i + 1]?.trim()) { rel = lines[i + 1].trim(); break; }
  }
  if (!rel) rel = lines.find((l) => l.trim() && !l.startsWith("#"));
  const base = new URL(rel, file.file).href;
  const dir = base.slice(0, base.lastIndexOf("/"));
  const pl = (await soopFetch(base, { headers: UA }).then((r) => r.text())).split("\n");

  const segs = [];
  let t = 0;
  for (let i = 0; i < pl.length; i++) {
    const m = /^#EXTINF:([\d.]+)/.exec(pl[i]);
    if (!m) continue;
    segs.push({ start: t, dur: Number(m[1]), uri: pl[i + 1].trim() });
    t += Number(m[1]);
  }
  const mapUri = pl.find((l) => l.includes("EXT-X-MAP"))?.match(/URI="([^"]+)"/)?.[1];
  const init = mapUri ? await soopFetch(`${dir}/${mapUri}`, { headers: UA }).then((r) => r.arrayBuffer()) : null;
  return { segs, dir, init };
}

/** 그 시각을 담은 세그먼트를 받는다. `init` 과 이어붙이면 재생 가능한 조각이 된다. */
export async function segmentAt({ segs, dir, init }, sec) {
  const idx = segs.findIndex((s) => sec >= s.start && sec < s.start + s.dur);
  if (idx < 0) return null;
  const buf = await soopFetch(`${dir}/${segs[idx].uri}`, { headers: UA }).then((r) => r.arrayBuffer());
  return { data: Buffer.concat([Buffer.from(init ?? []), Buffer.from(buf)]), offset: sec - segs[idx].start, bytes: buf.byteLength };
}
