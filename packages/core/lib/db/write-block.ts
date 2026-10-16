/**
 * "운영 DB 쓰기가 실제로 실패했다" 표시 — 한 곳에서 실패하면 다른 작업자가 새 조사 세션을 띄우지 않게 한다.
 *
 * ★ 점검(health.ts)은 시작 전·묶음 사이에 보는 것이고, 이건 **실제로 난 쓰기 오류**다. 디스크 부족처럼 점검이
 *   못 보는 원인도 있어서 둘을 따로 둔다. 표시는 회차 시작 점검(ops:usage --gate --clear-flag)이 통과할 때만 지운다 —
 *   회차 중간에 지우면 같은 오류를 세션마다 다시 겪는다.
 * ★ 표시 파일은 저장소의 out/ops/ 에 둔다(이 파일 위치 기준) — 실행 폴더가 달라도 같은 파일을 본다.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type postgres from "postgres";

import {
  isWriteBlockedError, judgeHealth, limitsFromEnv, projectRefFromUrl, readHealth,
  type HealthLimits, type HealthSnapshot, type Judgement,
} from "./health.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
export const WRITE_BLOCK_FLAG = join(REPO_ROOT, "out/ops/write-blocked.json");

export interface WriteBlock { at: string; source: string; code: string | null; message: string }

/** 쓰기가 막혀서 난 오류면 표시를 남기고 true. 다른 오류는 건드리지 않는다. 표시를 못 남겨도 원래 오류 처리를 막지 않는다. */
export function noteWriteBlocked(e: unknown, source: string, file = WRITE_BLOCK_FLAG): boolean {
  if (!isWriteBlockedError(e)) return false;
  const err = e as { code?: unknown; message?: unknown };
  const mark: WriteBlock = {
    at: new Date().toISOString(),
    source,
    code: typeof err?.code === "string" ? err.code : null,
    message: String(typeof err?.message === "string" ? err.message : e).slice(0, 300),
  };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(mark, null, 2) + "\n");
  } catch { /* 표시 실패는 원래 오류보다 덜 중요하다 */ }
  return true;
}

export function readWriteBlock(file = WRITE_BLOCK_FLAG): WriteBlock | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as WriteBlock;
  } catch {
    // 깨진 표시도 표시다 — 없는 것으로 치지 않는다.
    return { at: "?", source: "?", code: null, message: "표시 파일을 읽지 못했다" };
  }
}

export function clearWriteBlock(file = WRITE_BLOCK_FLAG): void {
  rmSync(file, { force: true });
}

/** 표시가 가리키는 원인 — 읽기 전용(25006)·디스크 부족(53100). 모르면 unknown(깨진 표시 포함). */
export function writeBlockKind(flag: WriteBlock): "read_only" | "disk" | "unknown" {
  if (flag.code === "25006" || /read-only transaction/i.test(flag.message)) return "read_only";
  if (flag.code === "53100" || /No space left on device|could not extend file/i.test(flag.message)) return "disk";
  return "unknown";
}

/**
 * 표시의 원인이 **해소됐음을 확인했나** — 확인한 것만 지운다. 확인 못 했으면(미확인) 지우지 않는다.
 * ★ 2026-10-12 검토 — 디스크 부족 표시가 있는데 물리 디스크가 미확인이어도 다른 지표가 괜찮다고 지워져 통과했다.
 *   읽기 전용은 기본 읽기 전용 off 가 직접 증거다(쓰기 트랜잭션이 그 값을 따른다). 관리 상태가 읽기 전용이면 아니다.
 *   디스크 부족은 물리 디스크를 실제로 읽어 중단선 아래일 때만. 원인을 모르는 표시는 사람이 확인하고 지운다.
 */
