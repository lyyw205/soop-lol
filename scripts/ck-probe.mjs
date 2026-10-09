/**
 * VOD **전체 범위**에 대표 화면을 뿌리고 원본 프레임을 뽑는다.
 *
 *   npm run ck:probe -- --vod 189903183
 *   npm run ck:probe -- --vod 189903183 --interval 300 --dry-run
 *
 * ★ 이 도구는 **로컬 산출물만 만든다** (docs/CK-RESEARCH-PLAN.md §3-D).
 *   DB 에 아무것도 쓰지 않는다. 기록은 `ck:merge --result` 한 창구로만 간다.
 *
 * ★ **'읽음' 을 붙이지 않는다** (§5). 파일이 생겼다는 사실은 근거가 아니다 —
 *   뽑아 놓고 안 열고서 단정한 사고가 실제로 있었다. 여는 것은 조사자의 일이다.
 *
 * ★ 기존 도구가 버리는 것을 여기서는 **버리지 않는다.**
 *   ① `playableFiles` 는 10분 미만 파일을 버린다. 그러면 **짧은 마지막 구간**이 통째로
 *      탐색에서 빠진다(§3-B — "짧은 마지막 구간도 빠뜨리지 않는다"). 여기서는 전부 본다.
 *   ② 픽셀 거름망(`detect`)은 15분 미만 구간을 버리고 게임 같은 화면만 남긴다. 그건
 *      **추가로 볼 자리를 제안하는 신호**이지 기본 탐색의 범위 조건이 아니다(§6).
 *      그래서 기본 탐색은 거름망과 **독립적으로** 시간축 전체에 깔린다.
 *   ③ 프레임 시각이 **파일 로컬**이었다. 분할 파일이 여럿이면 f1 의 10분과 f2 의 10분이
 *      같은 이름이 되고, 음성·채팅·근거가 서로 다른 축을 가리킨다(§3-A).
 *      여기서는 전부 **VOD 전체 초**로 통일한다 — 파일 이름도 `g<전체초>` 다.
 *
 * ⚠ 전체 축은 **HLS 로 잰 실제 길이**로 쌓는다. API 의 `duration` 은 실제보다 길게
 *   보고하는 VOD 가 있다(docs/CK-COLLECTION.md — 멸망전 공식채널 API 4.00h vs HLS 2.18h).
 *   그걸로 축을 쌓으면 뒤 파일의 시각이 통째로 밀린다.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { mergeRanges } from "@soop-lol/core/lib/metrics/ranges";

import { dividedPoints } from "./lib/ck-probe-points.mjs";
import { detect, hms, scanSheets, segmentAt, segmentsSpan, vodBroadcastTimes, vodDetail } from "./lib/soop-vod.mjs";
import { coveragePoints, measureParts } from "./lib/vod-timeline.mjs";
import { writeNameCrop } from "./lib/result-names.mjs";

const ROOT = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const vodId = flag("--vod");
// §3-B 의 "약 30분" — 도구 기본값이다. 롤이든 FC든 한 번 켜면 30분 넘게 화면에 머무르니
// 첫 훑기는 성기게 두고, 게임 화면이 걸린 자리부터 --between 으로 좁혀 들어간다.
const interval = Number(flag("--interval", 1800));
const maxExtra = Number(flag("--max-extra", 12));
const dryRun = args.includes("--dry-run");
const noSieve = args.includes("--no-sieve");
/**
 * 조사자가 **직접 찍은 지점**(VOD 전체 초, 쉼표로 여럿).
 *
 * ★ 기본 탐색은 시간축 전체를 고르게 훑는 것이고, 이건 **후보 주변을 파는** 자리다(§3-C).
 *   채팅 공지·전사·앞서 본 프레임이 "여기를 보라" 고 하면 그 시각을 그대로 넣는다.
 *   `--at` 을 주면 기본 탐색과 거름망은 돌지 않는다 — 이미 볼 곳을 아는 상태다.
 */
const atSpec = flag("--at");
/**
 * 종료 전환 구간을 여러 장으로 보기 위한 편의 옵션. 이것은 결과창 합격선이 아니다.
 * 조사자가 필요하다고 고른 범위에 프레임을 배치할 뿐이며, 못 찾으면 그대로 기록한다.
 */
