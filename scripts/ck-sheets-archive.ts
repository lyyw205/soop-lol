/**
 * 조사가 끝난 VOD 의 썸네일 시트를 보관 드라이브로 옮기고, 원래 자리에는 링크만 남긴다.
 *
 *   npm run ck:archive-sheets -- --dry-run          # 뭘 옮길지만 보여 준다
 *   npm run ck:archive-sheets                       # 옮긴다
 *   npm run ck:archive-sheets -- --dest /mnt/d/soop-lol-ck --min-age 30
 *
 * ★ 왜 "끝난 것만 옮기나"
 *   보관 드라이브(외장 SSD, drvfs)는 쓰기가 ext4 보다 100~1000배 느리다(2026-10-03 실측: 작은 파일 1MB/s).
 *   조사 중인 VOD 는 빠른 쪽에 쓰고, 도장이 찍힌 VOD 만 한 번 옮긴다. 읽기는 55MB/s 라 검수 화면은 링크로 읽어도 된다.
 * ★ 끝난 기준은 조사 도장 하나다 — 롤 scan 이 done 이고 FC fco_scan 이 running 이 아닌 VOD,
 *   그리고 도장이 `--min-age` 분 넘게 안 바뀐 VOD(막 끝낸 세션이 뒷정리 중일 수 있다).
 * ★ 복사 → 파일 수·바이트 대조 → 원본 삭제 → 링크 순서다. 대조가 안 맞으면 원본을 지우지 않는다.
 * ★ 보관 드라이브가 빠지면 링크가 끊긴다 — 검수 화면은 "시트 없음"으로 보여 준다(vod-cells.ts).
 */
import { parseArgs } from "node:util";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { closeDb, db } from "@soop-lol/core/lib/db/client";

const { values } = parseArgs({ options: { dest: { type: "string" }, "dry-run": { type: "boolean" }, "min-age": { type: "string" } } });
const DEST = resolve(values.dest ?? "/mnt/d/soop-lol-ck");
const MIN_AGE_MIN = Number(values["min-age"] ?? 30);
const DRY = Boolean(values["dry-run"]);
const CK = resolve("out/ck");

function walk(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const s = walk(p); files += s.files; bytes += s.bytes; } else { files++; bytes += statSync(p).size; }
  }
  return { files, bytes };
}

/**
 * 내용만 복사한다. cpSync·copyFileSync 는 권한·시각을 따라 복사하려다 exFAT(drvfs)에서 EPERM 으로 죽는다
 * (2026-10-03 첫 실행에서 89개 전부 실패 — 원본은 그대로였다). 보관본에는 권한·시각이 의미가 없다.
 */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name), b = join(to, e.name);
    if (e.isDirectory()) copyTree(a, b); else writeFileSync(b, readFileSync(a));
  }
}

// 보관 드라이브가 실제로 쓸 수 있는 상태인지 먼저 본다 — 마운트가 풀린 빈 폴더에 복사하면 ext4 가 찬다.
const mountRoot = DEST.split("/").slice(0, 3).join("/");
if (!DRY) {
  try {
    mkdirSync(DEST, { recursive: true });
    const probe = join(DEST, ".write-probe"); writeFileSync(probe, "ok"); unlinkSync(probe);
  } catch (e) { console.error(`보관 위치에 쓸 수 없다: ${DEST} — ${(e as Error).message}`); process.exit(2); }
  const mounts = (await import("node:fs")).readFileSync("/proc/mounts", "utf8");
  if (!mounts.split("\n").some((l) => l.split(" ")[1] === mountRoot)) { console.error(`${mountRoot} 가 마운트되어 있지 않다. 복사하지 않는다.`); process.exit(2); }
}

const local = readdirSync(CK).filter((d) => /^\d+$/.test(d) && existsSync(join(CK, d, "sheets")) && !lstatSync(join(CK, d, "sheets")).isSymbolicLink());
const rows: { v: string }[] = local.length ? (await db().unsafe(`
  select substring(source_key from 5) v from event_lead
  where source_key = any(array[${local.map((v) => `'vod:${v}'`).join(",")}])
    and raw->'scan'->>'status' = 'done' and coalesce(raw->'fco_scan'->>'status','') <> 'running'
    and updated_at < now() - interval '${MIN_AGE_MIN} minutes'`)) as any : [];
await closeDb();
const targets = rows.map((r) => r.v).sort();
console.log(`로컬 시트 있는 VOD ${local.length}개 중 옮길 것 ${targets.length}개 (조사 완료·${MIN_AGE_MIN}분 경과)${DRY ? " — dry-run" : ""}`);

let moved = 0, bytes = 0, failed = 0;
for (const v of targets) {
  const src = join(CK, v, "sheets"), dst = join(DEST, v, "sheets");
  const size = walk(src);
  if (DRY) { bytes += size.bytes; moved++; continue; }
  try {
    rmSync(dst, { recursive: true, force: true });
    mkdirSync(join(DEST, v), { recursive: true });
    copyTree(src, dst);
    const got = walk(dst);
    if (got.files !== size.files || got.bytes !== size.bytes) throw new Error(`대조 불일치 ${size.files}/${size.bytes} ≠ ${got.files}/${got.bytes}`);
    rmSync(src, { recursive: true, force: true });
    symlinkSync(dst, src);
    moved++; bytes += size.bytes;
    console.log(`  ${v}  ${(size.bytes / 2 ** 20).toFixed(0)}MB 옮김`);
  } catch (e) { failed++; console.error(`  ${v}  ✗ ${(e as Error).message} — 원본을 그대로 둔다`); }
}
console.log(`${DRY ? "옮길 것" : "옮김"} ${moved}개 · ${(bytes / 2 ** 30).toFixed(2)}GB${failed ? ` · 실패 ${failed}개` : ""}`);
