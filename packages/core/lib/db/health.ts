/**
 * 운영 DB 를 지금 써도 되는가 — 대량 쓰기·조사 세션을 시작하기 전과 묶음 사이에 본다.
 *
 * ★ 왜 (2026-10-12) — Free 한도(500MB)를 넘겨 읽기 전용이 걸린 줄 모르고 조사 세션이 저장에 실패했고,
 *   정리 쓰기가 남은 디스크를 다 써서 No space left on device 까지 갔다. 한도에 닿기 **전에** 멈춰야 한다.
 * ★ 잠금은 세 층을 따로 본다 — 섞으면 오판한다.
 *   ① 기본 읽기 전용(default_transaction_read_only)과 그 **출처**(pg_settings.source). 출처는 값이 어디서 왔는지
 *     (설정 파일·세션)일 뿐 누가·왜 걸었는지는 아니다. 그래서 출처를 보고 "Supabase 가 잠갔다"고 쓰지 않는다.
 *   ② Supabase 관리 상태(관리 API /readonly) — 이것만 Supabase 가 잠갔는지 말해 준다.
 *   ③ 지금 트랜잭션의 transaction_read_only 는 보지 않는다 — 점검 질의 자신이 읽기 전용으로 열 수 있어서 늘 on 이 될 수 있다.
 * ★ 확인 못 한 것은 '미확인'이다. 조회 실패를 0 이나 정상으로 바꾸지 않는다(판정 문장에 그대로 남긴다).
 * ★ 크기는 Supabase 가 세는 방식 그대로 — 템플릿을 포함한 **모든 DB 합계**, 10진 MB(1MB = 1,000,000B).
 *   pg_size_pretty 는 MiB 라 "504.7MB" 로 잘못 읽은 적이 있다.
 * ★ DB 크기 + WAL 은 물리 디스크 사용량 전체가 아니다(시스템·임시 파일). 물리 디스크는 관리 API 로만 본다.
 */

import type postgres from "postgres";

const MB = 1_000_000;

/** 관리 API 응답이나 DB 질의 하나의 결과 — 실패하면 이유를 들고 있다. */
export type Probe<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface HealthSnapshot {
  at: string;
  db: Probe<{
    readOnlyDefault: boolean;
    readOnlySource: string;
    totalBytes: number;
    walBytes: number | null;
    tables: { name: string; bytes: number }[];
  }>;
  managed: Probe<{ readOnly: boolean; overrideEnabled: boolean }>;
  disk: Probe<{ sizeBytes: number; usedBytes: number; availBytes: number }>;
}

export interface HealthLimits {
  /** 요금제의 DB 크기 한도 (Free 500MB). */
  quotaBytes: number;
  /** 한도 대비 이 비율이면 경고 */
  warnRatio: number;
  /** 한도 대비 이 비율이면 새 작업을 시작하지 않는다 — 100% 에 닿기 전에 정리 쓰기를 할 여유를 남긴다 */
  blockRatio: number;
  /** 물리 디스크 사용률 경고·중단 — Supabase 는 95% 에서 읽기 전용을 건다 */
  diskWarnRatio: number;
  diskBlockRatio: number;
}

export function limitsFromEnv(env: Record<string, string | undefined> = process.env): HealthLimits {
  const quotaMb = Number(env.DB_QUOTA_MB ?? 500);
  return {
    quotaBytes: (Number.isFinite(quotaMb) && quotaMb > 0 ? quotaMb : 500) * MB,
    warnRatio: 0.8,
    blockRatio: 0.95,
    diskWarnRatio: 0.8,
    diskBlockRatio: 0.9,
  };
}

export type Verdict = "ok" | "warn" | "block";

export interface Judgement {
  verdict: Verdict;
  /** 사람이 읽는 판정 근거 — 멈춘 이유, 경고, 미확인 항목 */
  reasons: string[];
}

export const mb = (bytes: number) => `${(bytes / MB).toFixed(1)}MB`;
const pct = (r: number) => `${(r * 100).toFixed(1)}%`;

/**
 * 새 대량 쓰기·조사 세션을 시작해도 되는가.
 * 멈춤: 기본 읽기 전용 on · 관리 상태 읽기 전용 · DB 크기 ≥ blockRatio · 물리 디스크 ≥ diskBlockRatio · **DB 를 못 읽음**.
 * 물리 디스크·관리 상태를 못 읽은 것은 경고로 남기고 막지 않는다 — DB 쪽 잠금과 크기는 직접 확인했기 때문이다.
 */
