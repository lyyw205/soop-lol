/**
 * 모듈 등록부를 **생성**한다.
 *
 *   npm run modules:sync
 *
 * 왜 손으로 관리하지 않나: "모듈 디렉터리를 지우면 끝"이 성립하려면
 * 어딘가에 모듈 목록을 손으로 적어두면 안 된다. 지우고 나서 그 목록을
 * 같이 고쳐야 하는 순간, 모듈은 이미 독립적이지 않다.
 *
 * 왜 런타임 스캔이 아니라 생성인가: 번들러가 정적으로 읽을 수 있어야
 * Next 가 모듈 UI 를 코드 스플리팅할 수 있다. 변수 경로 import 는 못 한다.
 *
 * `predev` / `prebuild` 에 걸려 있어서 평소에는 직접 부를 일이 없다.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const MODULES_DIR = join(ROOT, "packages", "modules");
const OUT = join(MODULES_DIR, "registry.generated.ts");

interface Manifest {
  name: string;
  version: string;
  title: string;
  description?: string;
  schema: string;
  routes?: { path: string; title?: string }[];
  jobs?: { name: string; everyMinutes: number }[];
}

const manifests: Manifest[] = [];
if (existsSync(MODULES_DIR)) {
  for (const dir of readdirSync(MODULES_DIR).sort()) {
    const full = join(MODULES_DIR, dir);
    if (!statSync(full).isDirectory()) continue;
    const mf = join(full, "module.json");
    if (!existsSync(mf)) continue;
    const m = JSON.parse(readFileSync(mf, "utf8")) as Manifest;
    if (m.name !== dir) throw new Error(`module.json 의 name(${m.name}) 이 디렉터리(${dir})와 다르다`);
    manifests.push(m);
  }
}

const hasUi = (name: string) => existsSync(join(MODULES_DIR, name, "ui", "page.tsx"));
const hasServer = (name: string) => existsSync(join(MODULES_DIR, name, "server", "index.ts"));

const body = `// ⚠️ 생성 파일이다. 직접 고치지 말 것 — \`npm run modules:sync\` 가 다시 만든다.
// 모듈 디렉터리를 지우고 이걸 다시 돌리면 등록부에서도 사라진다.

export interface ModuleRoute {
  path: string;
  title?: string;
}

export interface ModuleJob {
  name: string;
  everyMinutes: number;
  /** 서버 진입점의 export 이름과 같다. */
  run: () => Promise<number>;
}

export interface RegisteredModule {
  name: string;
  version: string;
  title: string;
  description?: string;
  schema: string;
  routes: ModuleRoute[];
  jobs: ModuleJob[];
  /** UI 가 있는 모듈만. Next 가 코드 스플리팅할 수 있게 동적 import 로 둔다. */
  ui?: () => Promise<{ default: React.ComponentType<Record<string, never>> }>;
}

${manifests
  .filter((m) => hasServer(m.name))
  .map((m) => `import * as ${m.name.replace(/-/g, "_")}_server from "./${m.name}/server/index.ts";`)
  .join("\n")}

export const MODULES: RegisteredModule[] = [
${manifests
  .map((m) => {
    const varName = m.name.replace(/-/g, "_");
    const jobs = (m.jobs ?? [])
      .map(
        (j) =>
          `      { name: ${JSON.stringify(j.name)}, everyMinutes: ${j.everyMinutes}, run: () => ${varName}_server.${j.name}() },`,
      )
      .join("\n");
    return `  {
    name: ${JSON.stringify(m.name)},
    version: ${JSON.stringify(m.version)},
    title: ${JSON.stringify(m.title)},
    description: ${JSON.stringify(m.description ?? "")},
    schema: ${JSON.stringify(m.schema)},
    routes: ${JSON.stringify(m.routes ?? [])},
    jobs: [
${jobs}
    ],${hasUi(m.name) ? `\n    ui: () => import("./${m.name}/ui/page.tsx"),` : ""}
  },`;
  })
  .join("\n")}
];

export const moduleByName = (name: string): RegisteredModule | undefined =>
  MODULES.find((m) => m.name === name);
`;

writeFileSync(OUT, body);
console.log(
  `모듈 등록부 생성: ${manifests.length}개 — ${manifests.map((m) => m.name).join(", ") || "(없음)"}`,
);
