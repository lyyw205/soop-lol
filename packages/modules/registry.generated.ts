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
  /** 어느 공간의 틀 안에서 뜨나. platform(로비) · lol · fconline. 경기의 게임 종류와는 다른 축이다. */
  site: "platform" | "lol" | "fconline";
  jobs: ModuleJob[];
  /** 화면이 있는 모듈인가. 실제 컴포넌트는 ui.generated.ts 에 있다 (아래 ★ 참조). */
  hasUi: boolean;
}

import * as versus_server from "./versus/server/index.ts";

export const MODULES: RegisteredModule[] = [
  {
    name: "fc_leaderboard",
    version: "0.1.0",
    title: "FC 리더보드",
    description: "등록 스트리머의 수집 FC 경기를 승·골·경기 수로 줄 세운다.",
    schema: "mod_fc_leaderboard",
    routes: [{"path":"/fc/leaderboard","title":"리더보드"}],
    provides: [],
    navOrder: 20,
    site: "fconline",
    jobs: [

    ],
    hasUi: true,
  },
  {
    name: "fc_tournaments",
    version: "0.1.0",
    title: "FC 대회",
    description: "core 의 FC 대회 경기를 읽어 대회 목록·스탯표·선수 기록·다전제를 보여준다.",
    schema: "mod_fc_tournaments",
    routes: [{"path":"/fc/tournaments","title":"대회"},{"path":"/fc/tournaments/[slug]"}],
    provides: ["fc-tournaments"],
    navOrder: 15,
    site: "fconline",
    jobs: [

    ],
    hasUi: true,
  },
  {
    name: "fc_versus",
    version: "0.1.0",
    title: "FC 상대전적",
    description: "core 의 FC 공개 경기를 읽어 두 스트리머의 맞대결·경기 지표·사용 선수를 보여준다.",
    schema: "mod_fc_versus",
    routes: [{"path":"/fc/versus","title":"상대전적"}],
    provides: ["fc-versus"],
    navOrder: 10,
    site: "fconline",
    jobs: [

    ],
    hasUi: true,
  },
  {
    name: "tournaments",
    version: "0.1.0",
    title: "대회",
    description: "core 의 공개 대회 사실(대회·팀·경기)을 읽어 대회 목록과 대진·순위·선수 기록을 보여준다.",
    schema: "mod_tournaments",
    routes: [{"path":"/lol/tournaments","title":"대회"},{"path":"/lol/tournaments/[slug]"}],
    provides: ["tournaments"],
    navOrder: 15,
    site: "lol",
    jobs: [

    ],
    hasUi: true,
  },
  {
    name: "versus",
    version: "0.1.0",
    title: "상대전적",
    description: "코어의 조우를 읽어 두 스트리머의 맞대결·같은 팀·맞라인을 계산해 보여준다.",
    schema: "mod_versus",
    routes: [{"path":"/lol/versus","title":"상대전적"}],
    provides: ["versus"],
    navOrder: 10,
    site: "lol",
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

/**
 * nav 에 걸 모듈 경로. 하드코딩하지 않는다 — 모듈을 지우면 메뉴에서도 사라진다.
 * 동적 경로(/tournaments/[slug])는 누를 수 있는 메뉴가 아니라 뺀다.
 * navOrder 를 같이 준다 — host 가 자기 메뉴와 섞어 한 줄로 정렬한다.
 */
export const moduleNavRoutes = (site: RegisteredModule["site"]): { path: string; title: string; navOrder: number }[] =>
  MODULES.filter((m) => m.site === site)
    .sort((a, b) => a.navOrder - b.navOrder || a.name.localeCompare(b.name))
    .flatMap((m) => m.routes
      .filter((r) => !r.path.includes("["))
      .map((r) => ({ path: r.path, title: r.title ?? m.title, navOrder: m.navOrder })));

/**
 * 주소 → 그 주소를 선언한 모듈과 경로 파라미터. 없으면 null.
 * ★ host 는 모듈 이름을 모른 채 이것만 묻는다. 모듈이 module.json 에 적은 경로가 곧 주소다 —
 *   /m/<name> 에 묶이지 않는다. [name] 한 칸이 파라미터 하나다.
 */
export const matchModuleRoute = (segments: string[]): { module: RegisteredModule; params: Record<string, string> } | null => {
  for (const m of MODULES) {
    for (const r of m.routes) {
      const parts = r.path.split("/").filter(Boolean);
      if (parts.length !== segments.length) continue;
      const params: Record<string, string> = {};
      const hit = parts.every((part, i) => {
        const dynamic = /^\[(\w+)\]$/.exec(part);
        if (dynamic) { params[dynamic[1]] = segments[i]; return true; }
        return part === segments[i];
      });
      if (hit) return { module: m, params };
    }
  }
  return null;
};
