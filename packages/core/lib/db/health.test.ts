import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  growthPerDay, isWriteBlockedError, judgeHealth, limitsFromEnv, projectRefFromUrl, readHealth, type HealthSnapshot,
} from "./health.ts";
import { clearWriteBlock, noteWriteBlocked, readWriteBlock, WRITE_BLOCK_FLAG } from "./write-block.ts";

const limits = limitsFromEnv({});
const snap = (over: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
  at: "2026-10-12T04:00:00.000Z",
  db: { ok: true, readOnlyDefault: false, readOnlySource: "configuration file", totalBytes: 300_000_000, walBytes: 100_000_000, tables: [] },
  managed: { ok: true, readOnly: false, overrideEnabled: false },
  disk: { ok: true, sizeBytes: 1_000_000_000, usedBytes: 500_000_000, availBytes: 500_000_000 },
  ...over,
});

test("한도는 10진 MB — Free 500MB 기본", () => {
  assert.equal(limits.quotaBytes, 500_000_000);
  assert.equal(limitsFromEnv({ DB_QUOTA_MB: "8000" }).quotaBytes, 8_000_000_000);
  assert.equal(limitsFromEnv({ DB_QUOTA_MB: "abc" }).quotaBytes, 500_000_000);
});

test("모두 확인되고 여유 있으면 정상", () => {
  assert.deepEqual(judgeHealth(snap(), limits), { verdict: "ok", reasons: [] });
});

test("DB 를 못 읽으면 멈춤 — 확인 못 한 것을 정상으로 치지 않는다", () => {
  const j = judgeHealth(snap({ db: { ok: false, error: "connect timeout" } }), limits);
  assert.equal(j.verdict, "block");
  assert.match(j.reasons[0], /DB 확인 불가\(connect timeout\)/);
});

test("기본 읽기 전용 on 이면 출처와 함께 멈춤 — 출처로 주체를 단정하지 않는다", () => {
  const j = judgeHealth(snap({ db: { ...snap().db, readOnlyDefault: true } as HealthSnapshot["db"] }), limits);
  assert.equal(j.verdict, "block");
  assert.equal(j.reasons[0], "기본 읽기 전용 on (출처: configuration file)");
  assert.ok(!j.reasons.some((r) => /Supabase 관리 상태: 읽기 전용/.test(r)));
});

test("관리 상태가 읽기 전용이면 멈춤, 임시 해제 중이면 아니다", () => {
  assert.equal(judgeHealth(snap({ managed: { ok: true, readOnly: true, overrideEnabled: false } }), limits).verdict, "block");
  assert.equal(judgeHealth(snap({ managed: { ok: true, readOnly: true, overrideEnabled: true } }), limits).verdict, "ok");
});

test("크기 — 80% 경고, 95% 멈춤 (2026-10-12 실측 529.85MB 는 멈춤)", () => {
  const at = (bytes: number) => judgeHealth(snap({ db: { ...snap().db, totalBytes: bytes } as HealthSnapshot["db"] }), limits);
  assert.equal(at(399_000_000).verdict, "ok");
  assert.equal(at(400_000_000).verdict, "warn");
  assert.equal(at(474_999_999).verdict, "warn");
  assert.equal(at(475_000_000).verdict, "block");
  const j = at(529_854_641);
  assert.equal(j.verdict, "block");
  assert.match(j.reasons[0], /DB 529\.9MB \/ 한도 500\.0MB \(106\.0%\)/);
});

test("관리 상태·물리 디스크를 못 보면 경고로 남기고 막지는 않는다", () => {
  const j = judgeHealth(snap({
    managed: { ok: false, error: "SUPABASE_MGMT_TOKEN 없음" },
    disk: { ok: false, error: "관리 API → HTTP 500" },
  }), limits);
  assert.equal(j.verdict, "warn");
  assert.deepEqual(j.reasons, [
    "Supabase 관리 잠금 상태 미확인(SUPABASE_MGMT_TOKEN 없음)",
    "물리 디스크 미확인(관리 API → HTTP 500)",
  ]);
});

test("물리 디스크 — 80% 경고, 90% 멈춤, 크기 0 은 미확인", () => {
  const at = (used: number, size = 1_000_000_000) =>
    judgeHealth(snap({ disk: { ok: true, sizeBytes: size, usedBytes: used, availBytes: size - used } }), limits);
  assert.equal(at(799_000_000).verdict, "ok");
  assert.equal(at(800_000_000).verdict, "warn");
  assert.equal(at(900_000_000).verdict, "block");
  const zero = at(0, 0);
  assert.equal(zero.verdict, "warn");
  assert.match(zero.reasons[0], /미확인/);
});

