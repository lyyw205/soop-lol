/**
 * 운영 DB 점검 — 잠금·용량·물리 디스크·큰 표·증가 속도.
 *
 *   npm run ops:usage                         # 보고서
 *   npm run ops:usage -- --record             # + out/ops/usage.jsonl 에 남기고, 경고면 out/ops/ALERT 를 쓴다(정기 타이머)
 *   npm run ops:usage -- --gate               # 새 조사 세션·대량 쓰기 전 관문. 한 줄 출력, 멈춤이면 종료 코드 3
 *   npm run ops:usage -- --gate --clear-flag  # 회차 시작: 원인 해소를 확인한 쓰기 실패 표시(out/ops/write-blocked.json)만 지운다
 *
 * ★ 판정 규칙은 core(db/health.ts) 하나다. 확인 못 한 항목은 '미확인'으로 찍고 0·정상으로 바꾸지 않는다.
 * ★ 관리 API 토큰은 ~/.config/soop-lol/ops.env 의 SUPABASE_MGMT_TOKEN — 웹·조사 세션의 .env.local 과 분리한다.
 *   없으면 Supabase 관리 잠금 상태와 물리 디스크가 미확인으로 나온다.
 * ★ 전송량(egress) 누적은 DB 에서 볼 수 없다 — 대시보드 Usage 의 Shared Pooler Egress 로 본다.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { closeDb, db } from "@soop-lol/core/lib/db/client";
import {
  growthPerDay, limitsFromEnv, mb, projectRefFromUrl, readHealth, type HealthSnapshot, type Judgement,
} from "@soop-lol/core/lib/db/health";
import { clearWriteBlock, decideWithWriteBlock, readWriteBlock } from "@soop-lol/core/lib/db/write-block";

const GATE = process.argv.includes("--gate");
const RECORD = process.argv.includes("--record");
const CLEAR = process.argv.includes("--clear-flag");
const OPS = fileURLToPath(new URL("../out/ops/", import.meta.url));
const HISTORY = join(OPS, "usage.jsonl"), ALERT = join(OPS, "ALERT");
const LABEL = { ok: "정상", warn: "경고", block: "멈춤" } as const;

const kst = (iso: string) => new Date(iso).toLocaleString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 16);

function history(): { at: string; totalBytes: number | null }[] {
  if (!existsSync(HISTORY)) return [];
  return readFileSync(HISTORY, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { const o = JSON.parse(l); return [{ at: o.at, totalBytes: o.totalBytes ?? null }]; } catch { return []; }
  });
}

/** 지난 24시간 DB 전송 계측(DB_WIRE_LOG) — 계측을 켠 스크립트만 잡힌다. 대시보드의 전송량 전체가 아니다. */
function wireSummary(now: number): string | null {
  const file = join(OPS, "db-wire.jsonl");
  if (!existsSync(file)) return null;
  const by = new Map<string, { read: number; runs: number }>();
  let total = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      if (now - Date.parse(o.at) > 24 * 3600_000) continue;
      // 하위 명령(plan·begin·finish …)만 나눠 센다 — 이름 같은 인자는 묶는다.
      const k = /^[a-z][a-z-]{1,20}$/.test(o.arg ?? "") ? `${o.script} ${o.arg}` : o.script;
      const e = by.get(k) ?? { read: 0, runs: 0 };
      e.read += o.read; e.runs++; total += o.read; by.set(k, e);
    } catch { /* 깨진 줄은 건너뛴다 */ }
  }
  if (!by.size) return null;
  const top = [...by].sort((a, b) => b[1].read - a[1].read).slice(0, 6)
    .map(([k, e]) => `${k} ${mb(e.read)}/${e.runs}회`).join(" · ");
  return `  전송    지난 24시간 계측분 받은 ${mb(total)} — ${top} (계측 켠 스크립트만, 전체는 대시보드)`;
}

