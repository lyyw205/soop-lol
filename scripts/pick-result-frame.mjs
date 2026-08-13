/**
 * **경기마다 결과창 한 장을 고른다.**
 *
 *   npm run ck:pick -- out/ck/2026-07-15
 *   npm run ck:pick -- out/ck/2026-07-15 --top 2 --copy out/pick/2026-07-15
 *
 * ★ 왜 필요한가
 *   `RESULT_OFFSETS` 는 경기 종료 지점 하나에 6장을 남긴다(언제 결과창이 뜰지
 *   모르니까). 한 달치면 570장이 되는데, 그중 실제로 점수판이 보이는 건
 *   경기당 한두 장뿐이다. 나머지는 아직 인게임이거나 이미 알트탭한 화면이다.
 *
 * ★ ⚠ 밝기 정렬은 **믿을 게 못 된다** — 실측하고 남긴다 (2026-08-13)
 *   "협곡은 어둡고 결과창은 밝은 패널이니 제일 밝은 장을 고르면 된다"고 짰는데,
 *   2026-08-08 정답 프레임으로 재 보니 분리가 안 된다:
 *
 *       승리 점수판  밝기 76 / 채도 9.6      브라우저   밝기 70 / 채도 12.0
 *       패배 점수판  밝기 79 / 채도 9.1      인게임     밝기 88 / 채도 11.3
 *       패배 점수판  밝기 64 / 채도 9.8      메모장 위  밝기 168 / 채도 5.5
 *
 *   브라우저·메모장이 결과창보다 밝아서 상위를 차지한다. 실제로 7월 94경기에
 *   돌렸더니 고른 것 대부분이 브라우저였다. **전역 통계로는 UI 를 못 알아본다** —
 *   192×108 썸네일로 게임 종류를 가르려다 실패한 것과 같은 종류의 착각이다
 *   (docs/CK-COLLECTION.md §4).
 *
 *   → 정렬은 참고만 하고, 실제 선별은 `npm run ck:sheet` 로 **전부 붙여 놓고 눈으로**
 *     한다. 이 스크립트에서 아직 쓸모 있는 건 **경기 단위 그룹 나누기** 쪽이다.
 *
 * 같은 경기 그룹은 파일명으로 묶는다: 같은 VOD·같은 파일에서 30초 안에 든 것.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { makeOpt } from "./lib/cli.mjs";

const args = process.argv.slice(2);
const opt = makeOpt(args);
const DIR = args.find((a) => !a.startsWith("--"));
const TOP = Number(opt("--top", 1));
const COPY = opt("--copy", "");
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
/** 같은 경기로 묶을 간격. RESULT_OFFSETS 가 -6~+24 라 30초면 한 그룹이 된다. */
const GROUP_GAP = 40;

if (!DIR || !existsSync(DIR)) {
  console.error("쓸 폴더를 달라:  npm run ck:pick -- out/ck/<날짜>");
  process.exit(1);
}

/**
 * `lshooooo_203701037_f4_22016.jpg` → {vod, file, sec}
 *
 * ⚠ 시각 자릿수는 고정이 아니다. `hms()` 가 `H:MM:SS` 를 내는데 시가 한 자리면
 *   `22016`(2:20:16), 열 시간이 넘으면 `102016` 이 된다. **뒤에서부터** 자른다.
 */
function parse(name) {
  const m = /^(.+?)_(\d+)_f(\d+)_(\d{5,6})\.jpg$/.exec(name);
  if (!m) return null;
  const t = m[4];
  const ss = Number(t.slice(-2)), mm = Number(t.slice(-4, -2)), hh = Number(t.slice(0, -4));
  return { ch: m[1], vod: m[2], file: Number(m[3]), t, sec: hh * 3600 + mm * 60 + ss };
}

/** 화면 평균 밝기. 결과창은 밝은 패널이라 협곡보다 확실히 높다. */
function brightness(path) {
  const out = execFileSync(FFMPEG,
    // ★ `file=-` 로 **stdout** 에 뽑는다. 기본값은 로그(stderr)라 `-v error` 에 먹힌다.
    ["-v", "error", "-i", path,
      "-vf", "signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-",
      "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const m = /YAVG=([\d.]+)/.exec(out);
  return m ? Number(m[1]) : 0;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".jpg")).map(parse).filter(Boolean)
  .sort((a, b) => a.vod.localeCompare(b.vod) || a.file - b.file || a.sec - b.sec);

// 그룹으로 자른다 — 같은 VOD·파일에서 GROUP_GAP 안에 붙어 있으면 한 경기다.
const groups = [];
for (const f of files) {
  const g = groups[groups.length - 1];
  if (g && g[0].vod === f.vod && g[0].file === f.file && f.sec - g[g.length - 1].sec <= GROUP_GAP) g.push(f);
  else groups.push([f]);
}
// 결과창 앵커는 6장씩이다. 1~2장짜리 그룹은 판독용 스캔 프레임이라 뺀다.
const ends = groups.filter((g) => g.length >= 4);

console.log(`프레임 ${files.length}장 → 경기 ${ends.length}건 (그룹 ${groups.length}개 중 4장 이상)\n`);
if (COPY) mkdirSync(COPY, { recursive: true });

for (const g of ends) {
  // 이름은 **원본 문자열을 그대로** 쓴다. 초에서 되돌리면 자릿수를 틀린다.
  const scored = g.map((f) => {
    const name = `${f.ch}_${f.vod}_f${f.file}_${f.t}.jpg`;
    return { name, y: brightness(join(DIR, name)) };
  }).sort((a, b) => b.y - a.y);

  const hms = (s) => `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  console.log(`${g[0].vod} f${g[0].file} ${hms(g[0].sec)}  밝기 ${scored.map((s) => s.y.toFixed(0)).join(" ")}`);
  for (const s of scored.slice(0, TOP)) {
    console.log(`   → ${basename(s.name, ".jpg")}  (밝기 ${s.y.toFixed(0)})`);
    if (COPY) copyFileSync(join(DIR, s.name), join(COPY, s.name));
  }
}
