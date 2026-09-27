/**
 * verify:modules 를 **검사한다.** 통과가 "경계가 지켜진다" 는 뜻이 되려면 두 가지가 필요하다.
 *
 *   1. 일부러 넣은 위반을 전부 잡는다 — 예전 검사는 상대경로·동적 import·남의 스키마 쓰기를
 *      넣어도 통과했다. 통과가 아무 뜻이 없었다.
 *   2. 모듈을 지워도 통과하고 **컴파일된다**(5조) — 예전 검사는 versus 파일 경로를 박아 둬서,
 *      versus 를 지우면 검사 자체가 ENOENT 로 죽었다.
 *
 *   npm run verify:modules   (경계 검사 뒤에 이어서 돈다)
 *
 * 저장소를 건드리지 않도록 임시 복사본에서 돌린다.
 * ★ 이 테스트도 실제 모듈 이름을 모른다. 위반은 복사본에 만든 가짜 모듈(probea·probeb)에 넣고,
 *   제거 시나리오는 있는 모듈을 세어서 만든다 — 모듈을 지웠다고 이 파일을 고치면 5조 위반이다.
 * ★ node_modules 를 통째로 링크하면 @soop-lol/* 워크스페이스 링크가 **원본 저장소**를 가리켜,
 *   모듈을 지운 복사본이 아니라 원본을 typecheck 하게 된다. @soop-lol/* 만 복사본으로 다시 잇고,
 *   컴파일에 쓰인 파일이 전부 복사본 안인지 확인한다.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";

const REPO = join(import.meta.dirname, "..");
const TREES = ["packages/core", "packages/modules", "packages/ui", "apps/web", "apps/worker", "db/migrations"];
const SKIP = new Set(["node_modules", "public", "tsconfig.tsbuildinfo"]);

/** .next 는 빌드 산출물이지만 next-env.d.ts 가 생성 타입을 import 한다 — 타입 디렉터리만 가져간다. */
function keep(src: string): boolean {
  if (SKIP.has(basename(src))) return false;
  const at = src.indexOf(`${sep}.next`);
  if (at < 0) return true;
  const rest = src.slice(at + 1).split(sep);
  return rest.length === 1 || rest[1] === "types"
    || (rest[1] === "dev" && (rest.length === 2 || rest[2] === "types"));
}

const write = (root: string, rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

/**
 * 규칙을 지키는 가짜 모듈. 위반은 여기에 새 파일로 넣는다.
 * ★ 정상 SQL 의 흔한 형태를 일부러 담는다 — 검사가 이걸 막으면 과잉 차단이다.
 */
function addProbeModule(root: string, name: string) {
  const dir = `packages/modules/${name}`;
  const s = `mod_${name}`;
  write(root, `${dir}/module.json`, JSON.stringify({ name, version: "0.0.0", title: name, schema: s }));
  write(root, `${dir}/server/index.ts`, [
    `import { moduleDb } from "@soop-lol/core/lib/contract";`,
    `export async function recompute(id: number) {`,
    `  const sql = moduleDb("${s}");`,
    "  await sql`DELETE FROM " + s + ".t`;",
    "  await sql`INSERT INTO " + s + ".t (id) VALUES (${id}) ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id`;",
    "  await sql`SELECT id FROM " + s + ".t WHERE id = ${id} FOR UPDATE`;",
    "  await sql`UPDATE " + s + ".t SET id = x.id FROM " + s + ".t x WHERE x.id = ${id}`;",
    "  await sql`WITH best AS (SELECT id FROM " + s + ".t) SELECT b.id, extract(year FROM now()) AS y",
    "             FROM best b, core_public.streamer p",
    "             CROSS JOIN LATERAL jsonb_each('{}'::jsonb) AS e",
    "             WHERE p.slug IS DISTINCT FROM 'match'`;",
    "  return (await sql`SELECT count(*) FROM ONLY " + s + ".t`).length;",
    `}`,
  ].join("\n"));
  write(root, `${dir}/migrations/001_init.sql`,
    `CREATE SCHEMA IF NOT EXISTS mod_${name};\nCREATE TABLE mod_${name}.t (id int);\n`);
}

function sandbox(opts: { probes?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "verify-modules-"));
  for (const tree of TREES) cpSync(join(REPO, tree), join(root, tree), { recursive: true, filter: keep });
  mkdirSync(join(root, "scripts"));
  for (const f of ["verify-modules.ts", "sync-modules.ts"]) cpSync(join(REPO, "scripts", f), join(root, "scripts", f));
  for (const f of readdirSync(REPO).filter((f) => /^tsconfig.*\.json$|^package\.json$/.test(f))) {
    cpSync(join(REPO, f), join(root, f));
  }
  if (opts.probes) { addProbeModule(root, "probea"); addProbeModule(root, "probeb"); }

  mkdirSync(join(root, "node_modules", "@soop-lol"), { recursive: true });
  for (const entry of readdirSync(join(REPO, "node_modules"))) {
    if (entry !== "@soop-lol") symlinkSync(join(REPO, "node_modules", entry), join(root, "node_modules", entry));
  }
  const workspaces: Record<string, string> = {
    core: "packages/core", modules: "packages/modules", web: "apps/web", worker: "apps/worker",
  };
  for (const d of readdirSync(join(root, "packages", "modules"), { withFileTypes: true })) {
    if (d.isDirectory()) workspaces[`module-${d.name}`] = `packages/modules/${d.name}`;
  }
  for (const [name, path] of Object.entries(workspaces)) {
    symlinkSync(join(root, path), join(root, "node_modules", "@soop-lol", name));
  }
  return root;
}

