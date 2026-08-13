/**
 * **확인 프레임을 격자로 붙인다.** 한 달치를 몇 장으로 판정하려고 만들었다.
 *
 *   npm run ck:sheet -- out/confirm/2026-07-01
 *   npm run ck:sheet -- out/confirm/2026-07-01 --cols 4 --rows 4
 *
 * ★ 왜 필요한가
 *   시트 훑기는 롤과 FC온라인을 못 가른다(docs/CK-COLLECTION.md §4). 그래서 경기
 *   구간마다 원본 프레임을 한 장씩 남기는데, 한 달치면 100~200장이 된다.
 *   한 장씩 열어 보면 판정에만 하루가 간다. 격자로 붙이면 **16장을 한 번에** 본다.
 *
 * ★ 타일 크기를 줄이지 마라
 *   480×270 이 하한이다. 그 아래로 가면 협곡과 축구장이 다시 같아 보인다 —
 *   애초에 192×108 썸네일로 판정하려다 오탐 67% 를 낸 게 이 프로젝트의 교훈이다.
 *
 * ★ 이름표는 안 그린다
 *   drawtext 는 한글 폰트가 있어야 하고 환경마다 없다. 대신 **순서를 고정**하고
 *   자리표(행,열)를 터미널에 찍는다. 격자는 왼→오, 위→아래로 채운다.
 *
 * 프레임은 지워도 된다. 판정 결과는 event_lead.state 에 남는다.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { makeOpt } from "./lib/cli.mjs";

const args = process.argv.slice(2);
const opt = makeOpt(args);
const DIR = args.find((a) => !a.startsWith("--"));
const COLS = Number(opt("--cols", 4));
const ROWS = Number(opt("--rows", 4));
/** 타일 한 변. 480 아래로 내리면 협곡과 축구장이 구분이 안 된다. */
const TW = Number(opt("--tile-width", 480));
const TH = Math.round((TW * 9) / 16);
const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";

if (!DIR || !existsSync(DIR)) {
  console.error(`쓸 폴더를 달라:  npm run ck:sheet -- out/confirm/<날짜>`);
  process.exit(1);
}

const frames = readdirSync(DIR).filter((f) => f.endsWith(".jpg")).sort();
if (frames.length === 0) {
  console.error(`${DIR} 에 프레임이 없다.`);
  process.exit(1);
}

const OUT = join(DIR, "sheets");
mkdirSync(OUT, { recursive: true });

const per = COLS * ROWS;
const sheets = Math.ceil(frames.length / per);
console.log(`프레임 ${frames.length}장 → 대조 시트 ${sheets}장 (${COLS}×${ROWS} · 타일 ${TW}×${TH})\n`);

for (let s = 0; s < sheets; s++) {
  const chunk = frames.slice(s * per, (s + 1) * per);
  const out = join(OUT, `sheet-${String(s + 1).padStart(2, "0")}.jpg`);

  // 입력마다 scale→pad 로 같은 크기를 만든 뒤 xstack 으로 붙인다.
  // (tile 필터는 입력이 하나여야 해서 여러 파일에는 못 쓴다)
  const inputs = chunk.flatMap((f) => ["-i", join(DIR, f)]);
  const scaled = chunk
    .map((_, i) => `[${i}:v]scale=${TW}:${TH}:force_original_aspect_ratio=decrease,`
      + `pad=${TW}:${TH}:(ow-iw)/2:(oh-ih)/2:black,drawbox=x=0:y=0:w=iw:h=ih:color=white@0.35:t=2[v${i}]`)
    .join(";");
  const layout = chunk
    .map((_, i) => `${(i % COLS) * TW}_${Math.floor(i / COLS) * TH}`)
    .join("|");
  const filter = `${scaled};${chunk.map((_, i) => `[v${i}]`).join("")}`
    + `xstack=inputs=${chunk.length}:layout=${layout}:fill=black[out]`;

  execFileSync(FFMPEG, ["-v", "error", ...inputs, "-filter_complex", filter,
    "-map", "[out]", "-frames:v", "1", "-q:v", "4", "-y", out], { stdio: "inherit" });

  console.log(`■ ${out}`);
  for (let i = 0; i < chunk.length; i++) {
    const r = Math.floor(i / COLS) + 1, c = (i % COLS) + 1;
    console.log(`   ${r}행 ${c}열  ${basename(chunk[i], ".jpg")}`);
  }
  console.log();
}
