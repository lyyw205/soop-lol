/**
 * ck-local 실험 — 학습한 결과창 판별기로 **결과창 후보**를 고르고 원본까지 받아 둔다. Claude 는 고르고 읽기만 한다.
 *
 *   npm run ck:local -- --vod <번호>                                     # 준비: 판별 + 후보 원본 + 몽타주
 *   npm run ck:local -- --vod <번호> --strip 0:44:00~0:48:00 [--step 10] # 띠: 그 구간 썸네일 한 장 (안전장치)
 *   npm run ck:local -- --review --vod <번호> --run <run_id> --verdicts 3:result,5:other            # 후보 판정 → 학습 데이터
 *   npm run ck:local -- --review --vod <번호> --run <run_id> --label 1:23:45=result,5130=banpick     # 시각으로 정정(놓친 화면·틀린 라벨)
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
  if (flag("--verdicts")) {
    // 한 번에: --verdicts 1:result,2:other,3:ingame — 후보마다 명령을 따로 부르면 턴이 늘어 토큰이 는다
    const out = [];
    for (const tok of flag("--verdicts").split(",").map((x) => x.trim()).filter(Boolean)) {
      const [n, is] = tok.split(":"); const c = state.candidates?.find((x) => x.n === Number(n));
      if (!c || !["result", "graph", "ingame", "client", "other"].includes(is)) { console.error(`판정이 이상하다: ${tok} (번호:result|graph|ingame|client|other)`); process.exit(1); }
      appendFileSync("out/ck-detector/review-labels.jsonl", `${JSON.stringify({ vod: Number(vodId), at: c.peak, label: is, source: `ck-local:${run}` })}\n`);
      out.push({ cand: c.n, is });
    }
    entry.verdicts = out;
  }
  if (flag("--label")) {
    // 후보 번호 없이 시각으로 — 판별기가 놓친 결과창, 틀린 지도 라벨도 학습 데이터로 남긴다(Codex 검토, 2026-10-01)
    //   --label 1:23:45=result,5130=banpick   (VOD 전체 시각: h:mm:ss 또는 초)
    const KINDS = ["result", "graph", "banpick", "lobby", "client", "ingame", "end", "other"];
    const sec = (x) => x.split(":").map(Number).reduce((p, q) => p * 60 + q, 0);
    const out = [];
    for (const tok of flag("--label").split(",").map((x) => x.trim()).filter(Boolean)) {
      const m = /^([\d:]+)=(\w+)$/.exec(tok);
      if (!m || !KINDS.includes(m[2]) || !Number.isFinite(sec(m[1])) || sec(m[1]) > state.total_sec) {
        console.error(`--label 값이 이상하다: ${tok} (시각=${KINDS.join("|")})`); process.exit(1);
      }
      appendFileSync("out/ck-detector/review-labels.jsonl", `${JSON.stringify({ vod: Number(vodId), at: sec(m[1]), label: m[2], source: `ck-local:${run}` })}\n`);
      out.push({ at: sec(m[1]), label: m[2] });
    }
    entry.labels = out;
  }
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

// ── 기록 초안 조립 — Claude 는 읽은 결과만 넘기고, 기계적인 칸은 도구가 채운다 ────────────────
//   npm run ck:local -- --finish --vod N --run R --opened 5112,13341 [--result-frames 5112] [--status done|running]
//                      [--games out/ck/N/local/games.json] [--note "본 것"]
//   games.json(선택): { "candidates": [ck:merge 후보…], "results": [match·identify 결과…] } — 경기가 없으면 안 쓴다
//   출력: out/ck/N/local/final.json → npm run ck:merge -- --result 그 파일
if (args.includes("--finish")) {
  const run = flag("--run");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  if (!state || state.run_id !== run) { console.error(`run_id 가 현재 산출물과 다르다 (현재 ${state?.run_id ?? "없음"}).`); process.exit(1); }
  // ★ 빈 칸을 거른 뒤 숫자로 — Number("") 가 0 이라 "120," 이나 빈 값이 0초로 섞였다(Codex 검토, 2026-10-01)
  const nums = (f) => {
    const raw = (flag(f) ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const bad = raw.filter((x) => !/^\d+$/.test(x));
    if (bad.length) { console.error(`${f} 값이 이상하다: ${bad.join(",")} (VOD 전체 초, 정수)`); process.exit(1); }
    return raw.map(Number);
  };
  const opened = nums("--opened"), resultFrames = new Set(nums("--result-frames"));
  if (!opened.length) { console.error("--opened 가 필요하다 — 실제로 연 원본 시각(초). 이 실험에서 opened 는 원본만이다."); process.exit(1); }
  const status = flag("--status", "done");
  if (!["done", "running", "failed"].includes(status)) { console.error("--status 는 done|running|failed"); process.exit(1); }
  const draft = JSON.parse(readFileSync(join(dir, "scan-draft.json"), "utf8"));
  const pad = (t) => `out/ck/${vodId}/g${String(t).padStart(7, "0")}.jpg`;
  const missing = opened.filter((t) => !existsSync(pad(t)));
  if (missing.length) { console.error(`원본 파일이 없다: ${missing.join(",")} — ck:probe 로 받은 시각만 적는다`); process.exit(1); }
  draft.scan.opened = opened.sort((x, y) => x - y);
  draft.scan.status = status;
  if (flag("--note")) draft.scan.note = `${draft.scan.note}\n${flag("--note")}`;
  // 메운 실패 범위 — 이번 failed 에서 빼고 resolved_failed 에도 넣는다. 병합(mergeScan)은 resolved_failed 를 이전 DB 실패에만
  // 적용하고 이번 failed 는 그대로 더하므로, 한쪽만 하면 안 닫힌다.
  const resolved = (flag("--resolved") ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = /^(\d+)-(\d+)$/.exec(x);
    if (!m || Number(m[2]) < Number(m[1])) { console.error(`--resolved 값이 이상하다: ${x} (시작-끝, VOD 전체 초)`); process.exit(1); }
    return [Number(m[1]), Number(m[2])];
  });
  if (resolved.length) {
    draft.scan.failed = subtractRanges(draft.scan.failed ?? [], resolved);
    draft.scan.resolved_failed = mergeRanges([...(draft.scan.resolved_failed ?? []), ...resolved]);
  }
  draft.frames = draft.scan.opened.map((t) => ({ frame_path: pad(t), at_sec: t, kind: resultFrames.has(t) ? "result" : "other", read: true }));
  const out = [draft];
  if (flag("--games")) {
    const g = JSON.parse(readFileSync(flag("--games"), "utf8"));
    draft.candidates = g.candidates ?? [];
    out.push(...(g.results ?? []));
  }
  writeJson(join(dir, "final.json"), out.length === 1 ? draft : out);
  // ★ 경고만 한다(막지 않는다 — 합격선 금지). 10분 넘는 "게임 중" 라벨 구간인데 이 초안에 후보 결론도 연 원본도 근처에 없는 곳.
  //   ck-research: 롤 게임 구간은 대상이든 아니든 근거와 함께 닫는다. 클리드1 백필에서 솔랭·LCK 시청 구간 10곳이
  //   결론 없이 넘어간 것을 보고 넣었다(2026-10-01). 이 초안만 보고, DB 에 이미 저장된 이전 기록은 보지 않는다.
  const marks = [...draft.scan.opened, ...(draft.candidates ?? []).flatMap((c) => c.at ?? [])];
  const blocks = [];
  for (const m of (state.map ?? []).filter((x) => x.label === "ingame")) {
    const b = blocks.at(-1);
    if (b && m.from - b.to <= 180) b.to = m.to; else blocks.push({ from: m.from, to: m.to });
  }
  const open = blocks.filter((b) => b.to - b.from >= 600 && !marks.some((t) => t >= b.from - 60 && t <= b.to + 600));
  if (open.length) {
    console.log(`\n⚠ 결론 없는 롤 게임 구간 ${open.length}곳 (지도의 "게임 중" 10분+, 근처에 후보 결론·연 원본 없음):`);
    for (const b of open) console.log(`   ${hms(b.from)}~${hms(b.to)}`);
    console.log("   대상 경기면 기록하고, 아니면(솔랭·시청 등) 본 근거와 함께 not_target 후보로 닫는다. 라벨이 틀렸으면 --review --label 로 남긴다.");
  }
  console.log(`초안: out/ck/${vodId}/local/final.json (원본 ${opened.length}장 · 결과창 ${resultFrames.size} · 후보 ${draft.candidates.length} · 경기 등 ${out.length - 1})`);
  console.log(`다음: npm run ck:merge -- --result out/ck/${vodId}/local/final.json`);
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
/**
 * 구간 지도 — 화면 종류 라벨(multi.py)을 구간으로 묶은 것. **판단이 아니라 위치 안내다.**
 * 짧게 남긴다: 밴픽·게임 중(2분 이상)·종료·결과창·그래프·게임 방(1분 이상)만, 결과창 구간에는 후보 번호를 붙인다.
 * 모름·롤 아님·짧은 구간은 뺀다 — 개요 몽타주가 그 자리를 보여준다.
 */