test("쓰기가 막힌 오류만 골라낸다", () => {
  assert.ok(isWriteBlockedError({ code: "25006", message: "cannot execute INSERT in a read-only transaction" }));
  assert.ok(isWriteBlockedError({ code: "53100", message: "could not extend file" }));
  assert.ok(isWriteBlockedError(new Error("could not write to file: No space left on device")));
  assert.ok(!isWriteBlockedError({ code: "23505", message: "duplicate key value violates unique constraint" }));
  assert.ok(!isWriteBlockedError(new Error("connect ETIMEDOUT")));
  assert.ok(!isWriteBlockedError(null));
});

test("DATABASE_URL 에서 프로젝트 ref", () => {
  assert.equal(projectRefFromUrl("postgresql://postgres.oivysevfuxblvlqhcjwh:pw@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres"), "oivysevfuxblvlqhcjwh");
  assert.equal(projectRefFromUrl("postgresql://postgres:pw@db.oivysevfuxblvlqhcjwh.supabase.co:5432/postgres"), "oivysevfuxblvlqhcjwh");
  assert.equal(projectRefFromUrl("postgresql://postgres:pw@localhost:5432/postgres"), null);
  assert.equal(projectRefFromUrl(undefined), null);
});

test("하루 증가량 — 6시간 이상 떨어진 기록이 있어야 낸다", () => {
  const now = { at: "2026-10-13T04:00:00.000Z", totalBytes: 460_000_000 };
  assert.equal(growthPerDay([{ at: "2026-10-13T01:00:00.000Z", totalBytes: 459_000_000 }], now), null);
  assert.equal(growthPerDay([
    { at: "2026-10-12T04:00:00.000Z", totalBytes: 455_000_000 },
    { at: "2026-10-12T16:00:00.000Z", totalBytes: 457_000_000 },
    { at: "2026-10-13T00:00:00.000Z", totalBytes: null },
  ], now), 5_000_000);
});

test("관리 API 실패·토큰 없음은 미확인으로, DB 실패는 DB 미확인으로 돌려준다", async () => {
  const failingSql = { begin: async () => { throw new Error("connection refused"); } } as never;
  const noToken = await readHealth({ sql: failingSql, ref: "oivysevfuxblvlqhcjwh" });
  assert.deepEqual(noToken.db, { ok: false, error: "connection refused" });
  assert.deepEqual(noToken.managed, { ok: false, error: "SUPABASE_MGMT_TOKEN 없음" });

  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(String(url));
    if (String(url).endsWith("/readonly")) return new Response("{}", { status: 401 });
    return Response.json({ timestamp: "x", metrics: { fs_size_bytes: 1e9, fs_used_bytes: 6e8, fs_avail_bytes: 4e8 } });
  }) as typeof fetch;
  const s = await readHealth({ sql: failingSql, token: "t", ref: "oivysevfuxblvlqhcjwh", fetch: fakeFetch });
  assert.deepEqual(s.managed, { ok: false, error: "관리 API /projects/oivysevfuxblvlqhcjwh/readonly → HTTP 401" });
  assert.deepEqual(s.disk, { ok: true, sizeBytes: 1e9, usedBytes: 6e8, availBytes: 4e8 });
  assert.equal(calls.length, 2);
});

test("쓰기 실패 표시 — 막힌 오류만 남기고, 읽고, 지운다", () => {
  const file = join(mkdtempSync(join(tmpdir(), "wb-")), "out/ops/write-blocked.json");
  assert.equal(noteWriteBlocked(new Error("duplicate key"), "test", file), false);
  assert.equal(readWriteBlock(file), null);
  assert.equal(noteWriteBlocked({ code: "25006", message: "cannot execute UPDATE in a read-only transaction" }, "ck-merge", file), true);
  const mark = readWriteBlock(file);
  assert.equal(mark?.source, "ck-merge");
  assert.equal(mark?.code, "25006");
  clearWriteBlock(file);
  assert.equal(readWriteBlock(file), null);
});

