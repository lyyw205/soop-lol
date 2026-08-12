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

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Migration {
  /** 파일명 앞의 4자리. 적용 순서를 정한다. */
  version: string;
  name: string;
  file: string;
  sql: string;
  /** 파일 내용의 지문. **적용된 뒤에 파일이 바뀌었는지**를 이걸로 안다. */
  checksum: string;
}

/**
 * 마이그레이션 파일의 지문.
 *
 * ★ 왜 필요한가 — 실제로 물렸다
 *   이미 적용한 0016 을 고쳤는데 러너가 "적용할 것이 없다" 라고만 했다. 저장소의
 *   SQL 과 DB 의 실제 스키마가 그때부터 갈라졌고, 그 상태로 화면을 띄우면
 *   **저장소만 보고는 절대 알 수 없는 버그**가 된다. (그때 빠진 게 하필
 *   core_public 의 숨김 조인이라 숨긴 스트리머가 새어 나가는 상태였다)
 *
 * ★ 줄바꿈은 normalize 한다
 *   저장소가 공개라 Windows 에서 체크아웃하면 CRLF 가 될 수 있다. 그것 때문에
 *   전원이 '바뀌었다' 로 막히면 검사가 아니라 방해물이 된다. 내용만 본다.
 */
export function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
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
    const sql = readFileSync(join(dir, file), "utf8");
    return { version: m[1], name: m[2], file, sql, checksum: checksumOf(sql) };
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
      const sql = readFileSync(join(dir, file), "utf8");
      out.push({
        version: `${name}/${file.slice(0, 3)}`,
        name: `${name}:${file}`,
        file: `packages/modules/${name}/migrations/${file}`,
        sql,
        checksum: checksumOf(sql),
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
