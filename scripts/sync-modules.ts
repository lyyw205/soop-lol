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
const OUT_UI = join(MODULES_DIR, "ui.generated.ts");

interface Manifest {
  name: string;
  version: string;
  title: string;
  description?: string;
  schema: string;
  routes?: { path: string; title?: string }[];
  /** 이 모듈이 채우는 역할. core 는 이름이 아니라 역할로 모듈을 찾는다. */
  provides?: string[];
  /** nav 에 뜨는 순서. 작을수록 앞. 안 적으면 100. */
  navOrder?: number;
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
  /**
   * 이 모듈이 채우는 역할.
   * ★ core 가 특정 모듈 이름을 아는 건 역방향 의존이다(계약 4조). 대신 core 는
   *   "상대전적을 보여주는 자리" 같은 **역할**을 묻고, 등록부가 누가 채우는지 답한다.
   *   그 모듈을 지우면 링크가 저절로 사라진다 — core 는 한 줄도 안 고친다.
   */
  provides: string[];
  navOrder: number;
  jobs: ModuleJob[];
  /** 화면이 있는 모듈인가. 실제 컴포넌트는 ui.generated.ts 에 있다 (아래 ★ 참조). */
  hasUi: boolean;
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
    provides: ${JSON.stringify(m.provides ?? [])},
    navOrder: ${m.navOrder ?? 100},
    jobs: [
${jobs}
    ],
    hasUi: ${hasUi(m.name)},
  },`;
  })
  .join("\n")}
];

export const moduleByName = (name: string): RegisteredModule | undefined =>
  MODULES.find((m) => m.name === name);

/** 그 역할을 채우는 모듈. 없으면 undefined — 부르는 쪽이 링크를 안 그리면 된다. */
export const moduleProviding = (capability: string): RegisteredModule | undefined =>
  MODULES.find((m) => m.provides.includes(capability));

/** nav 에 걸 모듈 경로. 하드코딩하지 않는다 — 모듈을 지우면 메뉴에서도 사라진다. */
export const moduleNavRoutes = (): { path: string; title: string }[] =>
  [...MODULES]
    .sort((a, b) => a.navOrder - b.navOrder || a.name.localeCompare(b.name))
    .flatMap((m) => m.routes.map((r) => ({ path: r.path, title: r.title ?? m.title })));
`;

writeFileSync(OUT, body);

/**
 * ★ 화면은 **따로 뽑는다.**
 *   등록부에 `ui: () => import("./x/ui/page.tsx")` 를 두면 그 파일을 읽는 쪽 전부가
 *   TSX 를 타입 그래프에 끌어안는다 — 잡만 돌리는 워커까지. 실제로 워커 타입검사가
 *   DOM 을 모른 채 모듈 화면을 검사하다 깨졌다. 워커는 잡을, 웹은 화면을 본다.
 */
const uiBody = `// ⚠️ 생성 파일이다. 직접 고치지 말 것 — \`npm run modules:sync\` 가 다시 만든다.
//
// 모듈 화면만 모은다. **웹만 이 파일을 읽는다** — 워커는 registry.generated.ts 만 본다.

import type { ComponentType } from "react";

export type ModuleView = ComponentType<{ searchParams: Record<string, string | string[] | undefined> }>;

export const MODULE_UI: Record<string, () => Promise<{ default: ModuleView }>> = {
${manifests.filter((m) => hasUi(m.name)).map((m) => `  ${JSON.stringify(m.name)}: () => import("./${m.name}/ui/page.tsx"),`).join("\n")}
};

export const moduleUi = (name: string) => MODULE_UI[name];
`;
writeFileSync(OUT_UI, uiBody);
console.log(
  `모듈 등록부 생성: ${manifests.length}개 — ${manifests.map((m) => m.name).join(", ") || "(없음)"}`,
);
