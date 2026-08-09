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
  jobs: ModuleJob[];
  /** UI 가 있는 모듈만. Next 가 코드 스플리팅할 수 있게 동적 import 로 둔다. */
  ui?: () => Promise<{ default: React.ComponentType<Record<string, never>> }>;
}

import * as leaderboard_server from "./leaderboard/server/index.ts";

export const MODULES: RegisteredModule[] = [
  {
    name: "leaderboard",
    version: "0.1.0",
    title: "리더보드",
    description: "스트리머 티어 순위. rank_snapshot 을 mod_leaderboard 로 롤업한다.",
    schema: "mod_leaderboard",
    routes: [{"path":"/m/leaderboard","title":"리더보드"}],
    jobs: [
      { name: "recompute", everyMinutes: 30, run: () => leaderboard_server.recompute() },
    ],
    ui: () => import("./leaderboard/ui/page.tsx"),
  },
];

export const moduleByName = (name: string): RegisteredModule | undefined =>
  MODULES.find((m) => m.name === name);