export function judgeHealth(s: HealthSnapshot, limits: HealthLimits): Judgement {
  const block: string[] = [], warn: string[] = [];
  if (!s.db.ok) {
    block.push(`DB 확인 불가(${s.db.error}) — 확인 못 한 상태로 시작하지 않는다`);
  } else {
    if (s.db.readOnlyDefault) block.push(`기본 읽기 전용 on (출처: ${s.db.readOnlySource})`);
    const ratio = s.db.totalBytes / limits.quotaBytes;
    const line = `DB ${mb(s.db.totalBytes)} / 한도 ${mb(limits.quotaBytes)} (${pct(ratio)})`;
    if (ratio >= limits.blockRatio) block.push(`${line} ≥ ${pct(limits.blockRatio)}`);
    else if (ratio >= limits.warnRatio) warn.push(`${line} ≥ ${pct(limits.warnRatio)}`);
  }
  if (!s.managed.ok) warn.push(`Supabase 관리 잠금 상태 미확인(${s.managed.error})`);
  else if (s.managed.readOnly && !s.managed.overrideEnabled) block.push("Supabase 관리 상태: 읽기 전용");
  if (!s.disk.ok) warn.push(`물리 디스크 미확인(${s.disk.error})`);
  else {
    const ratio = s.disk.sizeBytes > 0 ? s.disk.usedBytes / s.disk.sizeBytes : NaN;
    const line = `물리 디스크 ${mb(s.disk.usedBytes)} / ${mb(s.disk.sizeBytes)} (${pct(ratio)}, 여유 ${mb(s.disk.availBytes)})`;
    if (!Number.isFinite(ratio)) warn.push(`물리 디스크 값이 이상하다(크기 ${s.disk.sizeBytes}) — 미확인으로 본다`);
    else if (ratio >= limits.diskBlockRatio) block.push(`${line} ≥ ${pct(limits.diskBlockRatio)}`);
    else if (ratio >= limits.diskWarnRatio) warn.push(`${line} ≥ ${pct(limits.diskWarnRatio)}`);
  }
  if (block.length) return { verdict: "block", reasons: [...block, ...warn] };
  if (warn.length) return { verdict: "warn", reasons: warn };
  return { verdict: "ok", reasons: [] };
}

/** 쓰기가 막혀서 난 오류인가 — 읽기 전용(25006)·디스크 부족(53100)과 그 메시지. 다른 오류는 아니다. */
export function isWriteBlockedError(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  const code = typeof err?.code === "string" ? err.code : "";
  const message = typeof err?.message === "string" ? err.message : String(e ?? "");
  return code === "25006" || code === "53100"
    || /read-only transaction|No space left on device|could not extend file/i.test(message);
}

/** DATABASE_URL 에서 Supabase 프로젝트 ref — 풀러는 사용자명 `postgres.<ref>`, 직접 접속은 호스트 `db.<ref>.supabase.co`. */
export function projectRefFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const user = decodeURIComponent(u.username).match(/^[\w-]+\.([a-z0-9]{20})$/);
    if (user) return user[1];
    const host = u.hostname.match(/^db\.([a-z0-9]{20})\.supabase\.co$/);
    return host ? host[1] : null;
  } catch {
    return null;
  }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