const betweenSpec = flag("--between");
const betweenStep = Number(flag("--step", 5));
const betweenDivideRaw = flag("--divide");
const betweenDivide = betweenDivideRaw == null ? null : Number(betweenDivideRaw);

if (args.includes("--divide") && betweenDivideRaw == null) {
  console.error("--divide 뒤에 분할 수를 적어야 한다.");
  process.exit(1);
}
if ((args.includes("--divide") || args.includes("--step")) && betweenSpec == null) {
  console.error("--divide 와 --step 은 --between 과 함께 써야 한다.");
  process.exit(1);
}
if (args.includes("--step") && betweenDivide != null) {
  console.error("--step 과 --divide 는 함께 쓸 수 없다.");
  process.exit(1);
}

if (!vodId || !/^\d+$/.test(vodId)) {
  console.error(`
사용법: npm run ck:probe -- --vod <VOD번호> [--interval 1800] [--max-extra 12] [--dry-run] [--no-sieve]
        npm run ck:probe -- --vod <VOD번호> --between <시작초:끝초> [--divide 5 | --step 5]

VOD 전체 범위에 대표 화면을 뿌리고 원본 프레임을 out/ck/<VOD번호>/ 에 뽑는다.
DB 에는 아무것도 쓰지 않는다 — 기록은 ck:merge 로 간다.

⚠ 간격은 **도구 기본값**이지 "경기가 있나" 를 판정하는 규칙이 아니다.
  더 봐야겠다 싶으면 --interval 을 줄이거나 나온 manifest 를 보고 직접 더 뽑는다.

--between 은 경기 종료 전후처럼 조사자가 고른 구간을 보기 쉽게 뽑는 옵션이다.
  --divide 는 양끝과 등분 경계만 뽑아 다음 탐색 구간을 고르게 한다.
  --step 은 이미 좁아진 구간을 일정한 초 간격으로 확인할 때 쓴다.
`.trim());
  process.exit(1);
}

const FFMPEG = process.env.FFMPEG_PATH ?? "ffmpeg";
try {
  execFileSync(FFMPEG, ["-version"], { stdio: "ignore" });
} catch {
  console.error(`ffmpeg 을 찾지 못했다 (${FFMPEG}).\n`
    + `  Ubuntu/WSL:  sudo apt install ffmpeg\n`
    + `  다른 경로면:  FFMPEG_PATH=/경로/ffmpeg npm run ck:probe -- --vod ${vodId}`);
  process.exit(1);
}

const detail = await vodDetail(vodId);
if (!detail) {
  console.error(`VOD 를 찾지 못했다: ${vodId}`);
  process.exit(1);
}

// ── ① 전역 시간축을 만든다 ──────────────────────────────────────────
//
// 파일마다 HLS 로 실제 길이를 잰다. 플레이리스트 텍스트만 받으므로 싸다(세그먼트 아님).
const files = detail.files ?? [];
console.log(`\n${detail.title ?? "(제목 없음)"}  ·  분할 파일 ${files.length}개`);

// 축 계산은 scripts/lib/vod-timeline.mjs 가 단일 출처다 — ck-local 등 다른 도구와 같은 초를 쓴다.
const measured = await measureParts(detail, { log: (m) => console.log(m) });
const parts = measured.parts;
const failedRanges = [...measured.failed];
for (const p of parts) {
  const gap = p.measured && p.apiLength - p.length > 60 ? ` (API 는 ${(p.apiLength / 3600).toFixed(2)}h 라고 한다 — 뒤가 안 받아진다)` : "";
  console.log(`  f${p.index}  ${hms(p.offset)} ~ ${hms(p.offset + p.length)}  ${(p.length / 3600).toFixed(2)}h`
    + `${p.measured ? "" : "  ⚠ 길이 미확인"}${gap}`);
}
const axis = measured.total;
const total = axis;
if (total <= 0) {
  console.error("받을 수 있는 구간이 없다.");
  process.exit(1);
}
console.log(`전체 ${hms(total)} (${(total / 3600).toFixed(2)}h)`);

