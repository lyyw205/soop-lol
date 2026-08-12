// ⚠️ 생성 파일이다. 직접 고치지 말 것 — `npm run modules:sync` 가 다시 만든다.
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

import * as leaderboard_server from "./leaderboard/server/index.ts";
import * as versus_server from "./versus/server/index.ts";

export const MODULES: RegisteredModule[] = [
  {
    name: "leaderboard",
    version: "0.1.0",
    title: "리더보드",
    description: "스트리머 티어 순위. rank_snapshot 을 mod_leaderboard 로 롤업한다.",
    schema: "mod_leaderboard",
    routes: [{"path":"/m/leaderboard","title":"리더보드"}],
    provides: [],
    navOrder: 20,
    jobs: [
      { name: "recompute", everyMinutes: 30, run: () => leaderboard_server.recompute() },
    ],
    hasUi: true,
  },
  {
    name: "versus",
    version: "0.1.0",
    title: "상대전적",
    description: "코어의 조우를 읽어 두 스트리머의 맞대결·같은 팀·맞라인을 계산해 보여준다.",
    schema: "mod_versus",
    routes: [{"path":"/m/versus","title":"상대전적"}],
    provides: ["versus"],
    navOrder: 10,
    jobs: [
      { name: "recompute", everyMinutes: 60, run: () => versus_server.recompute() },
    ],
    hasUi: true,
  },
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
