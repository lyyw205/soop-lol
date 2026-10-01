// ⚠️ 생성 파일이다. 직접 고치지 말 것 — `npm run modules:sync` 가 다시 만든다.
//
// 모듈 화면만 모은다. **웹만 이 파일을 읽는다** — 워커는 registry.generated.ts 만 본다.

import type { ComponentType } from "react";

export interface ModuleViewProps {
  /** module.json 경로의 [name] 칸. 경로에 파라미터가 없으면 비어 있다. */
  params: Record<string, string>;
  searchParams: Record<string, string | string[] | undefined>;
  /**
   * 다른 모듈 화면으로 가는 링크. **역할**로 묻는다 — roleHref("fc-tournaments", { slug }).
   * 모듈은 서로의 이름도 등록부도 모른다(3조) — host 가 대신 풀어 주고, 그 역할의 모듈이 없으면 null.
   */
  roleHref: (role: string, params?: Record<string, string>, query?: Record<string, string>) => string | null;
}
export type ModuleView = ComponentType<ModuleViewProps>;
/** 화면 모듈의 모양. generateMetadata 가 있으면 host 가 제목을 거기서 받는다. */
export interface ModuleUiEntry {
  default: ModuleView;
  generateMetadata?: (props: ModuleViewProps) => Promise<{ title?: string }> | { title?: string };
}

export const MODULE_UI: Record<string, () => Promise<ModuleUiEntry>> = {
  "fc_leaderboard": () => import("./fc_leaderboard/ui/page.tsx"),
  "fc_tournaments": () => import("./fc_tournaments/ui/page.tsx"),
  "fc_versus": () => import("./fc_versus/ui/page.tsx"),
  "schedule": () => import("./schedule/ui/page.tsx"),
  "tournaments": () => import("./tournaments/ui/page.tsx"),
  "versus": () => import("./versus/ui/page.tsx"),
};

export const moduleUi = (name: string) => MODULE_UI[name];