// ── ② 탐색 지점 ─────────────────────────────────────────────────────
const planned = new Set();
const targeted = atSpec != null || betweenSpec != null;
let targetedRadius = Math.max(1, Math.round(interval / 2));

if (targeted) {
  // 조사자가 찍은 지점만. 범위 밖은 버리고 **버렸다고 말한다.**
  const outside = [];
  if (atSpec != null) {
    for (const raw of atSpec.split(",")) {
      const t = Math.round(Number(raw.trim()));
      if (!Number.isFinite(t) || t < 0) { console.error(`--at 값이 이상하다: ${raw}`); process.exit(1); }
      if (t >= total) { outside.push(t); continue; }
      planned.add(t);
    }
  }
  if (betweenSpec != null) {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(betweenSpec.trim());
    if (!match) { console.error("--between 은 VOD 전체 초 시작:끝 형식이어야 한다 (예: 16810:16840)"); process.exit(1); }
    const start = Math.round(Number(match[1])), end = Math.round(Number(match[2]));
    if (start < 0 || end < start) {
      console.error("--between 은 0 이상의 올바른 구간이어야 한다."); process.exit(1);
    }

    let points;
    if (betweenDivide != null) {
      if (!Number.isInteger(betweenDivide) || betweenDivide < 2) {
        console.error("--divide 는 2 이상의 정수여야 한다."); process.exit(1);
      }
      points = dividedPoints(start, end, betweenDivide);
      targetedRadius = Math.max(1, Math.round((end - start) / betweenDivide / 2));
    } else {
      if (!Number.isFinite(betweenStep) || betweenStep <= 0) {
        console.error("--step 은 0보다 큰 값이어야 한다."); process.exit(1);
      }
      points = [];
      for (let t = start; t <= end; t += betweenStep) points.push(Math.round(t));
      if (points.at(-1) !== end) points.push(end);
      targetedRadius = Math.max(1, Math.round(betweenStep / 2));
    }

    for (const point of points) {
      if (point >= total) outside.push(point);
      else planned.add(point);
    }
  }
  if (outside.length > 0) console.log(`  ⚠ 범위 밖이라 뺀 지점: ${outside.map(hms).join(", ")}`);
  if (planned.size === 0) { console.error("받을 수 있는 지점이 없다."); process.exit(1); }
} else {
  // ★ 거름망과 **독립적으로** 깐다. 거름망이 놓친 자리도 기본 탐색에는 남아야 한다(§9).
  //   격자 + 파일마다 최소 한 장(§3-B, 2분짜리 꼬리 파일) + 파일마다 끝 − 30초. 규칙은 vod-timeline 의 coveragePoints.
  for (const t of coveragePoints(parts, total, interval)) planned.add(t);
}

// ── ③ 픽셀 거름망은 **추가 제안**일 뿐 ──────────────────────────────
const extra = new Set();
if (!noSieve && !targeted) {
  for (const p of parts) {
    if (!p.file.snapshot) continue;
    try {
      const { frames, sec } = await scanSheets(p.file, { length: p.length });
      if (!frames.length || !sec) continue;
      const d = detect(frames, sec);
      // 게임 같은 구간의 한가운데 + 밴픽/로딩 후보. 전역 초로 바꿔 담는다.
      for (const g of d.games) extra.add(Math.round(p.offset + (g.start + g.end) / 2));
      for (const s of d.shots) extra.add(Math.round(p.offset + s));
      console.log(`  f${p.index}  거름망: 게임같은구간 ${d.games.length} · 밴픽후보 ${d.shots.length}`
        + ` · 게임화면비율 ${(d.gameRatio * 100).toFixed(0)}%`);
    } catch (e) {
      console.log(`  f${p.index}  ⚠ 시트를 못 읽었다 — ${String(e.message).slice(0, 50)}`);
    }
  }
}
// 이미 기본 탐색에 있는 지점은 뺀다. 상한은 비용 때문이고, **깎인 사실을 남긴다.**
const extraList = [...extra].filter((t) => !planned.has(t)).sort((a, b) => a - b);
const extraKept = extraList.slice(0, maxExtra);
const extraDropped = extraList.length - extraKept.length;

