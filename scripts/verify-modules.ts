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
 *
 * ★ import 는 정규식이 아니라 **TypeScript 구문 트리**로 읽고 경로를 해석한다.
 *   문자열 접두사만 보던 시절엔 상대경로(`../../../core/lib/db`)·동적 `import()`·
 *   재수출·`packages/ui` 를 거친 우회가 전부 통과했다.
 * ★ 모듈을 지웠더니 이 검사가 ENOENT 로 죽은 적이 있다 — 5조를 검사가 스스로 깨고 있었다.
 *   아래 공유 표시 규칙 목록에는 versus 화면 경로가 아직 있지만, 그 모듈이 없으면 건너뛴다.
 *   제거 후에도 통과·컴파일되는지는 scripts/verify-modules.selftest.ts 가 임시 복사본에서
 *   모듈을 지워 가며 확인한다.
 */

import ts from "typescript";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MODULES_DIR = join(ROOT, "packages", "modules");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const toRel = (abs: string) => relative(ROOT, abs).split(sep).join("/");

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.test(e)) out.push(p);
  }
  return out;
}
const sourcesIn = (...parts: string[]) => walk(join(ROOT, ...parts), /\.(ts|tsx|mts)$/).map(toRel);

// ── import 해석 ─────────────────────────────────────────────────────────

type Zone =
  | { kind: "external" } | { kind: "contract" } | { kind: "core" } | { kind: "registry" }
  | { kind: "module"; name: string } | { kind: "ui" } | { kind: "web" } | { kind: "worker" }
  | { kind: "other"; path: string };

/** 저장소 기준 경로. 저장소 밖(npm 패키지·node:)이면 null. */
function resolveSpec(fromRel: string, spec: string): string | null {
  if (spec.startsWith("./") || spec.startsWith("../")) return toRel(resolve(ROOT, dirname(fromRel), spec));
  if (spec.startsWith("@/")) return fromRel.startsWith("apps/web/") ? `apps/web/${spec.slice(2)}` : null;
  const workspace: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^@soop-lol\/core(\/.*)?$/, (m) => `packages/core${m[1] ?? ""}`],
    [/^@soop-lol\/modules(\/.*)?$/, (m) => `packages/modules${m[1] ?? ""}`],
    [/^@soop-lol\/module-([^/]+)(\/.*)?$/, (m) => `packages/modules/${m[1]}${m[2] ?? ""}`],
    [/^@soop-lol\/web(\/.*)?$/, (m) => `apps/web${m[1] ?? ""}`],
    [/^@soop-lol\/worker(\/.*)?$/, (m) => `apps/worker${m[1] ?? ""}`],
  ];
  for (const [re, to] of workspace) {
    const m = spec.match(re);
    if (m) return to(m);
  }
  return null;
}

function zoneOf(path: string | null): Zone {
  if (path === null) return { kind: "external" };
  const p = path.replace(/\.(ts|tsx|mts|js)$/, "").replace(/\/index$/, "");
  if (p === "packages/core/lib/contract" || p.startsWith("packages/core/lib/contract/")) return { kind: "contract" };
  if (p === "packages/core" || p.startsWith("packages/core/")) return { kind: "core" };
  if (p === "packages/modules" || /^packages\/modules\/(registry|ui)(\.generated)?$/.test(p)) return { kind: "registry" };
  const mod = p.match(/^packages\/modules\/([^/]+)/);
  if (mod) return { kind: "module", name: mod[1] };
  if (p === "packages/ui" || p.startsWith("packages/ui/")) return { kind: "ui" };
  if (p.startsWith("apps/web")) return { kind: "web" };
  if (p.startsWith("apps/worker")) return { kind: "worker" };
  return { kind: "other", path: p };
}

interface ImportRef { spec: string | null; line: number; how: string }
interface SqlText { text: string; line: number }

