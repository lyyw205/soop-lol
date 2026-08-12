/**
 * 실제 DB(Supabase)에 마이그레이션을 적용한다.
 *
 *   npm run db:migrate -- --status     # 무엇이 남았는지만 본다
 *   npm run db:migrate -- --baseline 0006   # 0006 까지는 '이미 적용됨'으로 장부에만 기록
 *   npm run db:migrate                 # 남은 것을 순서대로 적용
 *   npm run db:migrate -- --adopt      # 이미 적용된 것들의 현재 지문을 장부에 다시 적는다
 *
 * ★ 이게 없어서 실제로 물렸다.
 *   `db/migrations/` 가 스키마의 유일한 출처라고 해놓고, 정작 운영 DB 에 적용하는
 *   경로는 손으로 하는 것뿐이었다. 그래서 새 컬럼을 추가한 뒤 verify:db(PGlite)는
 *   통과하는데 실제 적재가 `column "series_id" does not exist` 로 죽었다.
 *   PGlite 검증은 "SQL 이 맞는가"를 보고, 이 스크립트는 "운영 DB 가 따라왔는가"를 본다.
 *   둘 다 있어야 한다.
 *
 * ★ 적용된 뒤에 파일이 바뀌면 **멈춘다.**
 *   실제로 물렸다 — 이미 적용한 0016 을 고쳤는데 러너는 "적용할 것이 없다" 라고만 했고,
 *   저장소의 SQL 과 DB 의 실제 스키마가 그때부터 갈라졌다. 하필 빠진 게 core_public 의
 *   숨김 조인이라 숨긴 스트리머가 새어 나가는 상태였는데, 저장소만 보면 멀쩡해 보인다.
 *   그래서 장부에 파일 지문을 같이 남기고, 매번 대조한다.
 *
 *   고친 게 정당하면(주석 오타 등, DB 는 이미 맞다) `--adopt` 로 지문을 다시 적는다.
 *   **DDL 을 고쳤다면 adopt 가 아니라 새 마이그레이션을 쓴다** — 이미 돌아간 SQL 은
 *   되돌릴 수 없고, 다음 배포지의 DB 는 새 파일로 만들어질 테니 둘이 또 갈라진다.
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
const adopt = args.includes("--adopt");
const baselineIdx = args.indexOf("--baseline");
const baseline = baselineIdx >= 0 ? args[baselineIdx + 1] : null;

const sql = db();

/**
 * ★ 본문을 함수로 감싼 이유
 *   중간에 멈출 자리가 둘(지문 불일치 · --adopt)인데, 최상위에서 process.exit 을
 *   부르면 아래 finally 의 `await closeDb()` 가 끝나기 전에 프로세스가 죽는다.
 *   연결을 중간에 끊는 종료라 DB 쪽에 흔적이 남는다. return 으로 빠져나온다.
 */
async function run(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version    text PRIMARY KEY,
      name       text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  // 장부가 먼저 생긴 DB 도 있다. 지문 칸은 나중에 붙인다.
  await sql`ALTER TABLE schema_migration ADD COLUMN IF NOT EXISTS checksum text`;

  const all = [...loadMigrations(ROOT), ...loadModuleMigrations(ROOT)];
  const ledger = new Map(
    (await sql<{ version: string; checksum: string | null }[]>`
      SELECT version, checksum FROM schema_migration`).map((r) => [r.version, r.checksum]),
  );
  const pending = all.filter((m) => !ledger.has(m.version));

  console.log(`마이그레이션 ${all.length}개 · 적용됨 ${ledger.size} · 남음 ${pending.length}`);
  for (const m of pending) console.log(`  · ${m.version}  ${m.name}`);

  // ── 적용된 뒤에 파일이 바뀌었나 ────────────────────────────────────
  const changed = all.filter((m) => {
    const rec = ledger.get(m.version);
    return rec != null && rec !== m.checksum;
  });
  // 지문을 모르는 것 — 이 기능이 생기기 전에 적용됐다. 바뀌었는지 **알 수 없다**.
  //   현재 지문을 조용히 적으면 '확인했다' 는 거짓말이 되므로, 사람이 --adopt 로 정한다.
  const unknown = all.filter((m) => ledger.has(m.version) && ledger.get(m.version) == null);

  if (adopt) {
    for (const m of all) {
      if (!ledger.has(m.version)) continue;
      await sql`UPDATE schema_migration SET checksum = ${m.checksum} WHERE version = ${m.version}`;
    }
    console.log(`\n적용된 ${ledger.size}개의 현재 지문을 장부에 적었다`
      + `${changed.length ? ` (그중 ${changed.length}개는 파일이 바뀐 것이었다)` : ""}.`);
    console.log(`⚠ DDL 을 고친 거라면 이걸로 끝내면 안 된다 — 다른 DB 는 여전히 옛 SQL 로 만들어졌다.`);
    return;
  }

  if (changed.length > 0) {
    console.error(`\n적용된 뒤에 파일이 바뀐 마이그레이션 ${changed.length}개다. 아무것도 적용하지 않았다:\n`);
    for (const m of changed) {
      console.error(`  ✖ ${m.version} ${m.name}`);
      console.error(`     장부 ${ledger.get(m.version)} ≠ 파일 ${m.checksum}   (${m.file})`);
    }
    console.error(`\n저장소의 SQL 과 이 DB 의 실제 스키마가 갈라져 있다. 둘 중 하나다:`);
    console.error(`  · 주석·오타만 고쳤고 DB 는 이미 맞다  → npm run db:migrate -- --adopt`);
    console.error(`  · DDL 을 고쳤다                      → 되돌리지 말고 **새 마이그레이션**을 써라`);
    process.exitCode = 1;
    return;
  }
  if (unknown.length > 0) {
    console.log(`\n⚠ 지문을 모르는 마이그레이션 ${unknown.length}개 (이 검사가 생기기 전에 적용됨).`);
    console.log(`   바뀌었는지 확인할 수 없다. 지금 DB 가 맞다고 보면: npm run db:migrate -- --adopt`);
  }

  if (statusOnly) {
    // 아무것도 하지 않는다
  } else if (baseline) {
    const upto = all.filter((m) => m.version <= baseline && !ledger.has(m.version));
    for (const m of upto) {
      await sql`INSERT INTO schema_migration (version, name, checksum)
                VALUES (${m.version}, ${m.name}, ${m.checksum})
                ON CONFLICT (version) DO NOTHING`;
    }
    console.log(`\n${baseline} 까지 ${upto.length}개를 '적용됨'으로 기록했다 (실행하지 않았다).`);
  } else {
    for (const m of pending) {
      process.stdout.write(`  적용 ${m.version} ${m.name} … `);
      // 한 마이그레이션은 통째로 성공하거나 통째로 없던 일이 되어야 한다.
      await sql.begin(async (tx) => {
        await tx.unsafe(m.sql);
        await tx`INSERT INTO schema_migration (version, name, checksum)
                 VALUES (${m.version}, ${m.name}, ${m.checksum})`;
      });
      console.log("ok");
    }
    if (pending.length === 0) console.log("\n적용할 것이 없다.");
    else console.log(`\n${pending.length}개 적용 완료.`);
  }
}

try {
  await run();
} catch (e) {
  console.error(`\n실패: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