const probes = [...new Set([...planned, ...extraKept])].sort((a, b) => a - b);

console.log(`\n탐색 지점 ${probes.length}곳 — ${targeted ? "조사자 지정" : `기본 ${planned.size} + 거름망 제안 ${extraKept.length}`}`
  + `${extraDropped > 0 ? ` (상한 ${maxExtra} 으로 ${extraDropped}곳 제외 — 더 보려면 --max-extra)` : ""}`);

if (dryRun) {
  console.log(`\n(dry-run — 받지 않았다)`);
  console.log(probes.map(hms).join("  "));
  process.exit(0);
}

// ── ④ 프레임을 뽑는다 ───────────────────────────────────────────────
const outDir = join(ROOT, "out", "ck", String(vodId));
mkdirSync(outDir, { recursive: true });
// ★ 임시 파일은 **실행마다 따로** 만든다. 예전엔 `ck-probe-<vod>.m4s` 하나를 같이 써서,
//   같은 VOD 에 probe 를 동시에 돌리면 A 가 쓴 세그먼트를 B 의 ffmpeg 이 읽었다 — 다른 시각의
//   화면이 엉뚱한 초의 프레임으로 저장되고, 재개 로직이 그 파일을 다시 받지 않아 오염이 남았다.
//   (실측: 7309356 에서 g14s1 구간에 g13 화면이 섞였다, 2026-09-26)
const tmpDir = mkdtempSync(join(tmpdir(), `ck-probe-${vodId}-`));
const tmp = join(tmpDir, "seg.m4s");

const got = [];
const missed = [];
let downloadMB = 0;

for (const at of probes) {
  const part = parts.find((p) => at >= p.offset && at < p.offset + p.length) ?? parts[parts.length - 1];
  const name = `g${String(at).padStart(7, "0")}.jpg`;
  const rel = `out/ck/${vodId}/${name}`;
  const abs = join(outDir, name);

  // 재개 — 이미 뽑은 것은 건너뛴다. 중간에 끊겨도 다시 돌리면 이어진다(§9).
  if (existsSync(abs)) { got.push({ at, path: rel, part: part.index, cached: true }); continue; }

  if (!part.hls) { missed.push({ at, why: `f${part.index} HLS 없음` }); continue; }
  try {
    const local = at - part.offset;
    const seg = await segmentAt(part.hls, local);
    if (!seg) { missed.push({ at, why: "그 시각의 세그먼트가 없다" }); continue; }
    downloadMB += seg.bytes / 1_048_576;
    writeFileSync(tmp, seg.data);
    execFileSync(FFMPEG, ["-v", "error", "-ss", seg.offset.toFixed(2), "-i", tmp,
      "-frames:v", "1", "-q:v", "2", "-y", abs]);
    // ★ **ffmpeg 이 0 으로 끝났다고 프레임이 생긴 게 아니다.** `-ss` 가 세그먼트 내용
    //   끝을 넘으면 아무것도 안 쓰고 조용히 성공한다 — 그러면 manifest 에는 있는데
    //   파일이 없는 프레임이 생기고, "N장 받았다" 가 거짓이 된다.
    //   (실측: 207602969 의 600초. 155장 기록 중 1장이 없었다)
    if (!existsSync(abs) || statSync(abs).size === 0) {
      // 세그먼트 하나만으론 그 시각 근처에 디코드할 프레임이 없었을 수 있다 — 앞뒤
      // 세그먼트를 이어 받아(segmentsSpan, 음성용으로 쓰던 것을 재사용) 한 번 더 시도한다.
      const spanned = await segmentsSpan(part.hls, local, 12);
      if (spanned) {
        downloadMB += spanned.bytes / 1_048_576;
        writeFileSync(tmp, spanned.data);
        execFileSync(FFMPEG, ["-v", "error", "-ss", spanned.offset.toFixed(2), "-i", tmp,
          "-frames:v", "1", "-q:v", "2", "-y", abs]);
      }
      if (!existsSync(abs) || statSync(abs).size === 0) {
        missed.push({ at, why: "ffmpeg 이 프레임을 만들지 못했다 (세그먼트 경계, 재시도도 실패)" });
        continue;
      }
    }
    got.push({ at, path: rel, part: part.index, cached: false });
    process.stdout.write(`\r  받는 중 ${got.length}/${probes.length}  ${hms(at)}   `);
  } catch (e) {
    missed.push({ at, why: String(e.message).slice(0, 80) });
  }
}
rmSync(tmpDir, { recursive: true, force: true });
console.log(`\r  프레임 ${got.length}장 (새로 받은 것 ${got.filter((g) => !g.cached).length}) · 내려받기 ${downloadMB.toFixed(0)}MB       `);