/** 파일의 모든 모듈 참조(정적·동적·재수출·타입 import·require)·문자열 리터럴·식별자. */
function scan(relPath: string): { imports: ImportRef[]; strings: SqlText[]; identifiers: Map<string, number> } {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  const kind = relPath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(relPath, text, ts.ScriptTarget.Latest, true, kind);
  const imports: ImportRef[] = [];
  const strings: SqlText[] = [];
  const identifiers = new Map<string, number>();
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const literal = (n: ts.Node | undefined) =>
    n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null;

  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      imports.push({ spec: literal(node.moduleSpecifier), line: lineOf(node),
        how: ts.isExportDeclaration(node) ? "재수출" : "import" });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      imports.push({ spec: literal(node.moduleReference.expression), line: lineOf(node), how: "import =" });
    } else if (ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      imports.push({ spec: literal(node.arguments[0]), line: lineOf(node),
        how: node.expression.kind === ts.SyntaxKind.ImportKeyword ? "동적 import()" : "require()" });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      imports.push({ spec: literal(node.argument.literal), line: lineOf(node), how: "타입 import()" });
    }
    if (ts.isIdentifier(node) && !identifiers.has(node.text)) identifiers.set(node.text, lineOf(node));
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      strings.push({ text: node.text, line: lineOf(node) });
    } else if (ts.isTemplateExpression(node)) {
      // 끼워 넣은 값은 ${…} 로 남긴다 — 테이블 이름을 끼워 넣으면 검사할 수 없으니 그 자체로 위반이다.
      strings.push({ text: node.head.text + node.templateSpans.map((s) => " ${…} " + s.literal.text).join(""),
        line: lineOf(node) });
      node.templateSpans.forEach((s) => visit(s.expression));
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { imports, strings, identifiers };
}

/** 한 파일의 import 가 허용 구역에만 닿는지. */
function checkImports(relPath: string, allowed: (z: Zone) => string | null) {
  for (const ref of scan(relPath).imports) {
    if (ref.spec === null) {
      check(`${relPath}:${ref.line}: ${ref.how} 대상이 문자열 상수다`, false, "경로를 계산하면 경계를 검사할 수 없다");
      continue;
    }
    const why = allowed(zoneOf(resolveSpec(relPath, ref.spec)));
    if (why) check(`${relPath}:${ref.line}: ${ref.how} "${ref.spec}"`, false, why);
  }
}

// ── SQL ─────────────────────────────────────────────────────────────────
//
// 모듈 SQL 의 규칙: **모든 테이블을 스키마로 한정해 쓴다** — 자기 mod_<name>.* 또는 core_public.*.
//
// 검사는 두 겹이다.
//   1층(위치) — 쓰기 대상·스키마 DDL·FROM/JOIN [ONLY|LATERAL] 대상을 문법 자리에서 판정한다.
//               위반 메시지가 "무엇을 어디에" 로 나와 고치기 쉽다.
//   2층(이름) — 문법을 해석하지 않는다. 남의 스키마로 한정된 이름, 남의 mod_* 이름,
//               스키마 없이 쓴 core 테이블 이름이 SQL **어디에든** 나오면 실패다.
//               콤마 조인·ONLY·서브쿼리·GRANT 처럼 1층이 모르는 문법도 여기서 걸린다.
// ★ 지원하지 않는 형태는 통과가 아니라 **막는 쪽**으로 정했다. core 테이블과 같은 이름의
//   별칭·CTE 도 실패다(이름을 바꾸면 된다). search_path 를 바꾸는 SQL 도 실패다 — 이름 판정이
//   무의미해진다. 보장 범위와 알려진 누락은 docs/ARCHITECTURE.md §3 에 적는다 — 이건 내부 실수를
//   잡는 검사지 DB 권한 격리를 대신하지 않는다.

