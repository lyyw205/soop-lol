/**
 * VOD 시간축의 단일 출처 — 분할 파일 오프셋 · 썸네일 시트 칸 ↔ 초 · 탐색 지점.
 *
 * ★ 왜 따로 있나 (docs/CK-LOCAL-FIX-PLAN.md §1·§2)
 *   파일 오프셋(HLS 실측)은 ck-probe 안에, 시트 칸 ↔ 초 대응은 scanSheets 안에 암묵적으로 있었다.
 *   둘이 따로 놀면서 시트 쪽이 틀려도 아무도 몰랐다. 실측(2026-09-30, VOD 3개·파일 7개):
 *     · 시트 `column=0` 과 `column=1` 은 **같은 이미지**다 (md5 동일)
 *     · 칸 간격은 **3초 고정**이다 — 중복을 빼면 칸 수 = ceil(길이/3) ±1
 *     · 옛 계산(길이 ÷ 칸 수, column 0 포함)은 파일 앞쪽 시각을 최대 약 5분 늦게 냈다
 *     · 시트가 끝나면 SOOP 은 **HTTP 500 + 빈 본문**을 준다 — 서버 오류와 모양이 같다
 *   그래서 끝은 응답 모양이 아니라 **칸이 파일 끝까지 덮었나**로 판정한다.
 *
 * ★ 이 파일에는 로컬 모델·실험 도구 경로를 넣지 않는다. 기존 조사 도구가 쓰는 공용 계약이다.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import jpeg from "jpeg-js";

import { soopFetch } from "./soop-http.mjs";
import { hlsSegments } from "./vod-hls.mjs";

export const SHEET_SEC = 3;          // 칸 하나 = 3초 (실측)
export const PER_SHEET = 100;        // 시트 하나 = 10×10 칸
export const FW = 192, FH = 108;     // 칸 크기 (1920×1080 시트를 10×10 으로)
/** 끝 경계 허용 — 실측 칸 수가 ceil(길이/3) 과 ±1 달랐다. 이보다 더 못 덮으면 못 본 범위다. */
export const END_SLACK_SEC = SHEET_SEC;

const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://vod.sooplive.com/" };
const rowKeyOf = (url) => new URL(url, "https://videoimg.sooplive.co.kr").searchParams.get("rowKey");

// ── 파일 오프셋 ───────────────────────────────────────────────────────

/**
 * 분할 파일마다 HLS 로 실제 길이를 재서 전역 시간축을 쌓는다. 재생목록 텍스트만 받는다.
 * ⚠ API 의 duration 은 실제보다 길게 보고하는 VOD 가 있다(CK-COLLECTION.md — 4.00h vs HLS 2.18h).
 *
 * `axisReliable` — 이 파일과 **앞 파일 전부**를 실측했나. 앞 파일 길이를 모르면 이 파일의 전역 시작
 * 위치도 모른다. 파일 안의 로컬 시각은 여전히 맞으므로 원본 추출은 되지만, 다른 도구와 시각을 맞출 때는 믿지 않는다.
 * @returns {Promise<{ parts: object[], total: number, failed: number[][] }>}  failed 는 전역 초 범위
 */
export async function measureParts(detail, { log = () => {} } = {}) {
  const parts = [];
  const failed = [];
  let axis = 0;
  let reliable = true;
  for (const [i, file] of (detail?.files ?? []).entries()) {
    const apiLength = (file.duration ?? 0) / 1000;
    let hls = null;
    try {
      hls = await hlsSegments(file);
    } catch (e) {
      log(`  f${i + 1}  ⚠ HLS 를 못 읽었다 — ${String(e.message).slice(0, 60)}`);
    }
    const hlsLength = hls?.segs?.length ? hls.segs.at(-1).start + hls.segs.at(-1).dur : null;
    const measured = hlsLength != null;
    const length = hlsLength ?? apiLength;
    reliable &&= measured;
    parts.push({ index: i + 1, file, offset: axis, length, apiLength, measured, axisReliable: reliable, hls });
    if (!measured) failed.push([Math.round(axis), Math.round(axis + length)]);
    else if (apiLength - hlsLength > 60) failed.push([Math.round(axis + hlsLength), Math.round(axis + apiLength)]);
    axis += length;
  }
  return { parts, total: axis, failed };
}