// ── 결과창 이름 칸 확대본 — 결과창 점수판으로 보이는 프레임만 names/ 에 만든다(scripts/lib/result-names.mjs).
//   한글 닉네임이 전체 프레임에선 뭉개져 자모 하나씩 틀렸다. 못 찾은 프레임은 만들지 않는다(원본만 본다).
const namesOf = new Map();
for (const g of got) {
  try {
    const r = await writeNameCrop(join(ROOT, g.path));
    if (r.path) namesOf.set(g.at, relative(ROOT, r.path));
  } catch { /* 확대본은 보조물이다 — 실패해도 탐색은 계속한다 */ }
}
if (namesOf.size > 0) {
  console.log(`  이름 칸 확대 ${namesOf.size}장 — 결과창 닉네임을 원본의 이름 열만 2배로 자른 것(근거 프레임은 원본):`);
  for (const [at, path] of [...namesOf].sort((a, b) => a[0] - b[0])) console.log(`     ${hms(at)}  ${path}`);
}

// 못 받은 지점은 **범위로** 남긴다 — "여기는 안 봤다" 가 기록에 남아야 한다.
for (const m of missed) failedRanges.push([m.at, m.at]);
if (missed.length > 0) {
  console.log(`  ⚠ 못 받은 지점 ${missed.length}곳:`);
  for (const m of missed.slice(0, 5)) console.log(`     ${hms(m.at)}  ${m.why}`);
  if (missed.length > 5) console.log(`     … 외 ${missed.length - 5}곳`);
}

// ── ⑤ manifest 와 ck:merge 초안 ─────────────────────────────────────
const manifestPath = join(outDir, "probe.json");
// ★ `--at` 은 **후보 주변을 파는** 실행이다. 기본 탐색 기록을 덮으면
//   "전 구간에 대표 샘플을 뿌렸다" 는 사실이 사라진다 — 그래서 **합친다.**
const prev = targeted && existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : null;

const mergedFrames = [...(prev?.frames ?? []), ...got.map((g) => ({ at_sec: g.at, path: g.path, part: g.part,
  ...(namesOf.has(g.at) ? { names: namesOf.get(g.at) } : {}) }))];
