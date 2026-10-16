/**
 * 표 전체를 한 시점 그대로 옮기기 — 운영 복사본 리허설(복사), 전환 전 백업(파일), 백업 복원(파일 → DB).
 * 계획 docs/CLASSIFICATION-REDESIGN-PLAN.md §8 3·4단계.
 *
 * ★ 원본은 COPY TO·SELECT 로 **읽기만** 한다. 트랜잭션으로 묶지 않는다 — postgres.js 는 트랜잭션 안에서 큰 표를 COPY 로
 *   스트리밍하면 멈춘다(2026-10-16 전환 백업이 28분 멈춰 재현·확인). 한 시점의 사진은 **쓰는 쪽을 모두 멈춘 상태**가 보장한다
 *   (전환 도구는 실행 중인 작업이 있으면 시작하지 않는다).
 * ★ 받는 쪽은 적재 동안 트리거·FK 를 끈다(session_replication_role = replica) — 원본의 행을 그대로 옮기는 일이라
 *   검수 무효화 트리거가 돌면 오히려 값이 바뀐다. 받는 쪽 연결은 하나여야 한다(그 설정이 연결 단위다).
 * ★ 생성 칼럼(rank_snapshot.lp_absolute 등)은 옮기지 않는다 — 받는 쪽이 다시 계산한다. 일련번호는 옮긴 뒤 최대값으로 맞춘다.
 */
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzipSync } from "node:zlib";
import type postgres from "postgres";

type Sql = postgres.Sql | postgres.TransactionSql;
export interface TableInfo { schema: string; table: string; columns: string[]; key: string[] }

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
export const qualified = (t: TableInfo) => `${q(t.schema)}.${q(t.table)}`;

/** 옮길 표 — public 과 모듈 스키마(mod_*)의 일반 표. 칼럼은 생성 칼럼을 뺀 순서 그대로, 키는 기본 키(없으면 전 칼럼). */
export async function listTables(sql: Sql): Promise<TableInfo[]> {
  const rows = await sql<{ schema: string; table: string; columns: string[]; key: string[] | null }[]>`
    SELECT n.nspname AS schema, c.relname AS "table",
           array_agg(a.attname::text ORDER BY a.attnum) FILTER (WHERE a.attgenerated = '') AS columns,
           (SELECT array_agg(pa.attname::text ORDER BY array_position(i.indkey, pa.attnum))
              FROM pg_index i JOIN pg_attribute pa ON pa.attrelid = i.indrelid AND pa.attnum = ANY(i.indkey)
             WHERE i.indrelid = c.oid AND i.indisprimary) AS key
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relkind = 'r' AND (n.nspname = 'public' OR n.nspname LIKE 'mod\\_%')
     GROUP BY n.nspname, c.relname, c.oid
     ORDER BY n.nspname, c.relname`;
  return rows.map((r) => ({ schema: r.schema, table: r.table, columns: r.columns, key: r.key ?? r.columns }));
}

const colList = (t: TableInfo) => t.columns.map(q).join(", ");
const BATCH = 2000;

/** 표의 행을 서버가 만든 JSON 글자로 조금씩 — 값 변환(시각·배열·jsonb)을 서버가 하므로 그대로 보존된다. 키 순서로 읽는다. */
async function* rowsOf(src: Sql, t: TableInfo): AsyncGenerator<string[]> {
  const order = t.key.map((c) => `t.${q(c)}`).join(", ");
  const cursor = src.unsafe(`SELECT to_jsonb(r)::text AS j FROM (SELECT ${t.columns.map((c) => `t.${q(c)}`).join(", ")} FROM ${qualified(t)} t ORDER BY ${order}) r`)
    .cursor(BATCH);
  for await (const batch of cursor) yield (batch as unknown as { j: string }[]).map((r) => r.j);
}

async function insertJson(dst: postgres.Sql, t: TableInfo, lines: string[]): Promise<void> {
  if (!lines.length) return;
  await dst.unsafe(`INSERT INTO ${qualified(t)} (${colList(t)}) SELECT ${colList(t)} FROM jsonb_populate_recordset(NULL::${qualified(t)}, $1::text::jsonb)`,
    [`[${lines.join(",")}]`]);
}

// ★ COPY 스트림(postgres.js .readable/.writable)을 쓰지 않는다 — COPY 를 한 번 쓰고 나면 같은 연결의 다음 질의가 멈춘다
//   (2026-10-16 전환 백업이 28분 멈춰 로컬에서 재현). 커서로 받아 JSON 줄로 옮긴다.

/** 원본 → 받는 쪽. 받는 쪽 표가 없으면(원본에만 있는 표) 멈춘다 — 스키마가 갈라졌다는 뜻이다. */
export async function copyAll(src: postgres.Sql, dst: postgres.Sql, log: (s: string) => void = () => {}): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await dst.unsafe("SET session_replication_role = replica");
  const dstTables = new Set((await listTables(dst)).map(qualified));
  for (const t of await listTables(src)) {
    if (!dstTables.has(qualified(t))) throw new Error(`받는 쪽에 표가 없다: ${qualified(t)} — 스키마가 갈라졌다`);
    let n = 0;
    for await (const lines of rowsOf(src, t)) { await insertJson(dst, t, lines); n += lines.length; }
    counts.set(qualified(t), n);
    log(`복사 ${qualified(t)} ${n}행`);
  }
  await dst.unsafe("SET session_replication_role = origin");
  await syncSequences(dst);
  return counts;
}

