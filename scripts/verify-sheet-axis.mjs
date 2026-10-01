/**
 * 썸네일 칸 ↔ VOD 초 대응 검증 — 이미 받아 둔 원본 프레임(out/ck/<vod>/g*.jpg)과 비교한다.
 *
 *   node scripts/verify-sheet-axis.mjs --vod 207602969 [--max 400]
 *
 * 원본을 192×108 로 줄여 대응 칸 주변 ±100칸(±5분)과 픽셀 차이를 재고, 가장 비슷한 칸의 오프셋을 모은다.
 *   · 정지 화면(여러 칸이 다 비슷)은 빼고 **뚜렷한 표본만** 쓴다
 *   · 한 장이 빗나가는 건 흔하다(비슷한 메뉴가 멀리 있다). 그래서 파일을 세 토막으로 나눠 **중앙 오프셋**을 본다
 *   · ±1칸은 3초 샘플 간격으로 설명되는 차이다(원본 101초 ↔ 썸네일 99·102초)
 * 합격: 모든 토막의 중앙 오프셋이 ±1칸 안. 종료 코드 1 = 불합격.
 * 실측(207602969, 원본 313장): 뚜렷 287장 중 −1칸 107 · 0칸 93, 나머지는 양방향으로 흩어진 잡음.
 * 옛 대응(column 0 포함, 길이 ÷ 칸 수)은 앞쪽에서 최대 +100칸 어긋났다 — 이 검사가 그걸 잡는다.
 */
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { vodDetail, hms } from "./lib/soop-vod.mjs";
import { cellIndexAt, cellOf, decodeSheet, fetchSheets, measureParts, PER_SHEET } from "./lib/vod-timeline.mjs";

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const vodId = flag("--vod");
const max = Number(flag("--max", 400));
if (!vodId) { console.error("사용법: node scripts/verify-sheet-axis.mjs --vod <번호> [--max 400]"); process.exit(1); }
const dir = join("out/ck", vodId);
const originals = readdirSync(dir).filter((f) => /^g\d{7}\.jpg$/.test(f)).map((f) => ({ at: Number(f.slice(1, 8)), path: join(dir, f) }))
  .sort((a, b) => a.at - b.at);
if (!originals.length) { console.error(`${dir} 에 원본 프레임(g*.jpg)이 없다`); process.exit(1); }
const step = Math.max(1, Math.ceil(originals.length / max));
const sample = originals.filter((_, i) => i % step === 0);

const detail = await vodDetail(vodId);
const { parts } = await measureParts(detail);
const sheetsOf = new Map();
for (const p of parts) {
  const got = await fetchSheets(p.file, p.length, { cacheDir: join(dir, "sheets", `f${p.index}`) });
  sheetsOf.set(p.index, got);
  console.log(`f${p.index} ${hms(p.offset)}~${hms(p.offset + p.length)} 칸 ${got.cells}${got.failed.length ? ` ⚠ 못 덮음 ${JSON.stringify(got.failed)} (${got.reason})` : ""}`);
}

const decoded = new Map();
const sheetImg = (pi, k) => {
  const key = `${pi}:${k}`;
  if (!decoded.has(key)) {
    if (decoded.size > 8) decoded.delete(decoded.keys().next().value);
    decoded.set(key, decodeSheet(sheetsOf.get(pi).sheets[k].buf));
  }
  return decoded.get(key);
};
const small = (path) => execFileSync("ffmpeg", ["-v", "error", "-i", path, "-vf", "scale=192:108", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
const mse = (rgb, cell) => {
  let s = 0;
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
    const a = rgb[i] - cell.data[j], b = rgb[i + 1] - cell.data[j + 1], c = rgb[i + 2] - cell.data[j + 2];
    s += a * a + b * b + c * c;
  }
  return s / (rgb.length / 3);
};

const byPart = new Map();
for (const o of sample) {
  const p = parts.find((x) => o.at >= x.offset && o.at < x.offset + x.length);
  if (!p) continue;
  const got = sheetsOf.get(p.index);
  const pos = cellIndexAt(got.sheets, got.cells, o.at - p.offset);
  if (!pos) continue;
  const rgb = small(o.path);
  const scores = [];
  for (let d = -100; d <= 100; d++) {
    const i = pos.index + d;
    if (i < 0 || i >= got.cells) continue;
    scores.push({ d, e: mse(rgb, cellOf(sheetImg(p.index, Math.floor(i / PER_SHEET)), i % PER_SHEET)) });
  }
  const best = scores.reduce((a, b) => (b.e < a.e ? b : a));
  const sorted = scores.map((x) => x.e).sort((x, y) => x - y);
  // 최선이 중앙값의 절반 아래일 때만 "뚜렷하다" — 정지 화면은 대응 검증에 쓰지 않는다.
  const distinct = best.e < sorted[Math.floor(sorted.length / 2)] * 0.5;
  const row = byPart.get(p.index) ?? [];
  row.push({ at: o.at, d: best.d, distinct });
  byPart.set(p.index, row);
}

// 한 장씩 판정하지 않는다 — 비슷한 메뉴 화면이 멀리 있으면 한 장은 쉽게 빗나간다.
// 파일을 시간순 세 토막으로 나눠 뚜렷한 표본의 **중앙 오프셋**을 본다. 옛 대응은 앞 토막에서 수십 칸 밀렸다.
let bad = false;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
for (const [pi, rows] of byPart) {
  const ds = rows.filter((r) => r.distinct);
  const within = ds.filter((r) => Math.abs(r.d) <= 2).length;
  const thirds = [0, 1, 2].map((k) => ds.slice(Math.floor((ds.length * k) / 3), Math.floor((ds.length * (k + 1)) / 3)).map((r) => r.d));
  const meds = thirds.map(median);
  const off = meds.some((m) => m != null && Math.abs(m) > 1);
  bad ||= off;
  console.log(`f${pi}: 표본 ${rows.length} (뚜렷 ${ds.length}, 정지 화면 ${rows.length - ds.length}) · ±2칸 안 ${within}/${ds.length}`
    + ` · 토막별 중앙 오프셋 ${meds.map((m) => (m == null ? "-" : `${m > 0 ? "+" : ""}${m}`)).join(" / ")}${off ? "  ✗" : ""}`);
}
console.log(bad ? "\n불합격 — 토막 중앙 오프셋이 한 칸을 넘는다" : "\n합격 — 모든 토막의 중앙 오프셋이 ±1칸(3초 샘플 간격) 안");
process.exit(bad ? 1 : 0);