function report(s: HealthSnapshot, j: Judgement, growth: number | null): string {
  const lines = [`운영 DB 점검 ${kst(s.at)} KST — ${LABEL[j.verdict]}`];
  if (s.db.ok) {
    lines.push(`  잠금    기본 읽기 전용 ${s.db.readOnlyDefault ? "on" : "off"} (설정 출처: ${s.db.readOnlySource})`
      + ` · Supabase 관리 상태 ${s.managed.ok ? (s.managed.readOnly ? `읽기 전용${s.managed.overrideEnabled ? "(임시 해제 중)" : ""}` : "쓰기 가능") : "미확인"}`);
    const limits = limitsFromEnv();
    lines.push(`  크기    DB ${mb(s.db.totalBytes)} / 한도 ${mb(limits.quotaBytes)} (${(s.db.totalBytes / limits.quotaBytes * 100).toFixed(1)}%, 템플릿 포함·10진 MB)`
      + ` · WAL ${s.db.walBytes == null ? "미확인" : mb(s.db.walBytes)}`
      + ` · 하루 증가 ${growth == null ? "기록 부족(6시간 이상 쌓여야 낸다)" : `${growth >= 0 ? "+" : ""}${mb(growth)}`}`);
    lines.push(`  큰 표   ${s.db.tables.map((t) => `${t.name} ${mb(t.bytes)}`).join(" · ")}`);
  } else {
    lines.push(`  DB      확인 불가 — ${s.db.error}`);
  }
  const wire = wireSummary(Date.parse(s.at));
  if (wire) lines.push(wire);
  lines.push(s.disk.ok
    ? `  디스크  ${mb(s.disk.usedBytes)} / ${mb(s.disk.sizeBytes)} 사용 (여유 ${mb(s.disk.availBytes)}) — DB·WAL·시스템 합계`
    : `  디스크  미확인 — ${s.disk.error}`);
  for (const r of j.reasons) lines.push(`  · ${r}`);
  return lines.join("\n");
}

let code = 0;
try {
  const s = await readHealth({
    sql: db(),
    token: process.env.SUPABASE_MGMT_TOKEN || undefined,
    ref: process.env.SUPABASE_PROJECT_REF || projectRefFromUrl(process.env.DATABASE_URL),
  });
  // 판정·쓰기 실패 표시는 core 한 곳(decideWithWriteBlock) — 표시가 있으면 보고·기록·관문 모두 멈춤이고,
  // --clear-flag 여도 원인 해소를 확인한 표시만 지운다.
  const j = decideWithWriteBlock(s, readWriteBlock(), limitsFromEnv(), { clear: CLEAR });
  if (j.clearFlag) clearWriteBlock();
  const growth = s.db.ok ? growthPerDay(history(), { at: s.at, totalBytes: s.db.totalBytes }) : null;

  if (RECORD) {
    mkdirSync(OPS, { recursive: true });
    appendFileSync(HISTORY, JSON.stringify({
      at: s.at, verdict: j.verdict,
      totalBytes: s.db.ok ? s.db.totalBytes : null, walBytes: s.db.ok ? s.db.walBytes : null,
      readOnlyDefault: s.db.ok ? s.db.readOnlyDefault : null, managedReadOnly: s.managed.ok ? s.managed.readOnly : null,
      diskUsedBytes: s.disk.ok ? s.disk.usedBytes : null, diskSizeBytes: s.disk.ok ? s.disk.sizeBytes : null,
      growthPerDay: growth, reasons: j.reasons,
    }) + "\n");
    if (j.verdict === "ok") rmSync(ALERT, { force: true });
    else writeFileSync(ALERT, report(s, j, growth) + "\n");
  }

  if (GATE) {
    console.log(`DB 점검 ${LABEL[j.verdict]}${j.reasons.length ? ` — ${j.reasons.join(" ; ")}` : ""}`);
    code = j.verdict === "block" ? 3 : 0;
  } else {
    console.log(report(s, j, growth));
    // 정기 타이머가 경고를 놓치지 않게 — 멈춤은 실패로 남긴다(systemd 상태·install.sh --status 에 보인다).
    code = j.verdict === "block" ? 3 : 0;
  }
} catch (e) {
  console.error(`DB 점검 실패 — ${e instanceof Error ? e.message : String(e)}`);
  code = 3;
} finally {
  await closeDb();
}
process.exitCode = code;