// ★ 맨 `truncate` 는 Tailwind 클래스이기도 하다 — 테이블 이름 뒤에서 문장이 끝나야 SQL 로 본다.
const looksLikeSql = (s: string) =>
  /\b(select\b[\s\S]*\bfrom|insert\s+into|update\s+\S+\s+set|delete\s+from|merge\s+into|create\s+(or\s+replace\s+)?(schema|table|unlogged|index|unique|view|materialized|function|procedure|sequence|type|trigger)|(alter|drop)\s+(schema|table|view|materialized|function|procedure|sequence|type|index|trigger)|grant\s|revoke\s|comment\s+on|set\s+(local\s+)?search_path|with\s+\w+\s+as\s*\()\b/i.test(s)
  || /\btruncate\s+(?:table\s+)?(?:\$\{…\}|"?\w+"?(?:\.\w+)?)\s*(?:;|$|\b(?:restart|continue|cascade|restrict)\b)/i.test(s);

const unquote = (t: string) => t.replace(/"/g, "").replace(/\s*\.\s*/, ".").toLowerCase();

/** core 가 가진 스키마·테이블 이름. db/migrations 가 유일한 출처라 거기서 읽는다. */
const CORE = (() => {
  const dir = join(ROOT, "db", "migrations");
  const schemas = new Set(["public", "core_public"]);
  const tables = new Set<string>();
  if (!existsSync(dir)) return { schemas, tables, ok: false };
  const sql = readdirSync(dir).filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(join(dir, f), "utf8")).join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/"/g, "");
  for (const m of sql.matchAll(/\bcreate\s+schema(?:\s+if\s+not\s+exists)?\s+(\w+)/gi)) schemas.add(m[1].toLowerCase());
  for (const m of sql.matchAll(/\bcreate\s+(?:unlogged\s+)?(?:table|(?:or\s+replace\s+)?(?:materialized\s+)?view)(?:\s+if\s+not\s+exists)?\s+(?:public\s*\.\s*)?(\w+)(?!\s*\.)/gi)) {
    tables.add(m[1].toLowerCase());
  }
  return { schemas, tables, ok: tables.size > 0 };
})();

function checkSql(where: string, rawSql: string, schema: string) {
  // 문자열 값('…')은 이름이 아니다 — 비워 두고 본다.
  const sql = rawSql.replace(/'(?:[^']|'')*'/g, "''");
  const own = (target: string) => target.startsWith(`${schema}.`);
  const dynamic = (target: string) => target.includes("${");
  const reported = new Set<string>();
  const fail = (what: string, target: string, why: string) => {
    if (reported.has(target)) return;
    reported.add(target);
    check(`${where}: ${what} ${target}`, false, why);
  };

  // ── 1층: 문법 자리 ──
  // 대상 이름: 끼워 넣은 값(${…})을 먼저 본다 — 아니면 `$` 한 글자로 잘려 동적 이름을 놓친다.
  const NAME = String.raw`(\$\{…\}|"?\w+"?(?:\s*\.\s*"?\w+"?)?)`;
  const OBJ = String.raw`(?:table|view|materialized\s+view|function|procedure|sequence|type|index)`;
  const writes: [string, RegExp][] = [
    ["쓰기", new RegExp(String.raw`\b(?:insert\s+into|delete\s+from|merge\s+into|truncate(?:\s+table)?|(?:alter|drop)\s+${OBJ}(?:\s+if\s+exists)?|create\s+(?:or\s+replace\s+)?(?:unlogged\s+)?(?:table|view|materialized\s+view|function|procedure|sequence|type)(?:\s+if\s+not\s+exists)?)\s+(?:only\s+)?${NAME}`, "gi")],
    // ON CONFLICT … DO UPDATE · FOR UPDATE · FOR NO KEY UPDATE · ON UPDATE CASCADE 는 쓰는 대상이 아니다.
    ["UPDATE", new RegExp(String.raw`(?<!\b(?:do|for|key|on)\s+)\bupdate\s+(?:only\s+)?${NAME}`, "gi")],
    ["CREATE INDEX", new RegExp(String.raw`\bcreate\s+(?:unique\s+)?index\b[^;]*?\bon\s+(?:only\s+)?${NAME}`, "gi")],
  ];
  for (const [verb, re] of writes) {
    for (const m of sql.matchAll(re)) {
      const target = unquote(m[1]);
      if (dynamic(target)) fail(verb, target, "쓰는 대상 이름을 끼워 넣으면 검사할 수 없다");
      else if (!own(target)) fail(verb, target, `쓰기는 ${schema}.* 에만 한다`);
    }
  }

  // 스키마 자체를 다루는 문장 — DROP SCHEMA a, b 처럼 여럿일 수 있다.
  const schemaDdl = /\b(create|drop|alter)\s+schema(?:\s+if\s+(?:not\s+)?exists)?\s+([\w"]+(?:\s*,\s*[\w"]+)*)|\bon\s+schema\s+([\w"]+(?:\s*,\s*[\w"]+)*)/gi;
  for (const m of sql.matchAll(schemaDdl)) {
    const verb = m[1] ? `${m[1].toUpperCase()} SCHEMA` : "ON SCHEMA";
    for (const name of (m[2] ?? m[3]).split(",").map((n) => unquote(n.trim()))) {
      if (name !== schema) fail(verb, name, `자기 스키마(${schema})만 다룬다`);
    }
  }
  if (/\bset\s+(?:local\s+|session\s+)?search_path\b|\bset_config\s*\(\s*''/i.test(sql)) {
    fail("search_path", "변경", "search_path 를 바꾸면 스키마 없는 이름의 뜻이 바뀐다 — 이름을 한정해 쓴다");
  }

  const ctes = new Set([...sql.matchAll(/\b(\w+)\s+as\s+(?:not\s+)?(?:materialized\s+)?\(/gi)].map((m) => m[1].toLowerCase()));
  for (const m of sql.matchAll(new RegExp(String.raw`\b(from|join)\s+(?:only\s+|lateral\s+)?${NAME}(\s*\()?`, "gi"))) {
    const before = sql.slice(Math.max(0, m.index! - 40), m.index!);
    if (/(\bdelete\s*$|\bdistinct\s*$|\b(extract|substring|trim|overlay)\s*\([^()]*$)/i.test(before)) continue;
    if (m[3]) continue; // 함수 호출 — jsonb_each(…), unnest(…)
    const target = unquote(m[2]);
    if (["lateral", "only"].includes(target) || ctes.has(target)) continue;
    if (dynamic(target)) fail("읽기", target, "읽는 대상 이름을 끼워 넣으면 검사할 수 없다");
    else if (!own(target) && !target.startsWith("core_public.")) {
      fail("읽기", target, `core 는 계약 함수나 core_public.* 로만 읽는다 (자기 것은 ${schema}.*)`);
    }
  }

  // ── 2층: 자리와 무관한 이름 ──
  const flat = sql.replace(/"/g, "").replace(/\s*\.\s*/g, ".");
  for (const m of flat.matchAll(/(?<![\w.$])([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?/g)) {
    const head = m[1].toLowerCase();
    if (m[2]) {
      const isSchema = CORE.schemas.has(head) || head.startsWith("mod_");
      if (isSchema && head !== schema && head !== "core_public") {
        fail("이름", `${head}.${m[2].toLowerCase()}`, `다른 스키마(${head})를 가리킨다 — ${schema}.* 와 core_public.* 만 쓴다`);
      }
    } else if (head.startsWith("mod_") && head !== schema) {
      fail("이름", head, "다른 모듈의 스키마 이름이다");
    } else if (CORE.tables.has(head) && !ctes.has(head)) {
      fail("이름", head, "core 테이블 이름을 스키마 없이 썼다 — search_path 로 core 원본에 닿는다. core_public.* 로 한정한다");
    } else if (CORE.tables.has(head)) {
      fail("이름", head, "core 테이블과 같은 이름의 CTE 다 — 읽는 사람도 검사도 원본과 구분할 수 없다. 이름을 바꾼다");
    }
  }
}

const stripSqlComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");

// ── 모듈 ────────────────────────────────────────────────────────────────

interface ModuleInfo { name: string; schema: string; manifest: Record<string, unknown> }

function loadModules(): ModuleInfo[] {
  if (!existsSync(MODULES_DIR)) return [];
  const out: ModuleInfo[] = [];
  for (const name of readdirSync(MODULES_DIR).sort()) {
    if (!statSync(join(MODULES_DIR, name)).isDirectory() || name === "node_modules") continue;
    const manifestPath = join(MODULES_DIR, name, "module.json");
    if (!existsSync(manifestPath)) {
      check(`${name}: module.json 이 있다`, false, "manifest 없이는 등록도 제거도 추적이 안 된다");
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    out.push({ name, schema: String(manifest.schema), manifest });
  }
  return out;
}

console.log("\n▸ 모듈 경계 검사");

const modules = loadModules();
if (modules.length === 0) console.log("  (모듈이 없다 — 규칙만 준비된 상태)");
// 이름 판정(2층)은 core 테이블 목록이 있어야 돈다. 못 읽었는데 조용히 넘어가면 반쪽 검사가 통과로 보인다.
else check(`db/migrations 에서 core 이름을 읽었다 (테이블·뷰 ${CORE.tables.size}개)`, CORE.ok,
  CORE.ok ? "" : "SQL 이름 판정을 할 수 없다");

// ── 주소 글자 금지 ──────────────────────────────────────────────────────
// 프로필 주소(`/s/${slug}`)가 모듈·공용 UI 에 글자로 박혀 있어서, 롤을 /lol 로 옮기려니 40곳을 고쳐야 했다
// (docs/PLATFORM-LAYER-PLAN.md). core 화면 주소는 계약의 주소 함수(profileHref …)로,
// 모듈 자기 주소는 module.json 의 routes 로 만든다. 정적 파일만 글자로 쓴다.
// ★ 정적 파일 범위는 손으로 적지 않는다 — apps/web/public 의 실제 맨 위 폴더·파일이 곧 예외다.
//   폴더를 새로 만들면 자동으로 따라오고, public 에 없는 경로는 사이트 주소로 본다.
// ★ "/" 하나도 주소다(사이트 첫 화면). 예전 정규식(/^\/[a-z]/)은 이걸 놓쳤다.
const PUBLIC_DIR = join(ROOT, "apps", "web", "public");
const PUBLIC_ENTRIES = existsSync(PUBLIC_DIR) ? readdirSync(PUBLIC_DIR) : [];
const isAssetPath = (text: string) => PUBLIC_ENTRIES.some((e) => text === `/${e}` || text.startsWith(`/${e}/`));
const looksLikeSitePath = (text: string) => /^\/(?![/*])/.test(text) || text === "/";
function checkNoSitePaths(file: string, strings: SqlText[]) {
  for (const s of strings) {
    if (looksLikeSitePath(s.text) && !isAssetPath(s.text)) {
      check(`${file}:${s.line}: 주소 "${s.text.slice(0, 40)}" 를 글자로 쓴다`, false,
        "core 화면은 계약의 주소 함수(profileHref 등), 자기 화면은 module.json 의 routes(routeHref)로 만든다");
    }
  }
}

for (const m of modules) {
  console.log(`\n  [${m.name}]`);
  check(`manifest 이름이 디렉터리와 같다`, m.manifest.name === m.name, String(m.manifest.name));
  // ★ mod_ 로 시작하기만 하면 되던 시절엔 남의 스키마 이름을 적어도 통과했다.
  check(`manifest 의 schema 가 mod_${m.name} 이다`, m.schema === `mod_${m.name}`, m.schema);
  // routeHref 는 파라미터 이름 조합이 같은 경로 중 **첫 번째**를 조용히 고른다. 둘이면 어느 화면으로 갈지 모호하다.
  {
    const keyOf = (path: string) => [...path.matchAll(/\[(\w+)\]/g)].map((x) => x[1]).sort().join(",");
    const routes = Array.isArray(m.manifest.routes) ? (m.manifest.routes as { path: string }[]) : [];
    const seen = new Map<string, string>();
    const clashes = routes.flatMap((r) => {
      const k = keyOf(r.path), prev = seen.get(k);
      seen.set(k, r.path);
      return prev ? [`${prev} ↔ ${r.path}`] : [];
    });
    check(`경로마다 파라미터 조합이 다르다 (routeHref 가 하나로 고를 수 있다)`, clashes.length === 0, clashes.join(", "));
  }

  const files = sourcesIn("packages", "modules", m.name);
  const before = failures;
  for (const file of files) {
    checkImports(file, (z) => {
      switch (z.kind) {
        case "external": case "contract": case "ui": return null;
        case "module": return z.name === m.name ? null : `다른 모듈(${z.name})을 import 하지 않는다 (3조)`;
        case "core": return "core 내부 직접 접근 금지 — core/lib/contract 만 쓴다. 없으면 계약에 추가한다 (1조)";
        case "registry": return "등록부는 host 의 것이다 — 모듈이 보면 다른 모듈을 알게 된다";
        case "web": return "웹 내부를 import 하지 않는다 — 틀은 host 가, 내용은 모듈이";
        case "worker": return "워커 내부를 import 하지 않는다";
        case "other": return `저장소 밖 경계(${z.path})에 닿는다`;
      }
    });
    const { strings } = scan(file);
    for (const s of strings) {
      if (looksLikeSql(s.text)) checkSql(`${file}:${s.line}`, s.text, m.schema);
    }
    checkNoSitePaths(file, strings);
  }
  const migDir = join(MODULES_DIR, m.name, "migrations");
  const migrations = existsSync(migDir) ? readdirSync(migDir).filter((f) => f.endsWith(".sql")) : [];
  for (const f of migrations) {
    checkSql(`packages/modules/${m.name}/migrations/${f}`, stripSqlComments(readFileSync(join(migDir, f), "utf8")), m.schema);
  }
  check(`import·SQL·주소 글자 위반 없음 (소스 ${files.length}개 · 마이그레이션 ${migrations.length}개)`, failures === before);
}

// ── 모듈이 끌어다 쓰는 공용 UI ──────────────────────────────────────────
// packages/ui 는 모듈이 import 할 수 있다. 그러니 **여기가 계약 밖을 보면 모듈이 우회로를 얻는다.**
// ★ 공용 UI 는 표시만 한다. 계약에서 moduleDb() 를 받아 SQL 을 치면 import 규칙은 지키면서
//   어느 스키마에도 닿는다 — 그래서 DB 연결을 얻는 것·SQL 을 쓰는 것 자체를 막는다.
console.log("\n  [공용 UI (packages/ui)]");
{
  const files = sourcesIn("packages", "ui");
  const before = failures;
  for (const file of files) {
    checkImports(file, (z) => {
      switch (z.kind) {
        case "external": case "contract": case "ui": return null;
        case "core": return "모듈이 쓰는 화면이다 — core 는 계약으로만 읽는다";
        default: return `공용 UI 는 ${z.kind} 에 기대지 않는다`;
      }
    });
    const { imports, strings, identifiers } = scan(file);
    for (const ref of imports) {
      if (ref.spec && /^(postgres|pg|@electric-sql\/)/.test(ref.spec)) {
        check(`${file}:${ref.line}: DB 드라이버 "${ref.spec}"`, false, "공용 UI 는 표시만 한다");
      }
    }
    // 네임스페이스 import(c.moduleDb)도 식별자로 남는다. core 의 db() 는 core 내부 import 라 위에서 걸린다.
    const dbAt = identifiers.get("moduleDb");
    if (dbAt) check(`${file}:${dbAt}: DB 연결(moduleDb)을 얻는다`, false, "공용 UI 는 표시만 한다 — 데이터는 부르는 쪽이 넘긴다");
    for (const s of strings) {
      if (looksLikeSql(s.text)) check(`${file}:${s.line}: SQL 을 쓴다`, false, "공용 UI 는 표시만 한다");
    }
    checkNoSitePaths(file, strings);
  }
  check(`공용 UI 가 계약 밖을 보지 않고 DB 에 닿지 않으며 주소를 박지 않는다 (${files.length}개 파일)`, failures === before);
}

// ── 4조 — 역방향 의존 ───────────────────────────────────────────────────
console.log("\n  [역방향 의존]");
{
  const files = [...sourcesIn("packages", "core"), ...sourcesIn("apps", "worker"), ...sourcesIn("apps", "web")];
  const before = failures;
  for (const file of files) {
    checkImports(file, (z) => z.kind === "module"
      ? `특정 모듈(${z.name})을 import 하지 않는다 — 등록부(@soop-lol/modules/registry·ui)만 본다 (4조)`
      : null);
  }
  check(`core·worker·web 이 특정 모듈을 import 하지 않는다 (${files.length}개 파일)`, failures === before);
}

// ── 접힌 경기 한 줄을 그리는 화면들이 같은 표시 규칙을 쓰는지 ─────────────
//
// 이 셋은 같은 정보(날짜·대회명·스코어·승패·다전제 형식)를 서로 다른 배치로 그린다.
// 배치가 다른 건 의도지만 **문구가 다른 건 언제나 사고였다.** 실제로 겪은 것:
//   · 한 화면만 `bestOfLabel` 을 직접 불러, 형식을 모르는 줄에서 그 화면만 칸이 비었다
//   · 승패 판정식이 세 벌로 복사돼 있었다
// ★ 모듈 쪽 화면은 그 모듈이 있을 때만 본다. 모듈을 지웠다고 검사가 죽으면 5조 위반이다.
console.log("\n  [공유 표시 규칙]");
const present = (rel: string) => {
  const z = zoneOf(rel);
  if (existsSync(join(ROOT, rel))) return true;
  if (z.kind === "module" && !existsSync(join(MODULES_DIR, z.name))) {
    console.log(`  skip  ${rel} — ${z.name} 모듈이 없다`);
    return false;
  }
  check(`${rel}: 있다`, false, "core 쪽 화면이 사라졌다 — 목록을 고친다");
  return false;
};
const ROW_SCREENS = [
  "apps/web/components/personal-records.tsx",
  "apps/web/components/opponent-history.tsx",
  "packages/modules/versus/ui/detail.tsx",
].filter(present);
for (const rel of ROW_SCREENS) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  const has = (name: string) => src.includes(name);
  check(`${rel}: 뱃지 문구를 formatBadge 로 낸다`, has("formatBadge"),
    has("formatBadge") ? "" : "match-row-model 의 formatBadge 를 거치지 않는다");
  // bestOfLabel 은 형식을 모르면 빈 문자열이라, 화면이 직접 부르면 그 화면만 칸이 빈다.
  check(`${rel}: bestOfLabel 을 직접 부르지 않는다`, !has("bestOfLabel"),
    has("bestOfLabel") ? "formatBadge 를 거쳐야 한다" : "");
  check(`${rel}: 승패를 matchOutcome 으로 정한다`, has("matchOutcome"),
    has("matchOutcome") ? "" : "판정식을 이 파일에서 다시 쓰고 있다");
}

// 왼쪽에 날짜 칸을 세우는 타임라인은 '같은 날은 맨 위 한 번만' 규칙을 같이 쓴다.
// 개인 기록에만 넣었더니 상대전적 경기 기록이 그대로 날짜를 반복했다 — 그때 잡으려는 검사다.
const DATE_TIMELINES = [
  "apps/web/components/personal-records.tsx",
  "packages/modules/versus/ui/detail.tsx",
].filter(present);
for (const rel of DATE_TIMELINES) {
  const src = readFileSync(join(ROOT, rel), "utf8");
  check(`${rel}: 반복 날짜를 isRepeatedDate 로 판정한다`, src.includes("isRepeatedDate"),
    src.includes("isRepeatedDate") ? "" : "같은 날이 이어져도 날짜를 매 줄 반복한다");
}

console.log(failures === 0 ? "\n모듈 경계 이상 없음.\n" : `\n${failures}건 위반.\n`);
process.exit(failures === 0 ? 0 : 1);