const manifest = {
  vod_id: Number(vodId),
  title: detail.title ?? null,
  channel_id: detail.bj_id ?? detail.user_id ?? null,
  probed_at: new Date().toISOString(),
  // ★ 방송 시각은 SOOP 메타데이터가 정본이다. ck:merge 가 단서 시각(observed_at)을 여기서 읽는다.
  broadcast: vodBroadcastTimes(detail),
  interval: prev?.interval ?? interval,
  total_sec: Math.round(total),
  // 분할 파일의 로컬 시각 ↔ 전역 시각 대응표. 음성·채팅도 이 표로 축을 맞춘다(§3-A).
  parts: parts.map((p) => ({
    index: p.index, offset_sec: Math.round(p.offset), length_sec: Math.round(p.length),
    length_measured: p.measured,
  })),
  probes: {
    // 기본 탐색 기록은 그대로 두고, 조사자가 찍은 지점은 `targeted` 에 쌓는다.
    planned: prev?.probes?.planned ?? [...planned].sort((a, b) => a - b),
    extra: prev?.probes?.extra ?? extraKept,
    extra_dropped: prev?.probes?.extra_dropped ?? extraDropped,
    targeted: [...new Set([...(prev?.probes?.targeted ?? []), ...(targeted ? [...planned] : [])])]
      .sort((a, b) => a - b),
  },
  // 같은 시각을 두 번 받아도 한 줄이다.
  frames: [...new Map(mergedFrames.map((f) => [f.at_sec, f])).values()].sort((a, b) => a.at_sec - b.at_sec),
  missed: [...(prev?.missed ?? []), ...missed],
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

/**
 * ck:merge 에 넣을 초안. **조사자가 채워서** 넣는다.
 *
 * ⚠ `status` 를 `running` 으로 둔다. 프레임을 뽑은 것은 **탐색을 수행한 것이지 조사를
 *   끝낸 것이 아니다** — `done` 은 후보들의 현재 결론까지 적었다는 뜻이다(§5).
 * ⚠ `opened` 는 비운다. 연 것은 조사자가 적는다.
 * ⚠ 프레임의 `note` 도 비운다. 적으면 '읽음' 으로 표시되므로, 실제로 열어 본 뒤에 적는다.
 */
/**
 * `--at` 대표 샘플의 배치 범위. 찍은 지점 앞뒤로 기본 간격의 절반씩.
 * 전 범위를 적으면 "다 훑었다" 는 거짓 기록이 되고, 그게 DB 에 누적된다.
 */
const coveredAround = mergeRanges(
  [...planned].map((t) => [Math.max(0, t - targetedRadius), Math.min(Math.round(total), t + targetedRadius)]),
);

const draft = {
  resultType: "scan",
  lead: {
    source_key: `vod:${vodId}`,
    title: detail.title ?? `VOD ${vodId}`,
    channel_id: manifest.channel_id,
    url: `https://vod.sooplive.com/player/${vodId}`,
    // 방송 종료(=VOD 등록) 시각. collect-leads 의 reg_date 와 같은 뜻이다. 모르면 비운다 — "지금" 을 넣지 않는다.
    observed_at: manifest.broadcast.end ?? manifest.broadcast.start,
  },
  scan: {
    status: "running",
    version: "ck-probe/1",
    // ★ `--at` 은 **찍은 지점 둘레만** 본 실행이다. 전 범위를 적으면 "다 훑었다" 는
    //   거짓 기록이 되고, 저장 경로가 그걸 이전 기록에 누적해 버린다(markLeadScan).
    //   지점 앞뒤 interval/2 는 표시 범위일 뿐, 이전 실패를 해소하는 근거가 아니다.
    requested: targeted ? coveredAround : [[0, Math.round(total)]],
    sampled: targeted ? coveredAround : [[0, Math.round(total)]],
    probes: { planned: manifest.probes.planned, extra: targeted ? [...planned].sort((a, b) => a - b) : extraKept },
    opened: [],
    transcript_read: [],
    failed: mergeRanges(failedRanges),
    signals: noSieve ? ["frame"] : ["frame", "pixel"],
  },
  frames: got.map((g) => ({ frame_path: g.path, at_sec: g.at, kind: "other" })),
  candidates: [],
};
const draftPath = join(outDir, "scan-draft.json");
if (!existsSync(draftPath)) {
  writeFileSync(draftPath, `${JSON.stringify(draft, null, 2)}\n`);
} else {
  // 이미 조사자가 손댔을 수 있다. 덮지 않고 새 이름으로 둔다.
  writeFileSync(join(outDir, "scan-draft.latest.json"), `${JSON.stringify(draft, null, 2)}\n`);
  console.log(`  (scan-draft.json 이 이미 있어 scan-draft.latest.json 으로 저장했다)`);
}

console.log(`\nout/ck/${vodId}/`);
console.log(`  probe.json        무엇을 계획하고 무엇을 받았나`);
console.log(`  scan-draft.json   ck:merge 초안 — **열어서 읽은 뒤** note·candidates 를 채운다`);
console.log(`\n다음:`);
console.log(`  1. 프레임을 연다 (out/ck/${vodId}/g*.jpg)`);
console.log(`  2. 읽은 것을 scan-draft.json 의 frames[].note 에 적는다 (적은 것만 '읽음' 이 된다)`);
console.log(`  3. 후보와 결론을 candidates 에 적고 scan.status 를 done 으로`);
console.log(`  4. npm run ck:merge -- --result out/ck/${vodId}/scan-draft.json`);
