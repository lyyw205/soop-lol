/**
 * 실제 DB(Supabase)에 마이그레이션을 적용한다.
 *
 *   npm run db:migrate -- --status     # 무엇이 남았는지만 본다
 *   npm run db:migrate -- --baseline 0006   # 0006 까지는 '이미 적용됨'으로 장부에만 기록
 *   npm run db:migrate                 # 남은 것을 순서대로 적용
 *
 * ★ 이게 없어서 실제로 물렸다.
 *   `db/migrations/` 가 스키마의 유일한 출처라고 해놓고, 정작 운영 DB 에 적용하는
 *   경로는 손으로 하는 것뿐이었다. 그래서 새 컬럼을 추가한 뒤 verify:db(PGlite)는
 *   통과하는데 실제 적재가 `column "series_id" does not exist` 로 죽었다.
 *   PGlite 검증은 "SQL 이 맞는가"를 보고, 이 스크립트는 "운영 DB 가 따라왔는가"를 본다.
 *   둘 다 있어야 한다.
 *
 * 장부(`schema_migration`)에 적용한 버전을 남긴다. 이미 데이터가 들어간 DB 를
 * 처음 붙일 때는 `--baseline` 으로 과거분을 기록만 하고 실행은 건너뛴다 —
 * 이미 적용된 DDL 을 다시 돌리면 터진다.
 */

import { join } from "node:path";

import { closeDb, db } from "@soop-lol/core/lib/db/client";

import { loadMigrations, loadModuleMigrations } from "./lib/migrations.ts";

const ROOT = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const statusOnly = args.includes("--status");
const baselineIdx = args.indexOf("--baseline");
const baseline = baselineIdx >= 0 ? args[baselineIdx + 1] : null;

const sql = db();

try {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const all = [...loadMigrations(ROOT), ...loadModuleMigrations(ROOT)];
  const done = new Set(
    (await sql<{ version: string }[]>`SELECT version FROM schema_migration`).map((r) => r.version),
  );
  const pending = all.filter((m) => !done.has(m.version));

  console.log(`마이그레이션 ${all.length}개 · 적용됨 ${done.size} · 남음 ${pending.length}`);
  for (const m of pending) console.log(`  · ${m.version}  ${m.name}`);

  if (statusOnly) {
    // 아무것도 하지 않는다
  } else if (baseline) {
    const upto = all.filter((m) => m.version <= baseline && !done.has(m.version));
    for (const m of upto) {
      await sql`INSERT INTO schema_migration (version, name) VALUES (${m.version}, ${m.name})
                ON CONFLICT (version) DO NOTHING`;
    }
    console.log(`\n${baseline} 까지 ${upto.length}개를 '적용됨'으로 기록했다 (실행하지 않았다).`);
  } else {
    for (const m of pending) {
      process.stdout.write(`  적용 ${m.version} ${m.name} … `);
      // 한 마이그레이션은 통째로 성공하거나 통째로 없던 일이 되어야 한다.
      await sql.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx`INSERT INTO schema_migration (version, name) VALUES (${m.version}, ${m.name})`;
      });
      console.log("ok");
    }
    if (pending.length === 0) console.log("\n적용할 것이 없다.");
    else console.log(`\n${pending.length}개 적용 완료.`);
  }
} catch (e) {
  console.error(`\n실패: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
