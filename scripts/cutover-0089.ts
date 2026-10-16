/**
 * 0089(분류·수집 뼈대) 전환 — docs/CLASSIFICATION-REDESIGN-PLAN.md §8 4단계.
 *
 *   node --env-file=apps/web/.env.local scripts/cutover-0089.ts            # 미리보기: 끝까지 돌리고 되돌린다(아무것도 안 남음)
 *   node --env-file=apps/web/.env.local scripts/cutover-0089.ts --apply    # 백업 → 전환 → 대조 통과 시에만 커밋
 *
 * ★ 실패하면 원상태: 표 잠금 → 기준 측정 → 0089 → 대조 → 장부 기록이 **한 트랜잭션**이다. 대조가 하나라도 틀리거나
 *   어디서든 오류가 나면 커밋하지 않는다 — 공개 큐 판 삭제까지 통째로 취소된다.
 * ★ --apply 는 먼저 표 전체를 D:(T7)에 파일로 받아 둔다(scripts/lib/db-copy.ts). 커밋한 뒤 문제가 나면 그 파일이 마지막 수단이다.
 * ★ 돌리기 전에 쓰는 진입점(타이머·개발 서버·수동 작업)을 멈춘다. 이 도구는 실행 중인 job_run 이 있으면 시작하지 않는다.
 */
import { join } from "node:path";
import postgres from "postgres";

import { backupTo } from "./lib/db-copy.ts";
import { loadMigrations } from "./lib/migrations.ts";
import { captureBefore, checkAfter } from "./lib/skeleton-checks.ts";

const ROOT = join(import.meta.dirname, "..");
const VERSION = "0089";

class Rollback extends Error {}

export interface CutoverResult { committed: boolean; seconds: number; failures: string[]; info: string[] }

/** 한 트랜잭션 안에서 전환하고 대조한다. apply 가 아니거나 대조가 실패하면 되돌린다. */
export async function runCutover(sql: postgres.Sql, opts: { apply: boolean; log?: (s: string) => void }): Promise<CutoverResult> {
  const log = opts.log ?? (() => {});
  const m = loadMigrations(ROOT).find((x) => x.version === VERSION);
  if (!m) throw new Error(`${VERSION} 마이그레이션 파일이 없다`);
  let report: { failures: string[]; info: string[] } = { failures: [], info: [] };
  const t0 = Date.now();
  try {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL lock_timeout = '15s'`;
      await tx`SET LOCAL statement_timeout = '20min'`;
      // 기준과 적용 사이에 끼어드는 쓰기가 없게 먼저 잠근다(읽기도 잠깐 막힌다 — 공개 전이라 괜찮다).
      await tx`LOCK TABLE match, match_series, event, match_participant, fco_match_participant, review_change,
                          schedule_entry, fco_event_match_decision, fco_match_context IN ACCESS EXCLUSIVE MODE`;
      const before = await captureBefore(tx);
      log(`기준: 경기 ${before.matches} · 지울 공개 큐 판 ${before.deleted.length}`);
      await tx.unsafe(m.sql);
      log(`0089 적용 ${((Date.now() - t0) / 1000).toFixed(1)}초`);
      report = await checkAfter(tx, before);
      if (report.failures.length) throw new Rollback("대조 실패");
      await tx`INSERT INTO schema_migration (version, name, checksum) VALUES (${m.version}, ${m.name}, ${m.checksum})`;
      if (!opts.apply) throw new Rollback("미리보기");
    });
    return { committed: true, seconds: (Date.now() - t0) / 1000, ...report };
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    return { committed: false, seconds: (Date.now() - t0) / 1000, ...report };
  }
}

async function preflight(sql: postgres.Sql): Promise<string[]> {
  const problems: string[] = [];
  const ledger = new Set((await sql`SELECT version FROM schema_migration`).map((r) => r.version as string));
  for (const m of loadMigrations(ROOT)) {
    if (m.version < VERSION && !ledger.has(m.version)) problems.push(`${m.file} 가 아직 적용되지 않았다`);
  }
  if (ledger.has(VERSION)) problems.push(`${VERSION} 은 이미 적용됐다`);
  const running = await sql`SELECT coalesce(ops_job, job) AS job FROM job_run WHERE state = 'running' AND heartbeat_at > now() - interval '5 minutes'`;
  if (running.length) problems.push(`실행 중인 작업이 있다: ${running.map((r) => r.job).join(", ")} — 쓰는 진입점을 먼저 멈춘다`);
  return problems;
}

if (import.meta.main) {
  const apply = process.argv.includes("--apply");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 이 없다 — node --env-file=apps/web/.env.local 로 실행");
  const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1, onnotice: () => {} });
  const log = (s: string) => console.log(`[${new Date().toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul" })}] ${s}`);
  try {
    const problems = await preflight(sql);
    if (problems.length) { console.error(`시작하지 않는다:\n  - ${problems.join("\n  - ")}`); process.exitCode = 1; }
    else {
      if (apply) {
        const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).replace(/[-: ]/g, "").slice(0, 12);
        const dir = process.env.CUTOVER_BACKUP_DIR ?? `/mnt/d/soop-lol-backup/0089-${stamp}`;
        log(`백업 → ${dir}`);
        const tables = await backupTo(sql, dir);
        log(`백업 끝: 표 ${tables.length}개 · ${tables.reduce((n, t) => n + t.rows, 0)}행`);
      }
      const r = await runCutover(sql, { apply, log });
      for (const i of r.info) log(i);
      if (r.failures.length) console.error(`대조 실패 — 되돌렸다:\n  - ${r.failures.join("\n  - ")}`);
      log(r.committed ? `전환 커밋 (${r.seconds.toFixed(1)}초)` : `되돌림 (${apply ? "대조 실패" : "미리보기"}, ${r.seconds.toFixed(1)}초)`);
      if (r.failures.length) process.exitCode = 1;
    }
  } finally {
    await sql.end();
  }
}