test("세션 감싸개(ck-image-budget)와 core 가 같은 쓰기 실패 표시 파일을 본다", () => {
  const src = readFileSync(fileURLToPath(new URL("../../../../scripts/ck-image-budget.ts", import.meta.url)), "utf8");
  const rel = src.match(/WRITE_BLOCK_FLAG=fileURLToPath\(new URL\('([^']+)'/)?.[1];
  assert.ok(rel, "ck-image-budget.ts 에 WRITE_BLOCK_FLAG 정의가 없다");
  const scriptsDir = fileURLToPath(new URL("../../../../scripts/", import.meta.url));
  assert.equal(resolve(scriptsDir, rel), WRITE_BLOCK_FLAG);
});

// ── 쓰기 실패 표시 판정 (2026-10-12 검토에서 재현된 두 경로) ─────────────────
import { decideWithWriteBlock, writeBlockKind, writeBlockResolved, type WriteBlock } from "./write-block.ts";

const diskFlag: WriteBlock = { at: "2026-10-12T01:00:00Z", source: "ck:merge", code: "53100", message: "could not extend file: No space left on device" };
const roFlag: WriteBlock = { at: "2026-10-12T01:00:00Z", source: "worker engine_e_fco", code: "25006", message: "cannot execute INSERT in a read-only transaction" };
const brokenFlag: WriteBlock = { at: "?", source: "?", code: null, message: "표시 파일을 읽지 못했다" };
const diskUnknown = snap({ disk: { ok: false, error: "SUPABASE_MGMT_TOKEN 없음" } });

test("표시가 가리키는 원인", () => {
  assert.equal(writeBlockKind(diskFlag), "disk");
  assert.equal(writeBlockKind(roFlag), "read_only");
  assert.equal(writeBlockKind(brokenFlag), "unknown");
});

test("★ 디스크 부족 표시는 물리 디스크를 못 보면 --clear-flag 여도 지우지 않고 멈춘다", () => {
  const d = decideWithWriteBlock(diskUnknown, diskFlag, limits, { clear: true });
  assert.equal(d.clearFlag, false);
  assert.equal(d.verdict, "block");
  assert.match(d.reasons[0], /지우지 않는다: 디스크 부족 기록인데 물리 디스크 미확인/);
});

test("디스크 부족 표시는 물리 디스크가 중단선 아래로 확인될 때만 지운다", () => {
  assert.equal(writeBlockResolved(diskFlag, snap({ disk: { ok: true, sizeBytes: 1e9, usedBytes: 9.5e8, availBytes: 5e7 } }), limits).ok, false);
  const d = decideWithWriteBlock(snap(), diskFlag, limits, { clear: true });
  assert.equal(d.clearFlag, true);
  assert.equal(d.verdict, "ok");
});

test("읽기 전용 표시 — 기본 읽기 전용 off 면 해소, on 이거나 관리 상태가 읽기 전용이면 아니다", () => {
  assert.equal(writeBlockResolved(roFlag, diskUnknown, limits).ok, true);
  assert.equal(writeBlockResolved(roFlag, snap({ db: { ...snap().db, readOnlyDefault: true } as HealthSnapshot["db"] }), limits).ok, false);
  assert.equal(writeBlockResolved(roFlag, snap({ managed: { ok: true, readOnly: true, overrideEnabled: false } }), limits).ok, false);
  assert.equal(writeBlockResolved(roFlag, snap({ db: { ok: false, error: "x" } }), limits).ok, false);
});

test("원인을 모르는 표시는 자동으로 지우지 않는다", () => {
  const d = decideWithWriteBlock(snap(), brokenFlag, limits, { clear: true });
  assert.deepEqual([d.verdict, d.clearFlag], ["block", false]);
});

test("★ 표시가 있으면 정기 기록·보고(--clear-flag 없음)도 멈춤이다 — 다른 지표가 정상이어도", () => {
  const d = decideWithWriteBlock(snap(), roFlag, limits, { clear: false });
  assert.equal(judgeHealth(snap(), limits).verdict, "ok");
  assert.deepEqual([d.verdict, d.clearFlag], ["block", false]);
  assert.match(d.reasons[0], /쓰기 실패 기록 .* worker engine_e_fco: 25006/);
  assert.deepEqual(decideWithWriteBlock(snap(), null, limits, { clear: true }), { verdict: "ok", reasons: [], clearFlag: false });
});

test("관리 API 결과는 요청한 시간 안에서만 다시 쓴다(성공한 것만)", async () => {
  const okSql = { begin: async () => ({ ok: true, readOnlyDefault: false, readOnlySource: "configuration file", totalBytes: 1, walBytes: null, tables: [] }) } as never;
  let calls = 0;
  const fakeFetch = (async (url: string) => {
    calls++;
    return String(url).endsWith("/readonly") ? Response.json({ enabled: false, override_enabled: false })
      : Response.json({ metrics: { fs_size_bytes: 1e9, fs_used_bytes: 1e8, fs_avail_bytes: 9e8 } });
  }) as typeof fetch;
  const ref = "cachetestcachetest01";
  await readHealth({ sql: okSql, token: "t", ref, fetch: fakeFetch, mgmtCacheMs: 60_000 });
  await readHealth({ sql: okSql, token: "t", ref, fetch: fakeFetch, mgmtCacheMs: 60_000 });
  assert.equal(calls, 2, "두 번째는 1분 안이라 다시 부르지 않는다");
  await readHealth({ sql: okSql, token: "t", ref, fetch: fakeFetch });
  assert.equal(calls, 4, "캐시를 요청하지 않으면 매번 부른다");
});