// ── 탐색 지점 ─────────────────────────────────────────────────────────

/**
 * 시간축 전체의 기본 탐색 지점. 거름망·모델과 **독립적으로** 깐다.
 *   · 전역 격자 (0, interval, 2·interval …)
 *   · 파일마다 격자 점이 하나도 없으면 가운데 한 장 — 짧은 꼬리 파일이 통째로 빠지지 않게
 *   · 파일마다 끝 − tailBack 초 한 장 — 끝 시각 자체에는 재생 가능한 화면이 없을 수 있다
 */
export function coveragePoints(parts, total, interval, { tailBack = 30 } = {}) {
  const points = new Set();
  for (let t = 0; t < total; t += interval) points.add(Math.round(t));
  for (const p of parts) {
    if (p.length <= 0) continue;
    const inside = (t) => t >= p.offset && t < p.offset + p.length;
    if (![...points].some(inside)) points.add(Math.round(p.offset + Math.min(p.length / 2, 60)));
    const tail = Math.round(Math.max(p.offset, p.offset + p.length - tailBack));
    if (inside(tail)) points.add(tail);
  }
  return [...points].sort((a, b) => a - b);
}

// ── 썸네일 시트 ───────────────────────────────────────────────────────

const isJpeg = (buf) => buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
const sha = (buf) => createHash("sha1").update(buf).digest("hex");

export const decodeSheet = (buf) => jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });

/** 시트의 cell 번째 칸(0~99, 행 우선)을 RGBA 이미지로. */
export function cellOf(sheet, cell) {
  const fx = cell % 10, fy = Math.floor(cell / 10);
  const data = new Uint8Array(FW * FH * 4);
  for (let y = 0; y < FH; y++) {
    const src = ((fy * FH + y) * sheet.width + fx * FW) * 4;
    data.set(sheet.data.subarray(src, src + FW * 4), y * FW * 4);
  }
  return { width: FW, height: FH, data };
}

/** 빈 칸 — 마지막 시트 뒤쪽은 한 색으로 채워져 온다. ⚠ 방송이 실제로 검은 화면이어도 빈 칸으로 센다(보수적). */
export function isBlankCell(img) {
  let sum = 0, sq = 0, n = 0;
  for (let i = 0; i < img.data.length; i += 4 * 7) {
    const v = img.data[i] + img.data[i + 1] + img.data[i + 2];
    sum += v; sq += v * v; n++;
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean)) < 6;
}

/**
 * 파일 하나의 썸네일 시트를 받는다. **완료는 칸이 파일 끝까지 덮었나로만 판정한다.**
 *
 * 완료 조건: ① column 0 과 1 이 같은 이미지임을 확인 ② 받은 시트가 전부 온전한 JPEG
 *            ③ 마지막 시트의 유효 칸을 셈 ④ 유효 칸 × 3초가 `length − 3초` 이상을 덮음
 * 덮기 전에 온 500·비JPEG·네트워크 오류는 재시도하고, 그래도면 그 시트부터 끝까지 `failed` 다.
 *
 * @param file   vodDetail 의 files[] 항목
 * @param length 파일 길이(초). HLS 실측값을 넘긴다. 없으면 API 값
 * @returns {{ sheets: {column:number, buf:Buffer, sha:string}[], cells:number, sec:number,
 *             covered:number, failed:number[][], reason:string|null, bytes:number }}
 *   `sheets` 는 중복(column 0)을 뺀 순서 — sheets[k] 가 칸 k·100 ~ k·100+99.
 *   `failed` 는 **파일 로컬 초** 범위. `reason` 은 failed 가 생긴 이유.
 */
