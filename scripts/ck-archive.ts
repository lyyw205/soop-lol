/**
 * 조사가 끝난 VOD 폴더(`out/ck/<VOD>/` — 결과창 사진·썸네일 시트·조사 산출물)를 보관 드라이브로 옮기고,
 * 원래 자리에는 링크만 남긴다.
 *
 *   npm run ck:archive -- --dry-run          # 뭘 옮길지만 보여 준다
 *   npm run ck:archive                       # 옮긴다
 *   npm run ck:archive -- --dest /mnt/d/soop-lol-ck --min-age 30 [--limit 3]   # --limit: 앞에서 N개만(시험용)
 *
 * ★ 2026-10-09 시트만 옮기던 것(ck:archive-sheets)을 VOD 폴더 통째로 넓혔다. WSL 가상 디스크가 C: 를 채워
 *   매일 조사가 멈췄고(여유 6GB 이하), 그 대부분이 끝난 VOD 의 사진이었다. 예전에 시트만 옮긴 VOD 는
 *   `sheets` 링크가 이미 보관 위치를 가리키므로 그건 건너뛰고 나머지만 옮긴다.
 * ★ 왜 "끝난 것만 옮기나"
 *   보관 드라이브(외장 SSD, drvfs)는 쓰기가 ext4 보다 100~1000배 느리다(2026-10-03 실측: 작은 파일 1MB/s).
 *   조사 중인 VOD 는 빠른 쪽에 쓰고, 도장이 찍힌 VOD 만 한 번 옮긴다. 읽기는 55MB/s 라 검수 화면은 링크로 읽어도 된다
 *   (사진 경로는 `CK_ARCHIVE_ROOT` 를 허용 목록으로 둔다 — apps/web/app/admin/ck/frame/[...path]/route.ts).
 * ★ 끝난 기준은 조사 도장 하나다 — 롤 scan 이 done 이고 FC fco_scan 이 running 이 아닌 VOD,
 *   그리고 도장이 `--min-age` 분 넘게 안 바뀐 VOD(막 끝낸 세션이 뒷정리 중일 수 있다).
 *   다시 열린 VOD(ck:queue reopen)는 running 이라 옮기지 않는다. 옮긴 VOD 를 다시 조사해도 링크를 따라 쓰므로 동작한다(느릴 뿐).
 * ★ 복사 → 파일마다 크기 대조 → 원본 삭제 → 링크 순서다. 대조가 안 맞으면 원본을 지우지 않는다.
 * ★ 보관 드라이브가 빠지면 링크가 끊긴다 — 검수 화면은 사진·시트를 "없음"으로 보여 준다.
 */
import { parseArgs } from "node:util";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { closeDb, db } from "@soop-lol/core/lib/db/client";

const { values } = parseArgs({ options: { dest: { type: "string" }, "dry-run": { type: "boolean" }, "min-age": { type: "string" }, limit: { type: "string" } } });
const DEST = resolve(values.dest ?? "/mnt/d/soop-lol-ck");
const MIN_AGE_MIN = Number(values["min-age"] ?? 30);
const DRY = Boolean(values["dry-run"]);
const CK = resolve("out/ck");

/**
 * 폴더 안의 파일(상대 경로 → 크기). 링크는 따라가지 않는다 — 보관 위치를 가리키는 링크(예전에 옮긴 시트)는
 * 이미 거기 있으니 `skipped` 로 돌려주고, 그 밖의 링크는 옮길 수 없으니(exFAT 는 링크가 없다) 오류로 멈춘다.
 */
function listFiles(root: string, archived: string): { files: Map<string, number>; skipped: string[] } {
  const files = new Map<string, number>(), skipped: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name), rel = relative(root, p);
      if (e.isSymbolicLink()) {
        const to = resolve(dirname(p), readlinkSync(p));
        if (to === join(archived, rel)) { skipped.push(rel); continue; }
        throw new Error(`보관 위치 밖을 가리키는 링크가 있다: ${rel} → ${to}`);
      }
      if (e.isDirectory()) walk(p); else files.set(rel, statSync(p).size);
    }
  };
  walk(root);
  return { files, skipped };
}

