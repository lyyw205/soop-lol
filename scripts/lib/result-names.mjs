/**
 * **결과창 이름 칸 확대본** — 원본 프레임에서 선수 이름 열만 잘라 2배로 키운다.
 *
 * ── 왜 ──────────────────────────────────────────────────────────────
 * 결과창의 한글 닉네임은 몇 픽셀 높이다. 전체 프레임을 넘기면 모델이 1568px 로 줄여 보며
 * 받침·모음 한 획이 뭉개진다 — 2026-10-09 까지의 오독이 전부 자모 하나 차이였다
 * (맨·멘·멤, 잣·잦, 바뜨엥용·바드앵용). 이름 열만 원본 해상도로 잘라 키우면 글자는 2.4배
 * 크게 보이고 이미지는 전체 프레임의 1/4 토큰이다(실측, 아래).
 *
 * ── 어디를 자르나: 고정 좌표가 아니라 화면 안의 기준점 ──────────────────
 * 방송마다 롤 창의 위치·크기·배율이 다르다. 대신 결과창 점수판은 선수 한 줄마다 왼쪽에
 * 3~4px 세로 띠가 있다 — 아군 청록(내 줄은 금색), 상대 빨강. 두 띠의 길이로 줄 높이 H 를 얻고,
 * 이름 칸은 띠에서 3.2H~6.8H 오른쪽이다. 창이 크든 작든 같은 비율로 따라간다.
 * 띠 색은 두 단계로 찾는다: 엄격(선명) → 느슨(창 비활성·방송 압축으로 흐린 띠).
 *
 * ── 못 찾으면 자르지 않는다 ─────────────────────────────────────────
 * 엉뚱한 곳을 확대해 주는 것이 못 자르는 것보다 위험하다. 그때는 원본만 본다.
 * 결과창이 브라우저 안에 작게 뜬 화면은 원본에 글자 픽셀이 없어 키워도 소용없다 — 그것도 안 자른다.
 *
 * ── 실측 (2026-10-09, 방송 판독 결과창 1,174장 · 방송 약 800개) ──────────
 *   찾음 869장(74%: 엄격 749 + 느슨 120). 무작위 14장 눈 확인 전부 정확.
 *   못 찾은 것: 브라우저 안 작은 결과창, 전적 웹페이지, 상세 정보 탭. 옛 대회 영상(2014~2020)은 화면이 달라 0%.
 *   토큰: 전체 프레임 ≈1,843 · 확대본 중앙 ≈483(최대 805). 모델이 보는 줄 높이 39px → 95px.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import sharp from "sharp";

/** 색 판정. 엄격이 실패했을 때만 느슨을 쓴다. [상대(빨강), 아군(청록·금색)] */
const LEVELS = {
  strict: [
    (r, g, b) => r > 110 && g < 70 && b < 110 && r - g > 70,
    (r, g, b) => (g > 110 && b > 110 && r < 70) || (r > 150 && g > 130 && b < 140 && r - b > 60),
  ],
  loose: [
    (r, g, b) => r > 90 && r - g > 35 && b < 120 && r - b > 20,
    (r, g, b) => (g > 85 && b > 85 && r < 85 && g - r > 35) || (r > 130 && g > 110 && b < 130 && r - b > 40),
  ],
};

/** 세로로 이어진 구간(작은 틈은 잇는다) 중 가장 긴 것 [시작, 끝] */
function longestRun(isOn, h, maxGap) {
  let best = null, start = -1, last = -1;
  for (let y = 0; y < h; y++) {
    if (!isOn(y)) continue;
    if (start < 0) { start = last = y; continue; }
    if (y - last <= maxGap) { last = y; continue; }
    if (!best || last - start > best[1] - best[0]) best = [start, last];
    start = last = y;
  }
  if (start >= 0 && (!best || last - start > best[1] - best[0])) best = [start, last];
  return best;
}

function allRuns(isOn, h, maxGap) {
  const out = []; let start = -1, last = -1;
  for (let y = 0; y < h; y++) {
    if (!isOn(y)) continue;
    if (start < 0) { start = last = y; continue; }
    if (y - last <= maxGap) { last = y; continue; }
    out.push([start, last]); start = last = y;
  }
  if (start >= 0) out.push([start, last]);
  return out;
}