const exec = promisify(execFile);
async function run(root: string, args: string[]): Promise<{ status: number; out: string }> {
  try {
    const r = await exec(process.execPath, args, { cwd: root, maxBuffer: 1 << 26 });
    return { status: 0, out: `${r.stdout}\n${r.stderr}` };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { status: typeof err.code === "number" ? err.code : 1, out: `${err.stdout}\n${err.stderr}` };
  }
}
const verify = (root: string) => run(root, ["scripts/verify-modules.ts"]);

async function withSandbox(opts: { probes?: boolean }, fn: (root: string) => Promise<void>) {
  const root = sandbox(opts);
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 일부러 넣은 위반 ────────────────────────────────────────────────────
// 모두 **새 파일**로 넣는다. 기존 파일에 덧붙이면 그 파일 이름이 바뀔 때 테스트가 따라 깨진다.

interface Violation { name: string; file: string; code: string; expect: RegExp }
const A = "packages/modules/probea/server/__probe.ts";
const VIOLATIONS: Violation[] = [
  { name: "모듈이 상대경로로 core 내부를 import", file: A,
    code: `import "../../../core/lib/db/public.ts";`, expect: /core 내부 직접 접근 금지/ },
  { name: "모듈이 패키지 경로로 core 내부를 import", file: A,
    code: `import { db } from "@soop-lol/core/lib/db/client";\nvoid db;`, expect: /core 내부 직접 접근 금지/ },
  { name: "모듈이 core 내부를 재수출", file: A,
    code: `export { db as leak } from "@soop-lol/core/lib/db/client";`, expect: /재수출.*core 내부/ },
  { name: "모듈이 동적 import() 로 core 내부에 접근", file: A,
    code: `export const lazy = () => import("@soop-lol/core/lib/db/public");`, expect: /동적 import\(\).*core 내부/ },
  { name: "모듈이 타입 import() 로 core 내부에 기댄다", file: A,
    code: `export type Leak = import("@soop-lol/core/lib/db/types").StreamerCard;`, expect: /타입 import\(\).*core 내부/ },
  { name: "모듈이 계산한 경로로 동적 import", file: A,
    code: `export const anyPath = (p: string) => import(p);`, expect: /문자열 상수다/ },
  { name: "모듈이 다른 모듈을 상대경로로 import", file: A,
    code: `import "../../probeb/server/index.ts";`, expect: /다른 모듈\(probeb\)/ },
  { name: "모듈이 다른 모듈을 패키지 이름으로 import", file: A,
    code: `import "@soop-lol/module-probeb/server/index.ts";`, expect: /다른 모듈\(probeb\)/ },
  { name: "모듈이 등록부를 import", file: A,
    code: `import "@soop-lol/modules/registry";`, expect: /등록부는 host 의 것/ },
  { name: "모듈이 웹 내부를 import", file: A,
    code: `import "../../../../apps/web/lib/module-links.ts";`, expect: /웹 내부/ },
  { name: "모듈이 남의 모듈 스키마에 쓴다", file: A,
    code: "export const q = `INSERT INTO mod_probeb.t (id) VALUES (1)`;", expect: /쓰기 mod_probeb\.t/ },
  { name: "모듈이 core 테이블에 쓴다(스키마 생략)", file: A,
    code: "export const q = `UPDATE streamer SET slug = 'x'`;", expect: /UPDATE streamer/ },
  { name: "모듈이 끼워 넣은 이름에 쓴다", file: A,
    code: "const t = 'streamer';\nexport const q = `DELETE FROM ${t} WHERE true`;", expect: /끼워 넣으면/ },
  { name: "모듈이 core 원본 테이블을 읽는다", file: A,
    code: "export const q = `SELECT slug FROM public.streamer`;", expect: /읽기 public\.streamer/ },
  { name: "모듈이 core 원본 테이블을 스키마 없이 읽는다", file: A,
    code: "export const q = `SELECT m.match_id FROM match m JOIN mod_probea.t s ON true`;", expect: /읽기 match/ },
  { name: "모듈 마이그레이션이 core 테이블을 고친다", file: "packages/modules/probea/migrations/002_leak.sql",
    code: `ALTER TABLE streamer ADD COLUMN leaked int;`, expect: /쓰기 streamer/ },
  { name: "모듈 마이그레이션이 남의 스키마를 만든다", file: "packages/modules/probea/migrations/002_leak.sql",
    code: `CREATE SCHEMA IF NOT EXISTS mod_probeb;`, expect: /CREATE SCHEMA mod_probeb/ },
  { name: "공용 UI 가 core 내부를 import", file: "packages/ui/__probe.ts",
    code: `import "@soop-lol/core/lib/db/public";`, expect: /모듈이 쓰는 화면이다/ },
  { name: "웹이 특정 모듈을 상대경로로 import", file: "apps/web/lib/__probe.ts",
    code: `import "../../../packages/modules/probea/server/index.ts";`, expect: /특정 모듈\(probea\)/ },
  { name: "웹이 모듈 패키지를 직접 import", file: "apps/web/lib/__probe.ts",
    code: `import "@soop-lol/module-probeb/server/index.ts";`, expect: /특정 모듈\(probeb\)/ },
  { name: "워커가 특정 모듈을 import", file: "apps/worker/src/__probe.ts",
    code: `import "../../../packages/modules/probea/server/index.ts";`, expect: /특정 모듈\(probea\)/ },
  { name: "core 가 특정 모듈을 동적 import", file: "packages/core/lib/__probe.ts",
    code: `export const m = () => import("../../modules/probea/server/index.ts");`, expect: /특정 모듈\(probea\)/ },

  // ── 1층(문법 자리)이 모르던 형태 — 2층(이름)이나 넓힌 1층이 잡아야 한다 ──
  { name: "다른 모듈 스키마를 DROP SCHEMA", file: A,
    code: "export const q = `DROP SCHEMA mod_probeb CASCADE`;", expect: /DROP SCHEMA mod_probeb/ },
  { name: "core 스키마를 DROP SCHEMA", file: A,
    code: "export const q = `DROP SCHEMA IF EXISTS public CASCADE`;", expect: /DROP SCHEMA public/ },
  { name: "여러 스키마를 한 번에 DROP SCHEMA", file: A,
    code: "export const q = `DROP SCHEMA mod_probea, core_public`;", expect: /DROP SCHEMA core_public/ },
  { name: "FROM ONLY 로 원본 테이블 읽기", file: A,
    code: "export const q = `SELECT id FROM ONLY public.streamer_account`;", expect: /public\.streamer_account/ },
  { name: "콤마 조인 두 번째 자리에서 원본 읽기(한정)", file: A,
    code: "export const q = `SELECT a.slug FROM core_public.streamer a, public.streamer_account b WHERE true`;",
    expect: /public\.streamer_account/ },
  { name: "콤마 조인 두 번째 자리에서 원본 읽기(스키마 생략)", file: A,
    code: "export const q = `SELECT a.slug FROM core_public.streamer a, streamer_account b WHERE true`;",
    expect: /이름 streamer_account/ },
  { name: "서브쿼리 안에서 원본 읽기", file: A,
    code: "export const q = `SELECT id FROM mod_probea.t WHERE EXISTS (SELECT 1 FROM riot_account r WHERE r.puuid = 'x')`;",
    expect: /riot_account/ },
  { name: "따옴표로 감싼 원본 이름", file: A,
    code: "export const q = `SELECT 1 FROM \"public\".\"streamer\"`;", expect: /public\.streamer/ },
  { name: "GRANT ON SCHEMA 로 core 스키마를 다룬다", file: A,
    code: "export const q = `GRANT USAGE ON SCHEMA public TO anon`;", expect: /ON SCHEMA public/ },
  { name: "search_path 를 바꾼다", file: A,
    code: "export const q = `SET search_path = public, mod_probea`;", expect: /search_path/ },
  { name: "core 테이블과 같은 이름의 CTE", file: A,
    code: "export const q = `WITH streamer AS (SELECT 1 AS id) SELECT id FROM streamer`;", expect: /같은 이름의 CTE/ },
  { name: "모듈 마이그레이션이 core 테이블을 FK 로 참조", file: "packages/modules/probea/migrations/002_leak.sql",
    code: `CREATE TABLE mod_probea.u (s uuid REFERENCES streamer(id));`, expect: /이름 streamer/ },

  // ── 공용 UI 는 표시만 한다 — import 규칙을 지키며 DB 에 닿는 길 ──
  { name: "공용 UI 가 계약의 moduleDb 로 SQL 을 친다", file: "packages/ui/__probe.ts",
    code: "import { moduleDb } from \"@soop-lol/core/lib/contract\";\nexport const q = () => moduleDb(\"mod_x\")`SELECT slug FROM public.streamer`;",
    expect: /DB 연결\(moduleDb\)/ },
  { name: "공용 UI 가 네임스페이스 import 로 moduleDb 를 쓴다", file: "packages/ui/__probe.ts",
    code: "import * as c from \"@soop-lol/core/lib/contract\";\nexport const f = () => c.moduleDb(\"mod_x\");",
    expect: /DB 연결\(moduleDb\)/ },
  { name: "공용 UI 에 SQL 문자열", file: "packages/ui/__probe.ts",
    code: "export const q = \"SELECT slug FROM core_public.streamer\";", expect: /SQL 을 쓴다/ },
  { name: "공용 UI 가 DB 드라이버를 import", file: "packages/ui/__probe.ts",
    code: "import postgres from \"postgres\";\nexport const p = postgres;", expect: /DB 드라이버/ },
];

const MODULE_NAMES = readdirSync(join(REPO, "packages", "modules"), { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name !== "node_modules").map((d) => d.name);
const REMOVALS = MODULE_NAMES.length ? [...MODULE_NAMES.map((m) => [m]), ...(MODULE_NAMES.length > 1 ? [MODULE_NAMES] : [])] : [];

const tsc = (root: string, project: string, ...flags: string[]) =>
  run(root, [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", project, "--noEmit", ...flags]);

describe("verify:modules 자체 검증", { concurrency: Math.max(2, availableParallelism() - 1) }, () => {
  test("정상 코드는 통과한다 (가짜 모듈 포함)", () => withSandbox({ probes: true }, async (root) => {
    const r = await verify(root);
    assert.equal(r.status, 0, r.out);
  }));

  for (const v of VIOLATIONS) {
    test(`위반을 잡는다 — ${v.name}`, () => withSandbox({ probes: true }, async (root) => {
      write(root, v.file, `${v.code}\n`);
      const r = await verify(root);
      assert.equal(r.status, 1, `통과해 버렸다:\n${r.out}`);
      assert.match(r.out, v.expect);
    }));
  }

  test("위반을 잡는다 — manifest 가 남의 스키마 이름을 쓴다", () => withSandbox({ probes: true }, async (root) => {
    const path = join(root, "packages/modules/probea/module.json");
    writeFileSync(path, readFileSync(path, "utf8").replace(`"mod_probea"`, `"mod_probeb"`));
    const r = await verify(root);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /schema 가 mod_probea 이다 — mod_probeb/);
  }));

  test("위반을 잡는다 — 기존 파일 끝에 덧붙인 우회도", () => withSandbox({ probes: true }, async (root) => {
    appendFileSync(join(root, "packages/modules/probea/server/index.ts"), `\nexport { db } from "../../../core/lib/db/client.ts";\n`);
    const r = await verify(root);
    assert.equal(r.status, 1, r.out);
  }));

  // ── 모듈을 지워도 core 는 무변경으로 통과하고 컴파일된다 (5조) ──────────
  for (const removed of REMOVALS) {
    test(`모듈 제거 후에도 통과하고 컴파일된다 — ${removed.join("+")}`, () => withSandbox({}, async (root) => {
      for (const m of removed) {
        rmSync(join(root, "packages", "modules", m), { recursive: true });
        rmSync(join(root, "node_modules", "@soop-lol", `module-${m}`), { force: true });
      }
      const sync = await run(root, ["scripts/sync-modules.ts"]);
      assert.equal(sync.status, 0, sync.out);
      const registry = readFileSync(join(root, "packages/modules/registry.generated.ts"), "utf8");
      for (const m of removed) assert.ok(!registry.includes(`./${m}/`), `등록부에 ${m} 가 남았다`);

      const r = await verify(root);
      assert.equal(r.status, 0, r.out);
      // 검사 통과만으로는 core 가 **컴파일되는지** 모른다.
      for (const project of ["apps/web", "apps/worker", "packages/modules"]) {
        const t = await tsc(root, project);
        assert.equal(t.status, 0, `${project} typecheck 실패:\n${t.out}`);
      }
      // 그 컴파일이 정말 복사본을 봤는지 — 원본 저장소 파일이 끼어 있으면 위 결과는 거짓이다.
      const files = await tsc(root, "apps/web", "--listFilesOnly");
      const leaked = files.out.split("\n").filter((f) => f.startsWith(`${REPO}/`) && !f.startsWith(`${REPO}/node_modules/`));
      assert.deepEqual(leaked, [], "원본 저장소 소스가 컴파일에 섞였다");
    }));
  }
});
