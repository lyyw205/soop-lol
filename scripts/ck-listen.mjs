/**
 * 고른 구간의 **소리를 듣는다** — 음성을 받아 전사한다.
 *
 *   npm run ck:listen -- --vod 189903183 --at 600:120,4200:90
 *   npm run ck:listen -- --vod 189903183 --at 600:120 --engine qwen   # 같은 구간을 다시 읽는다
 *   npm run ck:listen -- --vod 189903183 --at 600:120 --dry-run
 *
 * ★ **보조 수단이다** (docs/CK-RESEARCH-PLAN.md §1·§3-C).
 *   기본 경로는 화면이고, 음성은 맥락이 필요할 때 고른 구간만 듣는다.
 *   이유는 계산 비용이 아니라 **확보 비용**이다 — 30분 표본에 HLS 298MB 를 받은 실측이 있다.
 *   그래서 오디오 전용 렌디션을 먼저 찾고, 없으면 최저 화질로 간다.
 *
 * ★ **전사는 단서다. 결과 판독의 정본이 아니다** (§3-C).
 *   ASR 은 인게임명·팀명을 곧잘 헛듣는다. 승패·라인업은 결과 화면이 정한다.
 *
 * ★ 시간축은 `ck:probe` 가 만든 `out/ck/<vodId>/probe.json` **하나**를 쓴다.
 *   ⚠ `scripts/asr/probe-vod.mjs` 는 API 의 duration 으로 축을 쌓는데, 그 값은 실제보다
 *     길게 보고하는 VOD 가 있다(docs/CK-COLLECTION.md). 축이 둘이면 프레임과 음성이
 *     서로 다른 자리를 가리킨다 — 그래서 여기서는 HLS 로 잰 축만 쓴다.
 *
 * ★ DB 에 쓰지 않는다. 읽은 구간은 조사자가 `ck:merge` 의 `scan.transcript_read` 에 적는다.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { hlsSegments, hms, segmentsSpan, vodDetail } from "./lib/soop-vod.mjs";

import { splitAudioRanges, audioManifest } from "./lib/ck-audio.ts";

const ROOT = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const vodId = flag("--vod");
const atSpec = flag("--at");
const engine = flag("--engine", "sensevoice");
const dryRun = args.includes("--dry-run");

if (!vodId || !/^\d+$/.test(vodId) || !atSpec) {
  console.error(`
사용법: npm run ck:listen -- --vod <VOD번호> --at <시작초:길이초,...> [--engine sensevoice|qwen] [--dry-run]

고른 구간의 음성을 받아 전사한다. 시각은 **VOD 전체 초**다(ck:probe 와 같은 축).
DB 에는 쓰지 않는다 — 읽은 구간은 ck:merge 의 scan.transcript_read 에 적는다.

  --engine sensevoice  기본. 빠르다
  --engine qwen        같은 구간을 다시 읽어볼 때

⚠ 전사는 **단서**다. 승패·라인업은 결과 화면이 정한다.
`.trim());
  process.exit(1);
}
if (!["sensevoice", "qwen"].includes(engine)) {
  console.error(`--engine 은 sensevoice 또는 qwen 이어야 한다. 받은 값: ${engine}`);
  process.exit(1);
}

const probePath = join(ROOT, "out", "ck", String(vodId), "probe.json");
if (!existsSync(probePath)) {
  console.error(`시간축이 없다: ${probePath}\n  먼저 돌릴 것:  npm run ck:probe -- --vod ${vodId}`);
  process.exit(1);
}
const probe = JSON.parse(readFileSync(probePath, "utf8"));

const requested = atSpec.split(",").map((x) => x.split(":").map(Number));
if (requested.some((r) => r.length !== 2 || !Number.isFinite(r[0]) || r[0] < 0 || !Number.isFinite(r[1]) || r[1] <= 0 || !Number.isFinite(r[0] + r[1]))) {
  console.error("--at 은 `시작초:길이초` 꼴이어야 한다. 예: 600:120,4200:90");
  process.exit(1);
}

// ── 분할 파일 경계에서 **쪼갠다** ────────────────────────────────────
//
// ★ 여기가 계획 §6 이 "분할 파일 경계 처리를 연결한다" 고 한 자리다.
//   `scripts/asr/sample-vod.mjs` 는 경계를 넘는 구간을 만나면 throw 한다. 그러면 조사자가
//   경계를 피해 구간을 다시 잡아야 하는데, 경계가 어디인지는 조사의 관심사가 아니다.
//   요청은 **VOD 전체 축**으로 받고, 파일 경계는 도구가 알아서 나눈다.
const { pieces, outOfRange } = splitAudioRanges(requested, probe.parts);

const split = pieces.length - requested.length;
console.log(`\n${probe.title ?? vodId}`);
console.log(`구간 ${requested.length}개 → 조각 ${pieces.length}개`
  + `${split > 0 ? `  (분할 파일 경계에서 ${split}번 쪼갰다)` : ""}`);
for (const p of pieces) {
  console.log(`  ${hms(p.at)} +${p.span}s   f${p.part.index}`);
}
if (outOfRange.length > 0) {
  console.log(`  ⚠ 범위 밖이라 못 듣는 구간: ${outOfRange.map(([a, b]) => `${hms(a)}~${hms(b)}`).join(", ")}`);
}
if (dryRun) { console.log(`\n(dry-run — 받지 않았다)`); process.exit(0); }

// ── 음성을 받는다 ───────────────────────────────────────────────────
//
// `.local/asr/` 아래에 둔다 — 모델·캐시와 같은 자리이고 gitignore 다.
const runDir = join(ROOT, ".local", "asr", "runs", `ck-${vodId}`);
const audioDir = join(runDir, "audio");
mkdirSync(audioDir, { recursive: true });

const writeManifest = (clips, failed) => writeFileSync(join(runDir, "samples.json"), `${JSON.stringify(audioManifest({
  vodId: Number(vodId), title: probe.title ?? null, vodSeconds: probe.total_sec,
  plannedRanges: requested, outOfRange, clips, failed,
}), null, 2)}\n`);
if (pieces.length === 0) {
  writeManifest([], []);
  console.error("요청한 구간이 이 VOD 의 범위 밖이다. samples.json 에 제외 구간을 기록했다.");
  process.exit(1);
}

const detail = await vodDetail(vodId);
const files = detail?.files ?? [];
const hlsCache = new Map();
const clips = [];
const failed = [];
let mb = 0;

for (const piece of pieces) {
  const id = `g${String(piece.at).padStart(7, "0")}-s${Math.round(piece.span)}`;
  const wav = join(audioDir, `${id}.wav`);
  if (existsSync(wav)) {           // 재개 — 이미 받은 조각은 건너뛴다
    clips.push({ id, at: piece.at, seconds: piece.span, audio: wav, cached: true });
    continue;
  }

  const file = files[piece.part.index - 1];
  if (!file) { failed.push({ at: piece.at, why: `f${piece.part.index} 파일이 없다` }); continue; }

  try {
    if (!hlsCache.has(piece.part.index)) {
      // ★ 오디오 우선. 없으면 최저 화질 — 1080p 로 소리를 뜨면 수십 배를 받는다.
      hlsCache.set(piece.part.index, await hlsSegments(file, { prefer: "audio" }));
    }
    const hls = hlsCache.get(piece.part.index);
    const local = piece.at - piece.part.offset_sec;
    const got = await segmentsSpan(hls, local, piece.span);
    if (!got) { failed.push({ at: piece.at, why: "그 시각의 세그먼트가 없다" }); continue; }
    mb += got.bytes / 1_048_576;

    const tmp = join(runDir, `${id}.src`);
    writeFileSync(tmp, got.data);
    // transcribe.py 가 요구하는 모양: 모노 16kHz PCM
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", tmp,
      "-ss", String(got.offset), "-t", String(piece.span),
      "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav],
      { timeout: 180_000 });
    unlinkSync(tmp);
    clips.push({ id, at: piece.at, seconds: piece.span, audio: wav, cached: false });
    process.stdout.write(`\r  받는 중 ${clips.length}/${pieces.length}  ${hms(piece.at)}   `);
  } catch (e) {
    failed.push({ at: piece.at, why: String(e.message).slice(0, 80) });
  }
}
console.log(`\r  음성 ${clips.length}조각 (새로 받은 것 ${clips.filter((c) => !c.cached).length}) · 내려받기 ${mb.toFixed(1)}MB`
  + `${hlsCache.size > 0 && [...hlsCache.values()][0].audioOnly ? " · 오디오 전용 트랙" : " · 오디오 전용 트랙 없음(최저 화질로 받았다)"}       `);

if (failed.length > 0) {
  console.log(`  ⚠ 못 받은 조각 ${failed.length}개 — 그 구간은 **안 들은 것**이다:`);
  for (const f of failed) console.log(`     ${hms(f.at)}  ${f.why}`);
}

// transcribe.py 가 읽는 manifest.
// `complete` 는 **요청한 조각을 다 받았나**다 — 못 받은 게 있으면 false 로 두어야
// 전사가 "이게 그 구간의 전부" 라고 말하지 않는다.
writeManifest(clips, failed);
if (clips.length === 0) { console.error("받은 음성이 없다."); process.exit(1); }

if (failed.length > 0) {
  console.error(`\n못 받은 조각이 있어 전사를 돌리지 않는다. 구간을 좁혀 다시 시도할 것.`);
  process.exit(1);
}

// ── 전사 ────────────────────────────────────────────────────────────
console.log(`\n전사 (${engine}) …`);
try {
  execFileSync("bash", [join(ROOT, "scripts", "asr", "transcribe.sh"), engine, join(runDir, "samples.json")],
    { stdio: "inherit", timeout: 3_600_000 });
} catch (e) {
  console.error(`\n전사가 실패했다: ${String(e.message).slice(0, 200)}`);
  console.error(`  설치 확인:  bash scripts/asr/check.sh ${engine}`);
  process.exit(1);
}

// 읽기 좋은 대본을 out/ck 아래로 옮긴다 — 조사자가 여는 것은 여기다.
const txt = join(runDir, `${engine}.txt`);
if (existsSync(txt)) {
  const dest = join(ROOT, "out", "ck", String(vodId), `${engine}.txt`);
  const body = readFileSync(txt, "utf8");
  writeFileSync(dest, body);
  console.log(`\nout/ck/${vodId}/${engine}.txt  (${body.split("\n\n").length}토막)`);
  console.log(`시각은 VOD 전체 초다 — 프레임(g<초>.jpg)과 같은 축이다.\n`);
  console.log(body.split("\n\n").slice(0, 6).join("\n"));
  console.log(`\n다음:`);
  console.log(`  · 본문을 **읽고** 무엇을 알았는지 정한다 (파일 생성·검색만으로는 읽은 게 아니다)`);
  console.log(`  · 읽은 구간을 scan-draft.json 의 scan.transcript_read 에 적는다`);
  console.log(`  · ⚠ 전사는 단서다. 승패·라인업은 결과 화면(g<초>.jpg)이 정한다`);
}