/**
 * 내용만 복사한다. cpSync·copyFileSync 는 권한·시각을 따라 복사하려다 exFAT(drvfs)에서 EPERM 으로 죽는다
 * (2026-10-03 첫 실행에서 89개 전부 실패 — 원본은 그대로였다). 보관본에는 권한·시각이 의미가 없다.
 */
function copyFiles(from: string, to: string, files: Map<string, number>): void {
  for (const rel of files.keys()) {
    mkdirSync(dirname(join(to, rel)), { recursive: true });
    writeFileSync(join(to, rel), readFileSync(join(from, rel)));
  }
}

// 보관 드라이브가 실제로 쓸 수 있는 상태인지 먼저 본다 — 마운트가 풀린 빈 폴더에 복사하면 ext4 가 찬다.
const mountRoot = DEST.split("/").slice(0, 3).join("/");
if (!DRY) {
  try {
    mkdirSync(DEST, { recursive: true });
    const probe = join(DEST, ".write-probe"); writeFileSync(probe, "ok"); unlinkSync(probe);
  } catch (e) { console.error(`보관 위치에 쓸 수 없다: ${DEST} — ${(e as Error).message}`); process.exit(2); }
  const mounts = readFileSync("/proc/mounts", "utf8");
  if (!mounts.split("\n").some((l) => l.split(" ")[1] === mountRoot)) { console.error(`${mountRoot} 가 마운트되어 있지 않다. 복사하지 않는다.`); process.exit(2); }
}

// 아직 로컬에 있는(링크가 아닌) VOD 폴더만.
const local = readdirSync(CK).filter((d) => /^\d+$/.test(d) && !lstatSync(join(CK, d)).isSymbolicLink() && lstatSync(join(CK, d)).isDirectory());
const rows: { v: string }[] = local.length ? (await db().unsafe(`
  select substring(source_key from 5) v from event_lead
  where source_key = any(array[${local.map((v) => `'vod:${v}'`).join(",")}])
    and raw->'scan'->>'status' = 'done' and coalesce(raw->'fco_scan'->>'status','') <> 'running'
    and updated_at < now() - interval '${MIN_AGE_MIN} minutes'`)) as any : [];
await closeDb();
const targets = rows.map((r) => r.v).sort().slice(0, values.limit ? Number(values.limit) : undefined);
console.log(`로컬 VOD 폴더 ${local.length}개 중 옮길 것 ${targets.length}개 (조사 완료·${MIN_AGE_MIN}분 경과)${DRY ? " — dry-run" : ""}`);

let moved = 0, bytes = 0, failed = 0;
for (const v of targets) {
  const src = join(CK, v), dst = join(DEST, v);
  try {
    const { files } = listFiles(src, dst);
    const size = [...files.values()].reduce((a, b) => a + b, 0);
    if (DRY) { bytes += size; moved++; continue; }
    copyFiles(src, dst, files);
    for (const [rel, n] of files) {
      const got = existsSync(join(dst, rel)) ? statSync(join(dst, rel)).size : -1;
      if (got !== n) throw new Error(`대조 불일치 ${rel}: ${n} ≠ ${got}`);
    }
    // 원본을 먼저 옆으로 치우고 링크를 건 뒤 지운다 — 도중에 끊겨도 원본과 링크 중 하나는 남는다.
    const aside = `${src}.archiving`;
    renameSync(src, aside);
    symlinkSync(dst, src);
    rmSync(aside, { recursive: true, force: true });
    moved++; bytes += size;
    console.log(`  ${v}  ${(size / 2 ** 20).toFixed(0)}MB 옮김`);
  } catch (e) { failed++; console.error(`  ${v}  ✗ ${(e as Error).message} — 원본을 그대로 둔다`); }
}
console.log(`${DRY ? "옮길 것" : "옮김"} ${moved}개 · ${(bytes / 2 ** 30).toFixed(2)}GB${failed ? ` · 실패 ${failed}개` : ""}`);
process.exit(failed ? 1 : 0);