export function writeBlockResolved(flag: WriteBlock, s: HealthSnapshot, limits: HealthLimits): { ok: boolean; reason: string } {
  const kind = writeBlockKind(flag);
  if (!s.db.ok) return { ok: false, reason: `DB 확인 불가(${s.db.error})` };
  if (kind === "read_only") {
    if (s.db.readOnlyDefault) return { ok: false, reason: "기본 읽기 전용이 아직 on" };
    if (s.managed.ok && s.managed.readOnly && !s.managed.overrideEnabled) return { ok: false, reason: "Supabase 관리 상태가 아직 읽기 전용" };
    return { ok: true, reason: `기본 읽기 전용 off${s.managed.ok ? " · 관리 상태 쓰기 가능" : " (관리 상태는 미확인)"}` };
  }
  if (kind === "disk") {
    if (!s.disk.ok) return { ok: false, reason: `디스크 부족 기록인데 물리 디스크 미확인(${s.disk.error}) — 대시보드에서 여유를 확인했으면 ${WRITE_BLOCK_FLAG} 를 직접 지운다` };
    const ratio = s.disk.sizeBytes > 0 ? s.disk.usedBytes / s.disk.sizeBytes : NaN;
    if (!(ratio < limits.diskBlockRatio)) return { ok: false, reason: `물리 디스크가 아직 중단선 이상(${(ratio * 100).toFixed(1)}%)` };
    return { ok: true, reason: `물리 디스크 ${(ratio * 100).toFixed(1)}% — 중단선 아래` };
  }
  return { ok: false, reason: `원인을 모르는 기록 — 확인 후 ${WRITE_BLOCK_FLAG} 를 직접 지운다` };
}

/**
 * 점검 판정 + 쓰기 실패 표시 — 보고·정기 기록·관문이 **같은 판정**을 쓴다.
 * ★ 표시가 남아 있으면 어느 모드든 멈춤이다(정기 기록이 표시를 두고 '정상' 으로 ALERT 를 지운 적이 있다).
 *   clear 를 주면 원인 해소를 확인한 표시만 지우라고 돌려준다(writeBlockResolved).
 */
export function decideWithWriteBlock(
  s: HealthSnapshot, flag: WriteBlock | null, limits: HealthLimits, opts: { clear: boolean },
): Judgement & { clearFlag: boolean } {
  const j = judgeHealth(s, limits);
  if (!flag) return { ...j, clearFlag: false };
  const head = `쓰기 실패 기록 ${flag.at} ${flag.source}: ${flag.code ?? ""} ${flag.message}`;
  if (opts.clear) {
    const r = writeBlockResolved(flag, s, limits);
    if (r.ok) return { ...j, reasons: [`${head} — 해소 확인(${r.reason}), 표시를 지운다`, ...j.reasons], clearFlag: true };
    return { verdict: "block", reasons: [`${head} — 지우지 않는다: ${r.reason}`, ...j.reasons], clearFlag: false };
  }
  return { verdict: "block", reasons: [`${head} (${WRITE_BLOCK_FLAG})`, ...j.reasons], clearFlag: false };
}

/** 운영 DB 점검에서 멈춤 — 새 대량 쓰기를 시작하지 않는다. 다른 오류와 구분해 상주 루프가 그 잡만 쉬게 한다. */
export class DbGateBlocked extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbGateBlocked";
  }
}

/**
 * DB 를 크게 늘리는 작업(공개 큐 적재·백필) 직전에 부른다 — 묶음마다 부르면 그게 묶음 사이 재점검이다.
 * 쓰기 실패 표시가 있거나 점검이 멈춤이면 DbGateBlocked. 경고는 돌려주기만 한다.
 */
export async function assertDbWritable(sql: postgres.Sql, label: string, env: Record<string, string | undefined> = process.env): Promise<Judgement> {
  const s = await readHealth({
    sql,
    token: env.SUPABASE_MGMT_TOKEN || undefined,
    ref: env.SUPABASE_PROJECT_REF || projectRefFromUrl(env.DATABASE_URL),
    // 백필은 조각마다 여기를 지난다 — 관리 API(분당 호출 제한)는 1분 안의 결과를 다시 쓴다. DB 쪽은 매번 본다.
    mgmtCacheMs: 60_000,
  });
  // ops:usage 와 같은 판정 — 쓰기 실패 표시가 있으면 멈춘다(여기서는 지우지 않는다).
  const j = decideWithWriteBlock(s, readWriteBlock(), limitsFromEnv(env), { clear: false });
  if (j.verdict === "block") throw new DbGateBlocked(`${label}: 운영 DB 점검에서 멈춤 — ${j.reasons.join(" ; ")}`);
  return j;
}
