/**
 * 마이그레이션 로더 — `db/migrations/*.sql` 이 스키마의 **유일한 출처**다.
 *
 * 예전엔 `db/schema.sql` 하나였는데, 운영 DB 에 데이터가 들어간 순간부터
 * 그 파일을 다시 돌릴 수 없게 됐다. 그때부터 "저장소가 말하는 스키마"와
 * "실제 DB 스키마"가 갈라진다. 전체 스냅샷 파일과 마이그레이션을 **둘 다** 두면
 * 반드시 어긋나므로, 스냅샷은 없애고 마이그레이션만 남긴다.
 *
 * 새 DB = 전부 순서대로 적용. 기존 DB = 아직 안 쓴 것만 적용.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Migration {
  /** 파일명 앞의 4자리. 적용 순서를 정한다. */
  version: string;
  name: string;
  file: string;
  sql: string;
}

export function migrationsDir(root: string): string {
  return join(root, "db", "migrations");
}

export function loadMigrations(root: string): Migration[] {
  const dir = migrationsDir(root);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  const seen = new Set<string>();
  return files.map((file) => {
    const m = /^(\d{4})_(.+)\.sql$/.exec(file);
    if (!m) throw new Error(`마이그레이션 파일명이 규칙에 안 맞는다: ${file} (예: 0004_streamer_channel.sql)`);
    if (seen.has(m[1])) throw new Error(`버전 번호가 중복이다: ${m[1]} (${file})`);
    seen.add(m[1]);
    return { version: m[1], name: m[2], file, sql: readFileSync(join(dir, file), "utf8") };
  });
}

/**
 * 모듈 마이그레이션. **core 다음에** 적용한다 — 모듈은 core 를 읽으니까.
 *
 * 모듈끼리는 순서가 상관없다. 서로를 모르는 게 계약이기 때문이다.
 * 모듈 디렉터리를 지우면 여기서도 저절로 빠진다 (등록부를 따로 관리하지 않는다).
 */
export function loadModuleMigrations(root: string): Migration[] {
  const modulesDir = join(root, "packages", "modules");
  if (!existsSync(modulesDir)) return [];

  const out: Migration[] = [];
  for (const name of readdirSync(modulesDir).sort()) {
    const dir = join(modulesDir, name, "migrations");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      out.push({
        version: `${name}/${file.slice(0, 3)}`,
        name: `${name}:${file}`,
        file: `packages/modules/${name}/migrations/${file}`,
        sql: readFileSync(join(dir, file), "utf8"),
      });
    }
  }
  return out;
}

/** PGlite 등 "빈 DB 에 전부 적용" 용도. 각 마이그레이션을 트랜잭션으로 감싼다. */
export async function applyAll(
  exec: (sql: string) => Promise<unknown>,
  root: string,
  opts: { includeModules?: boolean; log?: (m: Migration) => void } = {},
): Promise<Migration[]> {
  const list = [
    ...loadMigrations(root),
    ...(opts.includeModules ? loadModuleMigrations(root) : []),
  ];
  for (const m of list) {
    opts.log?.(m);
    try {
      await exec(`BEGIN;\n${m.sql}\nCOMMIT;`);
    } catch (e) {
      throw new Error(`마이그레이션 실패: ${m.file}\n  ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return list;
}