function findWith(px, w, h, ch, [isRed, isTeam1]) {
  const at = (x, y) => { const i = (y * w + x) * ch; return [px[i], px[i + 1], px[i + 2]]; };
  const red = (x, y) => { const [r, g, b] = at(x, y); return isRed(r, g, b); };
  const team1 = (x, y) => { const [r, g, b] = at(x, y); return isTeam1(r, g, b); };
  const minRun = 0.12 * h; // 5줄이면 화면 높이의 20% 안팎
  // 열마다 빨강 칸 수를 먼저 센다 — 결과창이 아닌 프레임은 여기서 바로 끝난다.
  const counts = new Uint32Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (red(x, y)) counts[x]++;
  const cand = [];
  for (let x = 0; x < w; x++) {
    if (counts[x] < minRun * 0.5) continue;
    const run = longestRun((y) => red(x, y), h, 8);
    if (run && run[1] - run[0] >= minRun) cand.push({ x, s: run[0], e: run[1] });
  }
  if (!cand.length) return { why: "상대팀 띠 없음" };
  // 띠는 3~4px 폭이라 이웃 열이 같이 걸린다 → 가장 긴 것 근처의 중앙값
  const best = cand.reduce((a, c) => (c.e - c.s > a.e - a.s ? c : a));
  const near = cand.filter((c) => Math.abs(c.x - best.x) <= 6 && Math.abs(c.s - best.s) <= 12).map((c) => c.x).sort((a, b) => a - b);
  const x = near[Math.floor((near.length - 1) / 2)];
  const [s2, e2] = [best.s, best.e];
  let t = null;
  for (let dx = -6; dx <= 6; dx++) {
    const xx = x + dx;
    if (xx < 0 || xx >= w) continue;
    for (const [s, e] of allRuns((y) => team1(xx, y), h, 8)) {
      if (e < s2 && s2 - e < 0.12 * h && e - s >= 0.48 * (e2 - s2) && (!t || e - s > t[1] - t[0])) t = [s, e];
    }
  }
  if (!t) return { why: "아군 띠 없음" };
  const [s1, e1] = t;
  const ratio = (e1 - s1) / (e2 - s2);
  if (ratio < 0.8 || ratio > 1.25) return { why: `두 팀 길이 불일치 ${e1 - s1}:${e2 - s2}` };
  const rowH = ((e1 - s1) + (e2 - s2)) / 2 / 5;
  if (rowH < 20 || rowH > 120) return { why: `줄 높이 비정상 ${Math.round(rowH)}` };
  const box = { left: Math.trunc(x + 3.2 * rowH), top: Math.trunc(s1 - 0.1 * rowH) };
  box.width = Math.trunc(x + 6.8 * rowH) - box.left;
  box.height = Math.trunc(e2 + 0.1 * rowH) - box.top;
  if (box.left < 0 || box.top < 0 || box.left + box.width > w || box.top + box.height > h) return { why: "자를 영역이 화면 밖" };
  return { box, rowH: Math.round(rowH * 10) / 10, strip: x };
}

/**
 * 원시 RGB(A) 픽셀에서 이름 칸을 찾는다. 순수 함수 — 테스트가 여기를 잰다.
 * @returns {{box:{left:number,top:number,width:number,height:number}, rowH:number, strip:number, level:string} | {why:string}}
 */
export function findNameColumn(px, width, height, channels = 3) {
  let why = null;
  for (const [level, fns] of Object.entries(LEVELS)) {
    const got = findWith(px, width, height, channels, fns);
    if (got.box) return { ...got, level };
    why ??= got.why;
  }
  return { why };
}

/** `out/ck/<vod>/g0012156.jpg` → `out/ck/<vod>/names/g0012156.jpg`. g*.jpg 프레임 목록과 섞이지 않게 폴더를 나눈다. */
export const namesPathOf = (framePath) => join(dirname(framePath), "names", basename(framePath));

/**
 * 프레임 하나의 이름 칸 확대본을 만든다. 이미 있으면 그대로 쓴다.
 * @returns {Promise<{path:string, cached:boolean} | {why:string}>}
 */
export async function writeNameCrop(framePath) {
  const out = namesPathOf(framePath);
  if (existsSync(out) && statSync(out).size > 0) return { path: out, cached: true };
  const { data, info } = await sharp(framePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const found = findNameColumn(data, info.width, info.height, info.channels);
  if (!found.box) return { why: found.why };
  mkdirSync(dirname(out), { recursive: true });
  await sharp(framePath).extract(found.box)
    .resize(found.box.width * 2, found.box.height * 2, { kernel: "lanczos3" })
    .jpeg({ quality: 92 }).toFile(out);
  return { path: out, cached: false };
}
