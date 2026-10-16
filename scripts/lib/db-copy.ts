/**
 * 표 전체를 한 시점 그대로 옮기기 — 운영 복사본 리허설(복사), 전환 전 백업(파일), 백업 복원(파일 → DB).
 * 계획 docs/CLASSIFICATION-REDESIGN-PLAN.md §8 3·4단계.
 *
 * ★ 원본은 **읽기 전용 · 반복 읽기 트랜잭션 하나**로 읽는다 — 모든 표가 같은 순간의 사진이고, 쓰기는 시도조차 거부된다.
 * ★ 받는 쪽은 적재 동안 트리거·FK 를 끈다(session_replication_role = replica) — 원본의 행을 그대로 옮기는 일이라
 *   검수 무효화 트리거가 돌면 오히려 값이 바뀐다. 받는 쪽 연결은 하나여야 한다(그 설정이 연결 단위다).
 * ★ 생성 칼럼(rank_snapshot.lp_absolute 등)은 옮기지 않는다 — 받는 쪽이 다시 계산한다. 일련번호는 옮긴 뒤 최대값으로 맞춘다.
 */
import { createReadStream, createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
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

/** 원본 → 받는 쪽, 표마다 COPY 스트림. 받는 쪽 표가 없으면(원본에만 있는 표) 멈춘다 — 스키마가 갈라졌다는 뜻이다. */
export async function copyAll(src: postgres.Sql, dst: postgres.Sql, log: (s: string) => void = () => {}): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  await dst.unsafe("SET session_replication_role = replica");
  await src.begin("isolation level repeatable read read only", async (tx) => {
    const tables = await listTables(tx);
    const dstTables = new Set((await listTables(dst)).map(qualified));
    for (const t of tables) {
      if (!dstTables.has(qualified(t))) throw new Error(`받는 쪽에 표가 없다: ${qualified(t)} — 스키마가 갈라졌다`);
      const readable = await tx.unsafe(`COPY ${qualified(t)} (${colList(t)}) TO STDOUT`).readable();
      const writable = await dst.unsafe(`COPY ${qualified(t)} (${colList(t)}) FROM STDIN`).writable();
      await pipeline(readable, writable);
      const [{ n }] = await dst.unsafe(`SELECT count(*)::int AS n FROM ${qualified(t)}`);
      counts.set(qualified(t), n);
      log(`복사 ${qualified(t)} ${n}행`);
    }
  });
  await dst.unsafe("SET session_replication_role = origin");
  await syncSequences(dst);
  return counts;
}

/** 원본 → 파일(표마다 gzip COPY) + 목록(manifest.json: 표·칼럼·행 수·내용 지문). 한 시점의 사진이다. */
export async function backupTo(src: postgres.Sql, dir: string, log: (s: string) => void = () => {}): Promise<{ table: string; rows: number; digest: string }[]> {
  mkdirSync(dir, { recursive: true });
  const manifest: { table: string; file: string; columns: string[]; rows: number; digest: string }[] = [];
  await src.begin("isolation level repeatable read read only", async (tx) => {
    for (const t of await listTables(tx)) {
      const file = `${t.schema}.${t.table}.copy.gz`;
      const readable = await tx.unsafe(`COPY ${qualified(t)} (${colList(t)}) TO STDOUT`).readable();
      await pipeline(readable, createGzip(), createWriteStream(join(dir, file)));
      const { rows, digest } = await tableDigest(tx, t);
      manifest.push({ table: qualified(t), file, columns: t.columns, rows, digest });
      log(`백업 ${qualified(t)} ${rows}행`);
    }
  });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ at: new Date().toISOString(), tables: manifest }, null, 2));
  return manifest.map(({ table, rows, digest }) => ({ table, rows, digest }));
}

/** 파일 → 받는 쪽(같은 스키마 버전이어야 한다). 넣은 뒤 표마다 지문을 다시 재서 목록과 대조한다 — 하나라도 다르면 실패. */
export async function restoreFrom(dst: postgres.Sql, dir: string, log: (s: string) => void = () => {}): Promise<string[]> {
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as
    { tables: { table: string; file: string; columns: string[]; rows: number; digest: string }[] };
  const byName = new Map((await listTables(dst)).map((t) => [qualified(t), t]));
  await dst.unsafe("SET session_replication_role = replica");
  for (const m of manifest.tables) {
    const t = byName.get(m.table);
    if (!t) throw new Error(`받는 쪽에 표가 없다: ${m.table}`);
    const writable = await dst.unsafe(`COPY ${m.table} (${m.columns.map(q).join(", ")}) FROM STDIN`).writable();
    await pipeline(createReadStream(join(dir, m.file)), createGunzip(), writable);
    log(`복원 ${m.table}`);
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
