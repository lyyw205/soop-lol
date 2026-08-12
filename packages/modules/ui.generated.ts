// ⚠️ 생성 파일이다. 직접 고치지 말 것 — `npm run modules:sync` 가 다시 만든다.
//
// 모듈 화면만 모은다. **웹만 이 파일을 읽는다** — 워커는 registry.generated.ts 만 본다.

import type { ComponentType } from "react";

export type ModuleView = ComponentType<{ searchParams: Record<string, string | string[] | undefined> }>;

export const MODULE_UI: Record<string, () => Promise<{ default: ModuleView }>> = {
  "leaderboard": () => import("./leaderboard/ui/page.tsx"),
  "versus": () => import("./versus/ui/page.tsx"),
};

export const moduleUi = (name: string) => MODULE_UI[name];
