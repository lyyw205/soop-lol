/**
 * VOD 의 3초 간격 썸네일 칸 — 판독 때 받아 둔 썸네일 시트(`out/ck/<VOD>/sheets/f<파일>/c<번호>.jpg`)에서 칸 하나를 잘라 준다.
 *
 * 검수자가 "결과 화면 앞뒤 맥락"(직전의 선택, 직후의 반응)을 보려면 조사가 원본으로 뽑은 몇 장이 아니라 방송 전체의 흐름이 필요하다.
 * 시트는 방송 전체를 3초 칸(192×108)으로 이미 담고 있으므로 원본을 새로 받지 않고 거기서 자른다.
 * 시트 해석(칸 = floor(파일 로컬 초 / 3), 시트 = floor(칸 / 100), 시트 안 위치 = 10×10 행 우선)은
 * scripts/lib/vod-timeline.mjs 의 `cellIndexAt`·`cellOf` 와 같다 — 웹이 scripts 를 import 하지 않으려고 같은 계산을 여기 둔다.
 *
 * ★ `CK_OUT_ROOT` 에서만 읽는다(프레임 라우트와 같은 규칙, 배포 서버에는 없다). fs 는 동적 import — 정적이면 빌드가 프로젝트 전체를 추적한다.
 * ★ jpeg-js 는 루트에 설치된 순수 JS 라이브러리다(scripts 의 시트 훑기와 같이 쓴다).
 */
import jpeg from "jpeg-js";

export const CELL_SEC = 3;
const PER_SHEET = 100;
const FW = 192, FH = 108;

interface SheetPart { index: number; offset: number; length: number; cells: number; sheets: string[] }
interface Layout { parts: SheetPart[]; total: number }

type Fs = typeof import("node:fs/promises");
const layouts = new Map<string, Layout | null>();
const decoded = new Map<string, jpeg.UintArrRet>();   // 최근에 푼 시트 몇 장 — 띠 하나가 같은 시트를 여러 칸 쓴다
const DECODED_MAX = 6;

async function root(fs: Fs): Promise<string | null> {
  const configured = process.env.CK_OUT_ROOT;
  if (!configured) return null;
  try { return (await fs.stat(configured)).isDirectory() ? (await import("node:path")).resolve(configured) : null; } catch { return null; }
}

async function layoutOf(vod: string): Promise<Layout | null> {
  if (layouts.has(vod)) return layouts.get(vod)!;
  const fs: Fs = await import("node:fs/promises");
  const { join } = await import("node:path");
  const base = await root(fs);
  let out: Layout | null = null;
  if (base) {
    try {
      const raw = JSON.parse(await fs.readFile(join(base, "ck", vod, "local", "sheets.json"), "utf8")) as { parts?: SheetPart[] };
      const parts = (raw.parts ?? []).filter((p) => Array.isArray(p.sheets) && p.sheets.length > 0);
      if (parts.length) out = { parts, total: Math.max(...parts.map((p) => p.offset + Math.min(p.length, p.cells * CELL_SEC))) };
    } catch { /* 시트가 없는 VOD — 칸을 못 보여 줄 뿐이다 */ }
  }
  if (out) layouts.set(vod, out); // 없다는 결과는 캐시하지 않는다 — 나중에 시트가 생길 수 있다
  return out;
}

/** 이 VOD 에서 칸을 꺼낼 수 있는 전체 길이(초). 시트가 없으면 null. */
export async function vodCellLength(vod: string): Promise<number | null> {
  if (!/^\d{1,12}$/.test(vod)) return null;
  return (await layoutOf(vod))?.total ?? null;
}

/** VOD 전체 초의 칸을 JPEG 로. 시트가 없거나 범위 밖이면 null. */
export async function readCell(vod: string, sec: number): Promise<Uint8Array | null> {
  if (!/^\d{1,12}$/.test(vod) || !Number.isInteger(sec) || sec < 0) return null;
  const layout = await layoutOf(vod);
  if (!layout) return null;
  // 파일 경계에서는 뒤 파일을 우선한다(앞 파일 끝 칸은 겹치는 꼬리일 수 있다).
  const part = [...layout.parts].reverse().find((p) => sec >= p.offset);
  if (!part) return null;
  const i = Math.floor((sec - part.offset) / CELL_SEC);
  if (i < 0 || i >= part.cells) return null;
  const sheetPath = part.sheets[Math.floor(i / PER_SHEET)];
  if (!sheetPath) return null;

  const fs: Fs = await import("node:fs/promises");
  const { join, resolve, sep } = await import("node:path");
  const base = await root(fs);
  if (!base) return null;
  const rel = sheetPath.startsWith("out/") ? sheetPath.slice(4) : sheetPath;
  const file = resolve(join(base, rel));
  if (!file.startsWith(base + sep)) return null; // 뿌리 밖 경로는 거부한다

  let sheet = decoded.get(file);
  if (!sheet) {
    try { sheet = jpeg.decode(await fs.readFile(file), { useTArray: true, maxMemoryUsageInMB: 512 }); } catch { return null; }
    decoded.set(file, sheet);
    if (decoded.size > DECODED_MAX) decoded.delete(decoded.keys().next().value as string);
  }
  const cell = i % PER_SHEET, fx = cell % 10, fy = Math.floor(cell / 10);
  const data = new Uint8Array(FW * FH * 4);
  for (let y = 0; y < FH; y++) {
    const src = ((fy * FH + y) * sheet.width + fx * FW) * 4;
    data.set(sheet.data.subarray(src, src + FW * 4), y * FW * 4);
  }
  return jpeg.encode({ width: FW, height: FH, data }, 82).data;
}