export async function fetchSheets(file, length, { cacheDir = null, retries = 3, fetchImpl = soopFetch, retryDelayMs = 2000 } = {}) {
  const out = { sheets: [], cells: 0, sec: SHEET_SEC, covered: 0, failed: [], reason: null, bytes: 0 };
  const fail = (from, reason) => { out.failed = from < length ? [[Math.floor(from), Math.ceil(length)]] : []; out.reason = reason; return out; };
  if (!file.snapshot) return fail(0, "snapshot 없음");
  if (!(length > 0)) return fail(0, "길이 모름");
  const rowKey = rowKeyOf(file.snapshot);
  if (cacheDir) mkdirSync(cacheDir, { recursive: true });

  /** 한 시트. { kind: 'jpeg', buf } | { kind: 'end' } | { kind: 'error', why } — 재시도는 호출부가 정한다 */
  const once = async (column) => {
    const path = cacheDir ? join(cacheDir, `c${column}.jpg`) : null;
    if (path && existsSync(path)) {
      const buf = readFileSync(path);
      if (isJpeg(buf)) return { kind: "jpeg", buf };
    }
    try {
      const r = await fetchImpl(`https://videoimg.sooplive.co.kr/php/SnapshotLoad.php?rowKey=${rowKey}&column=${column}`, { headers: UA });
      const buf = Buffer.from(await r.arrayBuffer());
      if (r.status === 200 && isJpeg(buf)) {
        out.bytes += buf.length;
        if (path) writeFileSync(path, buf);
        return { kind: "jpeg", buf };
      }
      // 정상 끝도 이 모양이다(500 + 빈 본문). 끝인지는 덮은 범위로 호출부가 판단한다.
      if (r.status === 500 && buf.length === 0) return { kind: "end" };
      return { kind: "error", why: `HTTP ${r.status} ${buf.length}B` };
    } catch (e) {
      return { kind: "error", why: String(e?.message ?? e).slice(0, 60) };
    }
  };
  const get = async (column) => {
    let last;
    for (let a = 0; a <= retries; a++) {
      if (a) await new Promise((res) => setTimeout(res, retryDelayMs * a));
      last = await once(column);
      if (last.kind === "jpeg") return last;
    }
    return last;
  };

  // ① 중복 확인 — 가정하지 않는다. 다르면 대응을 모르는 것이다.
  const c0 = await get(0), c1 = await get(1);
  if (c0.kind !== "jpeg" || c1.kind !== "jpeg") return fail(0, `첫 시트를 못 받음 (${c0.kind}/${c1.kind})`);
  if (sha(c0.buf) !== sha(c1.buf)) return fail(0, "column 0 과 1 이 다르다 — 칸 대응 미확인");

  // ② 덮을 때까지 받는다. 필요한 수 + 1(칸 수 ±1 이 100칸 경계를 넘는 경우)까지만.
  const need = Math.ceil(Math.ceil(length / SHEET_SEC) / PER_SHEET);
  let got = c1;
  for (let column = 1; ; column++) {
    if (column > 1) got = await get(column);
    if (got.kind !== "jpeg") {
      const coveredSoFar = out.sheets.length * PER_SHEET * SHEET_SEC;
      if (coveredSoFar >= length - END_SLACK_SEC) break;
      return settle(out, length, got.kind === "end" ? "시트가 파일 끝 전에 끝남" : `시트 수신 실패 (${got.why})`);
    }
    out.sheets.push({ column, buf: got.buf, sha: sha(got.buf) });
    if (out.sheets.length >= need + 1) break;
    if (out.sheets.length >= need) {
      // 필요한 수를 받았다. 마지막 시트가 끝까지 덮으면 멈추고, 아니면 한 장 더 본다.
      if (lastCovered(out) >= length - END_SLACK_SEC) break;
    }
  }
  return settle(out, length, "시트가 파일 끝까지 덮지 못함");
}

/** 마지막 시트의 유효 칸까지 센 덮은 초. */
function lastCovered(out) {
  if (!out.sheets.length) return 0;
  const last = decodeSheet(out.sheets.at(-1).buf);
  let used = PER_SHEET;
  while (used > 0 && isBlankCell(cellOf(last, used - 1))) used--;
  out.cells = (out.sheets.length - 1) * PER_SHEET + used;
  out.covered = out.cells * SHEET_SEC;
  return out.covered;
}

function settle(out, length, reason) {
  const covered = lastCovered(out);
  if (covered < length - END_SLACK_SEC) {
    out.failed = [[Math.floor(covered), Math.ceil(length)]];
    out.reason = reason;
  }
  return out;
}

/** 파일 로컬 초 → 칸 위치. 덮지 못한 초면 null. */
export function cellIndexAt(sheets, cells, localSec) {
  if (localSec < 0) return null;
  const i = Math.floor(localSec / SHEET_SEC);
  if (i >= cells) return null;
  return { sheet: Math.floor(i / PER_SHEET), cell: i % PER_SHEET, index: i, at: i * SHEET_SEC };
}
