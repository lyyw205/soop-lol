/**
 * 모듈 경계를 **검사해서** 강제한다.
 *
 *   npm run verify:modules
 *
 * "모듈은 독립적이어야 한다"를 문서에만 적어 두면 반드시 깨진다.
 * 깨진 걸 알아채는 시점이 "모듈 하나 지웠더니 사이트가 죽었을 때"면 이미 늦다.
 * 그래서 import 그래프와 SQL 을 직접 훑어 규칙 위반을 찾는다.
 *
 * 계약 5조 (docs/ARCHITECTURE.md):
 *   1. 모듈은 core/lib/contract 만 import 한다 (core/lib/db 직접 접근 금지)
 *   2. 모듈은 자기 mod_<name> 스키마에만 쓴다 (core 테이블 쓰기 금지)
 *   3. 모듈끼리 import 금지
 *   4. core·apps 는 모듈을 import 하지 않는다 (역방향 의존 금지)
 *   5. 모듈 제거 = 디렉터리 삭제 + DROP SCHEMA mod_<name> CASCADE
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MODULES_DIR = join(ROOT, "packages", "modules");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

const importRe = /(?:from|import)\s+["']([^"']+)["']/g;

interface ModuleInfo {
  name: string;
  dir: string;
  schema: string;
  manifest: Record<string, unknown>;
}

function loadModules(): ModuleInfo[] {
  if (!existsSync(MODULES_DIR)) return [];
  const out: ModuleInfo[] = [];
  for (const name of readdirSync(MODULES_DIR)) {
    const dir = join(MODULES_DIR, name);
    if (!statSync(dir).isDirectory()) continue;
    const manifestPath = join(dir, "module.json");
    if (!existsSync(manifestPath)) {
      check(`${name}: module.json 이 있다`, false, "manifest 없이는 등록도 제거도 추적이 안 된다");
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    out.push({ name, dir, schema: manifest.schema, manifest });
  }
  return out;
}

console.log("\n▸ 모듈 경계 검사");

const modules = loadModules();
if (modules.length === 0) {
  console.log("  (모듈이 아직 없다 — 규칙만 준비된 상태)");
}

for (const m of modules) {
  console.log(`\n  [${m.name}]`);

  check(`manifest 의 schema 가 mod_ 로 시작한다`, /^mod_[a-z0-9_]+$/.test(m.schema ?? ""), String(m.schema));
  check(`manifest 이름이 디렉터리와 같다`, m.manifest.name === m.name, String(m.manifest.name));

  const files = walk(m.dir);
  const otherModules = modules.filter((x) => x.name !== m.name).map((x) => x.name);

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(ROOT.length + 1);

    for (const match of src.matchAll(importRe)) {
      const spec = match[1];

      // 1조 — core 내부 직접 접근 금지
      if (spec.startsWith("@soop-lol/core/") && !spec.startsWith("@soop-lol/core/lib/contract")) {
        check(`${rel}: core 내부(${spec})를 직접 import 하지 않는다`, false,
          "core/lib/contract 만 쓴다. 필요한 게 없으면 contract 에 추가할 것");
      }
      // 3조 — 모듈끼리 금지
      for (const other of otherModules) {
        if (spec.includes(`modules/${other}`)) {
          check(`${rel}: 다른 모듈(${other})을 import 하지 않는다`, false, spec);
        }
      }
      // 워커·웹 내부를 모듈이 끌어다 쓰면 안 된다
      if (spec.includes("apps/worker") || spec.includes("@soop-lol/worker")) {
        check(`${rel}: 워커 내부를 import 하지 않는다`, false, spec);
      }
    }

    // 2조 — core 테이블 쓰기 금지 (SQL 문자열을 훑는다)
    const writeRe = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE|DROP\s+TABLE)\s+(?:"?public"?\.)?"?([a-z_]+)"?/gi;
    for (const w of src.matchAll(writeRe)) {
      const table = w[2].toLowerCase();
      if (!table.startsWith("mod_")) {
        check(`${rel}: core 테이블(${table})에 쓰지 않는다`, false, `${w[1]} ${table}`);
      }
    }
  }

  check(`import 규칙 위반 없음 (${files.length}개 파일)`, true);

  // 5조 — 마이그레이션이 자기 스키마만 만드는지
  const migDir = join(m.dir, "migrations");
  if (existsSync(migDir)) {
    for (const f of readdirSync(migDir).filter((x) => x.endsWith(".sql"))) {
      const sql = readFileSync(join(migDir, f), "utf8");
      const touchesCore = /\b(CREATE|ALTER|DROP)\s+TABLE\s+(?!mod_)(?!IF)/i.test(
        sql.replace(/mod_[a-z0-9_]+\./g, "mod_"),
      );
      check(`migrations/${f} 가 자기 스키마만 건드린다`, !touchesCore,
        touchesCore ? "core 테이블 DDL 이 보인다" : "");
    }
  }
}

// 4조 — core 와 apps 가 모듈을 import 하지 않는지
console.log("\n  [역방향 의존]");
const coreAndApps = [
  ...walk(join(ROOT, "packages", "core")),
  ...walk(join(ROOT, "apps", "worker")),
];
let reverse = 0;
for (const file of coreAndApps) {
  const src = readFileSync(file, "utf8");
  for (const match of src.matchAll(importRe)) {
    if (match[1].includes("packages/modules") || match[1].startsWith("@soop-lol/module-")) {
      check(`${file.slice(ROOT.length + 1)}: 모듈을 import 하지 않는다`, false, match[1]);
      reverse++;
    }
  }
}
check(`core·worker 가 모듈을 import 하지 않는다 (${coreAndApps.length}개 파일)`, reverse === 0);

console.log(failures === 0 ? "\n모듈 경계 이상 없음.\n" : `\n${failures}건 위반.\n`);
process.exit(failures === 0 ? 0 : 1);