/** 원본 → 파일(표마다 gzip JSON 줄) + 목록(manifest.json: 표·칼럼·행 수·내용 지문). 쓰는 쪽을 멈춘 상태에서 받는다. */
export async function backupTo(src: postgres.Sql, dir: string, log: (s: string) => void = () => {}): Promise<{ table: string; rows: number; digest: string }[]> {
  mkdirSync(dir, { recursive: true });
  const manifest: { table: string; file: string; columns: string[]; rows: number; digest: string }[] = [];
  for (const t of await listTables(src)) {
    const file = `${t.schema}.${t.table}.jsonl.gz`;
    const gz = createGzip();
    const done = pipeline(gz, createWriteStream(join(dir, file)));
    let n = 0;
    for await (const lines of rowsOf(src, t)) {
      if (!gz.write(lines.join("\n") + "\n")) await new Promise((r) => gz.once("drain", r));
      n += lines.length;
    }
    gz.end();
    await done;
    const { rows, digest } = await tableDigest(src, t);
    if (rows !== n) throw new Error(`${qualified(t)}: 받은 ${n}행 ≠ 표 ${rows}행 — 받는 사이에 누가 썼다`);
    manifest.push({ table: qualified(t), file, columns: t.columns, rows, digest });
    log(`백업 ${qualified(t)} ${rows}행`);
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ at: new Date().toISOString(), format: "jsonl.gz", tables: manifest }, null, 2));
  return manifest.map(({ table, rows, digest }) => ({ table, rows, digest }));
}

/** 파일 → 받는 쪽(같은 스키마 버전이어야 한다). 넣은 뒤 표마다 지문을 다시 재서 목록과 대조한다 — 하나라도 다르면 실패 목록에. */
export async function restoreFrom(dst: postgres.Sql, dir: string, log: (s: string) => void = () => {}): Promise<string[]> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as
    { tables: { table: string; file: string; columns: string[]; rows: number; digest: string }[] };
  const byName = new Map((await listTables(dst)).map((t) => [qualified(t), t]));
  await dst.unsafe("SET session_replication_role = replica");
  for (const m of manifest.tables) {
    const t = byName.get(m.table);
    if (!t) throw new Error(`받는 쪽에 표가 없다: ${m.table}`);
    const text = gunzipSync(readFileSync(join(dir, m.file))).toString("utf8");
    const lines = text.split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i += BATCH) await insertJson(dst, { ...t, columns: m.columns }, lines.slice(i, i + BATCH));
    log(`복원 ${m.table} ${lines.length}행`);
  }
  await dst.unsafe("SET session_replication_role = origin");
  await syncSequences(dst);
  const mismatched: string[] = [];
  for (const m of manifest.tables) {
    const { rows, digest } = await tableDigest(dst, byName.get(m.table)!);
    if (rows !== m.rows || digest !== m.digest) mismatched.push(`${m.table}: ${rows}/${m.rows}행, 지문 ${digest === m.digest ? "같음" : "다름"}`);
  }
  return mismatched;
}

/** 표 내용의 지문 — 키 순서로 늘어놓은 행 글자들의 md5. 같은 내용이면 어느 DB 에서 재도 같다. */
export async function tableDigest(sql: Sql, t: TableInfo): Promise<{ rows: number; digest: string }> {
  const order = t.key.map(q).join(", ");
  const cols = t.columns.map((c) => `t.${q(c)}`).join(", ");
  const [r] = await sql.unsafe(`SELECT count(*)::int AS rows, coalesce(md5(string_agg(ROW(${cols})::text, E'\\n' ORDER BY ${order.split(", ").map((c) => `t.${c}`).join(", ")})), '') AS digest
                                  FROM ${qualified(t)} t`);
  return { rows: r.rows as number, digest: r.digest as string };
}

/** 일련번호 칼럼의 시퀀스를 옮긴 최대값으로 — 다음 INSERT 가 기존 키와 부딪치지 않게. */
async function syncSequences(sql: postgres.Sql): Promise<void> {
  const seqs = await sql<{ tbl: string; col: string; seq: string }[]>`
    SELECT quote_ident(n.nspname) || '.' || quote_ident(c.relname) AS tbl, quote_ident(a.attname) AS col,
           pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) AS seq
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE c.relkind = 'r' AND (n.nspname = 'public' OR n.nspname LIKE 'mod\\_%')
       AND pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname) IS NOT NULL`;
  for (const s of seqs) await sql.unsafe(`SELECT setval('${s.seq}', coalesce((SELECT max(${s.col}) FROM ${s.tbl}), 0) + 1, false)`);
}