const KO = { banpick: "밴픽", ingame: "게임 중", end: "종료 화면", result: "결과창", graph: "결과창(그래프)", lobby: "게임 방" };
const keepSeg = (x) => ({ banpick: 1, end: 1, result: 1, graph: 1 })[x.label] || (x.label === "ingame" && x.to - x.from >= 120) || (x.label === "lobby" && x.to - x.from >= 60);
const mapSegs = [];
for (const x of (det.timeline ?? []).filter(keepSeg)) {
  const last = mapSegs.at(-1);
  // 긴 화면(밴픽·게임 중·게임 방)만 3분 안의 끊김을 잇는다. 종료·결과창은 15초 — 따로 뜬 것을 한 구간으로 부풀리지 않게.
  const gap = ["banpick", "ingame", "lobby"].includes(x.label) ? 180 : 15;
  if (last && last.label === x.label && x.from - last.to <= gap) { last.to = x.to; continue; }
  mapSegs.push({ ...x });
}
// 1칸짜리 종료 화면 라벨은 로딩 화면을 잘못 본 경우가 많았다(실측: 207588653 의 밴픽~게임 사이 4개). 뒤 90초 안에 결과창 라벨이 없으면 지도에서 뺀다.
for (let i = mapSegs.length - 1; i >= 0; i--) {
  const m = mapSegs[i];
  if (m.label === "end" && m.to === m.from && !mapSegs.some((x) => ["result", "graph"].includes(x.label) && x.from >= m.from && x.from - m.to <= 90)) mapSegs.splice(i, 1);
}
for (const m of mapSegs) {
  // 후보 번호는 결과창 구간에만 단다 — 후보는 결과창 판별기가, 구간은 종류 판별기가 내서 둘이 겹치는지를 보여준다.
  const ns = ["result", "graph"].includes(m.label) ? candidates.filter((c) => c.to >= m.from - 6 && c.from <= m.to + 6).map((c) => `#${c.n}`) : [];
  m.cands = ns;
}
for (const c of candidates) if (!mapSegs.some((m) => m.cands.includes(`#${c.n}`))) mapSegs.push({ label: "result", from: c.from, to: c.to, cands: [`#${c.n}`], note: "후보만" });
mapSegs.sort((x, y) => x.from - y.from);
const mapText = mapSegs.map((m) => `${hms(m.from)}${m.to > m.from ? `~${hms(m.to)}` : ""} ${m.note ? "결과창 후보" : KO[m.label]}${m.cands.length ? ` (후보 ${m.cands.join(",")})` : ""}`);
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
  candidates, candidate_pages: candidatePages, overview_pages: overviewPages, map: mapSegs,
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

writeFileSync(join(dir, "map.txt"), `${mapText.join("\n")}\n`);
console.log(`\n구간 지도 (out/ck/${vodId}/local/map.txt — 화면 종류 라벨, 위치 안내일 뿐)`);
for (const l of mapText) console.log(`  ${l}`);
console.log(`\n결과창 후보 ${candidates.length}개   (전체 ${hms(elapsedSec)})`);
for (const c of candidates) console.log(`  #${c.n} ${hms(c.from)}~${hms(c.to)} · ${c.len}칸 · 원본 ${c.frame ?? "못 받음"}`);
if (failedMerged.length) console.log(`  ⚠ 썸네일로 못 본 범위(원본으로 볼 것): ${failedMerged.map(([a, b]) => `${hms(a)}~${hms(b)}`).join(", ")}`);
console.log(`  파일 끝 원본: ${fileTails.map((t) => frameOf(t) ?? `${t}(못 받음)`).join(" ")}`);
console.log(`\nout/ck/${vodId}/local/  (run ${runId})`);
console.log(`  ${[...candidatePages, ...overviewPages].join(" · ")} · scan.json · scan-draft.json`);
console.log(`PREP: ck-local run_id=${runId} candidates=${candidates.length} dir=out/ck/${vodId}/local`);
