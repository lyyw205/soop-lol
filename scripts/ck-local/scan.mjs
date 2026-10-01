/**
 * ck-local 실험 — 학습한 결과창 판별기로 **결과창 후보**를 고르고 원본까지 받아 둔다. Claude 는 고르고 읽기만 한다.
 *
 *   npm run ck:local -- --vod <번호>                                     # 준비: 판별 + 후보 원본 + 몽타주
 *   npm run ck:local -- --vod <번호> --strip 0:44:00~0:48:00 [--step 10] # 띠: 그 구간 썸네일 한 장 (안전장치)
 *   npm run ck:local -- --review --vod <번호> --run <run_id> --cand 3 --is result|ingame|client|other   # 후보 판정 → 학습 데이터
 *   npm run ck:local -- --review --vod <번호> --run <run_id> --opened candidates-1.jpg,overview-1.jpg [--note "…"]
 *   npm run ck:local -- --review --vod <번호> --run <run_id> --merged done|running|failed [--note "…"]
 *
 * 흐름 (docs/CK-LOCAL-DETECTOR.md):
 *   ① 공용 시간축(scripts/lib/vod-timeline.mjs)으로 썸네일 시트를 받는다(3초 칸)
 *   ② 판별기(detector/detect.py — SigLIP + 학습한 분류기)가 모든 칸에 결과창 점수 → 이어진 덩어리 = 후보
 *   ③ 후보마다 점수가 가장 높은 시각과 파일마다 끝 지점의 원본을 ck:probe 로 받는다
 *   ④ 후보 몽타주(후보 칸) · 개요 몽타주(2분 칸, 후보가 있는 칸은 분홍)
 * 판별기가 고르는 건 "어디를 볼지"뿐이다. 결과창인지·몇 판인지·같은 판인지는 Claude 가 ck-research 규칙으로 정한다.
 * Claude 의 후보 판정(--cand --is)은 out/ck-detector/review-labels.jsonl 에 쌓여 다음 학습에 쓰인다.
 *
 * ★ DB 에 아무것도 쓰지 않는다. out/ck/<vod>/ · out/ck-detector/ · out/ck/local-ledger.jsonl 에만 쓴다.
 * ★ 실험 도구다. 지우는 법은 .claude/skills/ck-local/SKILL.md 「지우기」.
 * 종료 코드: 0 완료 · 1 사용법 · 2 판별기 없음/실패 · 3 VOD 없음(삭제·비공개 가능)
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { mergeRanges, subtractRanges } from "@soop-lol/core/lib/metrics/ranges";

import { hms, vodBroadcastTimes, vodDetail } from "../lib/soop-vod.mjs";
import { cellIndexAt, cellOf, coveragePoints, decodeSheet, fetchSheets, measureParts } from "../lib/vod-timeline.mjs";
import { encode, montage } from "./image.mjs";

const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const vodId = flag("--vod");
if (!vodId || !/^\d+$/.test(vodId)) { console.error("사용법은 파일 머리말을 본다: scripts/ck-local/scan.mjs"); process.exit(1); }
const dir = join("out/ck", vodId, "local");
const LEDGER = "out/ck/local-ledger.jsonl";
mkdirSync(dir, { recursive: true });
const writeJson = (path, value) => { writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`); renameSync(`${path}.tmp`, path); };
const ledger = (row) => appendFileSync(LEDGER, `${JSON.stringify({ at: new Date().toISOString(), vod: Number(vodId), ...row })}\n`);
const statePath = join(dir, "scan.json");

// ── 검산 기록 ───────────────────────────────────────────────────────
// ★ 현재 scan.json 의 run_id 와 다른 기록은 받지 않는다 — 옛 산출물을 새 결과로 오인하지 않게.
if (args.includes("--review")) {
  const run = flag("--run");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  if (!state || state.run_id !== run) {
    console.error(`run_id 가 현재 산출물과 다르다 (현재 ${state?.run_id ?? "없음"}, 받은 값 ${run}). 이번 실행의 산출물만 기록한다.`);
    process.exit(1);
  }
  const entry = { at: new Date().toISOString(), run_id: run, note: flag("--note") };
  if (flag("--opened")) entry.opened = flag("--opened").split(",").map((s) => s.trim()).filter(Boolean);
  if (flag("--cand")) {
    const n = Number(flag("--cand")), is = flag("--is");
    const c = state.candidates?.find((x) => x.n === n);
    if (!c) { console.error(`후보 #${n} 이 이 실행에 없다`); process.exit(1); }
    if (!["result", "ingame", "client", "other"].includes(is)) { console.error("--is 는 result|ingame|client|other"); process.exit(1); }
    Object.assign(entry, { cand: n, is });
    // ★ 학습 데이터 — 후보의 가장 높은 칸 시각에 Claude 가 본 라벨. 학습(train.py)이 검수 라벨로 읽는다.
    appendFileSync("out/ck-detector/review-labels.jsonl", `${JSON.stringify({ vod: Number(vodId), at: c.peak, label: is, source: `ck-local:${run}` })}\n`);
  }
  if (flag("--merged")) {
    if (!["done", "running", "failed"].includes(flag("--merged"))) { console.error("--merged 는 done|running|failed"); process.exit(1); }
    entry.merged = flag("--merged");
    ledger({ kind: "claude", run_id: run, merged: entry.merged, note: entry.note });
  }
  const reviewPath = join(dir, "review.json");
  const review = existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, "utf8")) : { entries: [] };
  review.entries.push(entry);
  writeJson(reviewPath, review);
  console.log("기록했다:", JSON.stringify(entry));
  process.exit(0);
}

// ── 공통: 시간축과 썸네일 ─────────────────────────────────────────────
const detail = await vodDetail(vodId);
if (!detail) { console.error(`VOD 를 찾지 못했다: ${vodId} — 삭제·비공개일 수 있다. 확인 전에는 접근 불가로 단정하지 않는다.`); process.exit(3); }
const quiet = args.includes("--strip");
const { parts, total, failed: axisFailed } = await measureParts(detail, { log: quiet ? () => {} : (m) => console.log(m) });
const failed = [...axisFailed];
for (const p of parts) {
  if (!p.axisReliable) {
    // 앞 파일 길이를 모르면 이 파일의 전역 시작을 모른다 — 썸네일 시각을 다른 도구와 맞출 수 없다.
    p.sheetsGot = null;
    failed.push([Math.round(p.offset), Math.round(p.offset + p.length)]);
    if (!quiet) console.log(`  f${p.index}  ⚠ 시간축 미확인(앞 파일 길이 모름) — 이 파일은 원본으로 본다`);
    continue;
  }
  const got = await fetchSheets(p.file, p.length, { cacheDir: join("out/ck", vodId, "sheets", `f${p.index}`) });
  p.sheetsGot = got;
  for (const [a, b] of got.failed) failed.push([Math.round(p.offset + a), Math.round(p.offset + b)]);
  if (!quiet) console.log(`  f${p.index}  ${hms(p.offset)}~${hms(p.offset + p.length)}  칸 ${got.cells}${got.failed.length ? `  ⚠ ${got.reason} → ${got.failed.map(([a, b]) => `${hms(p.offset + a)}~${hms(p.offset + b)}`).join(", ")} 원본으로` : ""}`);
}
const failedMerged = mergeRanges(failed);
const inFailed = (t) => failedMerged.some(([a, b]) => t >= a && t <= b);
let decoded = { key: null, img: null };
function cellAt(t) {
  const p = parts.find((x) => t >= x.offset && t < x.offset + x.length);
  const got = p?.sheetsGot;
  if (!got) return null;
  const pos = cellIndexAt(got.sheets, got.cells, t - p.offset);
  if (!pos) return null;
  const sheet = got.sheets[pos.sheet];
  if (decoded.key !== sheet.sha) decoded = { key: sheet.sha, img: decodeSheet(sheet.buf) };
  // 실제로 보는 칸의 시각 — 요청 시각과 최대 3초 다르다.
  return { img: cellOf(decoded.img, pos.cell), at: Math.round(p.offset + pos.at), key: `${sheet.sha.slice(0, 16)}:${pos.cell}` };
}
const blankTile = { width: 192, height: 108, data: new Uint8Array(192 * 108 * 4) };
const DARK = [40, 40, 40];

// ── 띠: Claude 가 고른 구간의 썸네일을 한 장으로. 모델을 부르지 않는다 ─────────
if (flag("--strip")) {
  const sec = (s) => s.trim().split(":").map(Number).reduce((a, b) => a * 60 + b, 0);
  const m = /^(.+)~(.+)$/.exec(flag("--strip"));
  const step = Number(flag("--step", 10));
  if (!m || !(step >= 3)) { console.error("--strip 은 시작~끝(예: 0:44:00~0:48:00 또는 2640~2880), --step 은 3 이상"); process.exit(1); }
  const from = sec(m[1]), to = Math.min(sec(m[2]), Math.floor(total) - 1);
  if (!(to > from)) { console.error("구간이 비었다"); process.exit(1); }
  const MAX = 60;   // 한 장 60칸(10×6). 넘으면 장을 나눈다 — 칸을 줄이지 않는다.
  const points = [];
  for (let t = from; t <= to; t += step) points.push(t);
  const files = [];
  for (let p = 0; p * MAX < points.length; p++) {
    const tiles = points.slice(p * MAX, (p + 1) * MAX).map((t) => {
      const c = inFailed(t) ? null : cellAt(t);
      return { img: c?.img ?? blankTile, color: DARK, label: hms(c?.at ?? t) };
    });
    const file = `strip-${from}-${to}-s${step}${points.length > MAX ? `-${p + 1}` : ""}.jpg`;
    writeFileSync(join(dir, file), encode(montage(tiles, 10), 85));
    files.push(file);
  }
  const missing = points.filter((t) => inFailed(t) || !cellAt(t)).length;
  console.log(`띠 ${hms(from)}~${hms(to)} · ${step}초 간격 ${points.length}칸${missing ? ` · 썸네일 없는 칸 ${missing}(검은 칸 — 원본으로)` : ""}`);
  for (const f of files) console.log(`  out/ck/${vodId}/local/${f}`);
  process.exit(0);
}

// ── 준비: 판별기 후보 + 원본 + 몽타주 ─────────────────────────────────
const PY = "out/ck-detector/venv/bin/python";
const started = Date.now();
const runId = `${new Date(started).toISOString()}-${process.pid}`;
if (!existsSync(PY) || !existsSync("out/ck-detector/model/siglip/clf.npz")) {
  console.error("판별기가 없다 — out/ck-detector/venv 와 model/siglip/clf.npz 가 필요하다(docs/CK-LOCAL-DETECTOR.md).");
  process.exit(2);
}
console.log(`\n${detail.title ?? "(제목 없음)"}  ·  run ${runId}`);

// ② 판별 — 시트 목록을 파이썬에 넘긴다(시트 k = column k+1, column 0 중복은 이미 뺐다)
const sheetsMeta = {
  vod: Number(vodId),
  parts: parts.map((p) => ({ index: p.index, offset: p.offset, length: p.length, reliable: Boolean(p.sheetsGot),
    cells: p.sheetsGot?.cells ?? 0, sheets: (p.sheetsGot?.sheets ?? []).map((x) => join("out/ck", vodId, "sheets", `f${p.index}`, `c${x.column}.jpg`)) })),
};
writeJson(join(dir, "sheets.json"), sheetsMeta);
let det;
try {
  det = JSON.parse(execFileSync(PY, ["scripts/ck-local/detector/detect.py", "--meta", join(dir, "sheets.json")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
} catch (e) {
  console.error(`판별 실패: ${String(e.message).slice(0, 200)}`);
  process.exit(2);
}
const candidates = det.candidates.map((c, i) => ({ n: i + 1, ...c }));
console.log(`  판별 ${det.cells}칸 → 결과창 후보 ${candidates.length}개 (문턱 ${det.threshold} · ${det.min_len}칸 이상)`);

// ③ 원본 — 후보마다 가장 높은 칸 + 파일마다 끝 지점. ck:probe 가 out/ck/<vod>/g<초>.jpg 로 받는다(이미 있으면 건너뛴다).
const fileTails = parts.filter((p) => p.length > 0)
  .map((p) => Math.round(Math.max(p.offset, p.offset + p.length - 30))).filter((t) => !inFailed(t));
const want = [...new Set([...candidates.map((c) => c.peak), ...fileTails])].sort((a, b) => a - b);
if (want.length) {
  try {
    execFileSync("node", ["scripts/ck-probe.mjs", "--vod", vodId, "--at", want.join(",")], { stdio: ["ignore", "ignore", "inherit"] });
  } catch { console.log("  ⚠ 원본 일부를 못 받았다 — probe.json 의 missed 를 본다"); }
}
const frameOf = (t) => (existsSync(join("out/ck", vodId, `g${String(t).padStart(7, "0")}.jpg`)) ? `out/ck/${vodId}/g${String(t).padStart(7, "0")}.jpg` : null);
for (const c of candidates) c.frame = frameOf(c.peak);

// ④ 몽타주 — 후보(한 장 40칸), 개요(2분 칸, 후보가 걸친 칸은 분홍 테두리)
const PINK = [230, 40, 200], GRAY = [70, 70, 70];
const pages = (rows, prefix, per, cols, tileOf) => {
  const out = [];
  for (let p = 0; p * per < rows.length; p++) {
    const slice = rows.slice(p * per, (p + 1) * per);
    const file = `${prefix}-${p + 1}.jpg`;
    writeFileSync(join(dir, file), encode(montage(slice.map(tileOf), cols), 85));
    out.push(file);
  }
  return out;
};
const candidatePages = pages(candidates, "candidates", 40, 8, (c) => ({ img: cellAt(c.peak)?.img ?? blankTile, color: PINK, label: `#${c.n} ${hms(c.peak)}` }));
const points = coveragePoints(parts, total, 120).filter((t) => !inFailed(t));
const hit = (t) => candidates.some((c) => c.to >= t - 60 && c.from <= t + 60);
const overviewPages = pages(points, "overview", 60, 10, (t) => ({ img: cellAt(t)?.img ?? blankTile, color: hit(t) ? PINK : GRAY, label: hms(cellAt(t)?.at ?? t) }));

// 기록 — 이번 실행의 산출물은 전부 run_id 를 단다
const elapsedSec = Math.round((Date.now() - started) / 1000);
const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
const summary = { run_id: runId, started_at: new Date(started).toISOString(), finished_at: new Date().toISOString(),
  detector: `${det.model} ≥${det.threshold} ×${det.min_len}`, cells: det.cells, candidates: candidates.length, elapsed_sec: elapsedSec };
writeJson(statePath, {
  vod_id: Number(vodId), title: detail.title ?? null, total_sec: Math.round(total), ...summary,
  failed: failedMerged, file_tails: fileTails.map((t) => ({ at: t, frame: frameOf(t) })),
  candidates, candidate_pages: candidatePages, overview_pages: overviewPages,
  runs: [...(prev?.runs ?? []), summary],
});
const broadcast = vodBroadcastTimes(detail);
writeJson(join(dir, "scan-draft.json"), {
  resultType: "scan",
  lead: { source_key: `vod:${vodId}`, title: detail.title ?? `VOD ${vodId}`, channel_id: detail.bj_id ?? detail.user_id ?? null,
    url: `https://vod.sooplive.com/player/${vodId}`, observed_at: broadcast.end ?? broadcast.start },
  scan: {
    status: "running", version: "ck-local/4",
    requested: [[0, Math.round(total)]], sampled: subtractRanges([[0, Math.round(total)]], failedMerged),
    probes: { planned: points, extra: want },
    opened: [], transcript_read: [], failed: failedMerged, signals: ["frame"],
    note: `ck-local run ${runId} · 판별기 ${summary.detector}: 결과창 후보 ${candidates.length}`,
  },
  frames: [], candidates: [],
});
ledger({ kind: "scan", run_id: runId, detector: summary.detector, candidates: candidates.length, failed: failedMerged, dir, elapsed_sec: elapsedSec });

console.log(`\n결과창 후보 ${candidates.length}개   (전체 ${hms(elapsedSec)})`);
for (const c of candidates) console.log(`  #${c.n} ${hms(c.from)}~${hms(c.to)} · ${c.len}칸 · 원본 ${c.frame ?? "못 받음"}`);
if (failedMerged.length) console.log(`  ⚠ 썸네일로 못 본 범위(원본으로 볼 것): ${failedMerged.map(([a, b]) => `${hms(a)}~${hms(b)}`).join(", ")}`);
console.log(`  파일 끝 원본: ${fileTails.map((t) => frameOf(t) ?? `${t}(못 받음)`).join(" ")}`);
console.log(`\nout/ck/${vodId}/local/  (run ${runId})`);
console.log(`  ${[...candidatePages, ...overviewPages].join(" · ")} · scan.json · scan-draft.json`);
console.log(`PREP: ck-local run_id=${runId} candidates=${candidates.length} dir=out/ck/${vodId}/local`);