async function readDb(sql: postgres.Sql): Promise<HealthSnapshot["db"]> {
  try {
    // 점검이 오래 매달리지 않게 한다 — 꽉 찬 디스크에서는 조회도 멈출 수 있었다.
    return await sql.begin("read only", async (tx) => {
      await tx`SET LOCAL statement_timeout = '15s'`;
      const [r] = await tx<{ ro: string; src: string; total: string }[]>`
        SELECT current_setting('default_transaction_read_only') AS ro,
               (SELECT source FROM pg_settings WHERE name = 'default_transaction_read_only') AS src,
               (SELECT sum(pg_database_size(datname)) FROM pg_database)::bigint::text AS total`;
      // WAL 크기는 권한이 없으면 못 읽는다 — 그때는 null(미확인)이지 0 이 아니다.
      let walBytes: number | null = null;
      try {
        await tx`SAVEPOINT wal`;
        const [w] = await tx<{ wal: string | null }[]>`SELECT sum(size)::bigint::text AS wal FROM pg_ls_waldir()`;
        walBytes = w?.wal == null ? null : Number(w.wal);
      } catch {
        await tx`ROLLBACK TO SAVEPOINT wal`;
      }
      const tables = await tx<{ name: string; bytes: string }[]>`
        SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint::text AS bytes
          FROM pg_class c
         WHERE c.relkind IN ('r', 'm') AND c.relnamespace = 'public'::regnamespace
         ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 8`;
      return {
        ok: true as const,
        readOnlyDefault: r.ro === "on",
        readOnlySource: r.src,
        totalBytes: Number(r.total),
        walBytes,
        tables: tables.map((t) => ({ name: t.name, bytes: Number(t.bytes) })),
      };
    }) as HealthSnapshot["db"];
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

type Fetch = typeof fetch;

async function mgmt(fetchFn: Fetch, token: string, path: string): Promise<Record<string, unknown>> {
  const res = await fetchFn(`https://api.supabase.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`관리 API ${path} → HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function readManaged(fetchFn: Fetch, token: string | undefined, ref: string | null): Promise<HealthSnapshot["managed"]> {
  if (!token) return { ok: false, error: "SUPABASE_MGMT_TOKEN 없음" };
  if (!ref) return { ok: false, error: "프로젝트 ref 를 모름" };
  try {
    const r = await mgmt(fetchFn, token, `/projects/${ref}/readonly`);
    if (typeof r.enabled !== "boolean") throw new Error("응답에 enabled 가 없다");
    return { ok: true, readOnly: r.enabled, overrideEnabled: r.override_enabled === true };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

async function readDisk(fetchFn: Fetch, token: string | undefined, ref: string | null): Promise<HealthSnapshot["disk"]> {
  if (!token) return { ok: false, error: "SUPABASE_MGMT_TOKEN 없음" };
  if (!ref) return { ok: false, error: "프로젝트 ref 를 모름" };
  try {
    const r = await mgmt(fetchFn, token, `/projects/${ref}/config/disk/util`);
    const m = (r.metrics ?? {}) as Record<string, unknown>;
    const size = Number(m.fs_size_bytes), used = Number(m.fs_used_bytes), avail = Number(m.fs_avail_bytes);
    if (![size, used, avail].every(Number.isFinite)) throw new Error("응답에 디스크 수치가 없다");
    return { ok: true, sizeBytes: size, usedBytes: used, availBytes: avail };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

const mgmtCache = new Map<string, { at: number; managed: HealthSnapshot["managed"]; disk: HealthSnapshot["disk"] }>();

export async function readHealth(opts: {
  sql: postgres.Sql;
  token?: string;
  ref?: string | null;
  fetch?: Fetch;
  now?: Date;
  /** 관리 API 결과를 이 시간 안이면 다시 쓴다(성공한 것만). 기본은 매번 부른다. */
  mgmtCacheMs?: number;
}): Promise<HealthSnapshot> {
  const fetchFn = opts.fetch ?? fetch;
  const ref = opts.ref ?? null;
  const key = `${ref}|${opts.token ? "t" : "-"}`;
  const hit = opts.mgmtCacheMs ? mgmtCache.get(key) : undefined;
  const fresh = hit && Date.now() - hit.at < (opts.mgmtCacheMs ?? 0) ? hit : undefined;
  const [db, managed, disk] = await Promise.all([
    readDb(opts.sql),
    fresh ? fresh.managed : readManaged(fetchFn, opts.token, ref),
    fresh ? fresh.disk : readDisk(fetchFn, opts.token, ref),
  ]);
  if (opts.mgmtCacheMs && !fresh && managed.ok && disk.ok) mgmtCache.set(key, { at: Date.now(), managed, disk });
  return { at: (opts.now ?? new Date()).toISOString(), db, managed, disk };
}

/** 기록에서 하루 증가량 — 6시간 이상 떨어진 가장 오래된(최대 24시간 전) 기록과 비교한다. 모르면 null. */
export function growthPerDay(history: { at: string; totalBytes: number | null }[], now: { at: string; totalBytes: number }): number | null {
  const t = Date.parse(now.at);
  const past = history
    .filter((h) => h.totalBytes != null && t - Date.parse(h.at) >= 6 * 3600_000 && t - Date.parse(h.at) <= 30 * 3600_000)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
  if (!past) return null;
  const hours = (t - Date.parse(past.at)) / 3600_000;
  return ((now.totalBytes - (past.totalBytes as number)) / hours) * 24;
}
