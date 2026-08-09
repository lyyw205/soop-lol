/**
 * 모듈 잡 실행기.
 *
 * ★ 워커는 **등록부만** 안다. 특정 모듈을 직접 import 하지 않는다 —
 *   그 순간 "모듈을 지우면 워커가 깨지는" 결합이 생긴다.
 *   등록부는 생성 파일이라, 모듈 디렉터리를 지우고 modules:sync 를 돌리면
 *   여기서도 저절로 사라진다.
 *
 * 모듈 잡은 **우선순위가 가장 낮다**. Riot 을 부르지 않으므로 레이트리밋과
 * 무관하지만, 랭크 스냅샷 같은 되돌릴 수 없는 일을 밀리게 하면 안 된다.
 * 한 모듈이 터져도 다른 모듈과 core 엔진은 계속 간다.
 */

import { MODULES } from "@soop-lol/modules/registry";

import type { WorkerContext } from "./context.ts";
import type { EngineResult } from "./job.ts";
import { errorMessage, log } from "./log.ts";

const SCOPE = "modules";

/** 모듈별 다음 실행 시각. 프로세스 메모리에만 둔다 — 잃어도 되는 상태다. */
const nextRunAt = new Map<string, number>();

export function moduleJobsDue(now = Date.now()): { module: string; job: string }[] {
  const due: { module: string; job: string }[] = [];
  for (const m of MODULES) {
    for (const j of m.jobs) {
      const key = `${m.name}:${j.name}`;
      if ((nextRunAt.get(key) ?? 0) <= now) due.push({ module: m.name, job: j.name });
    }
  }
  return due;
}

export async function runDueModuleJobs(_ctx: WorkerContext, now = Date.now()): Promise<EngineResult> {
  let ran = 0;
  let failed = 0;
  const detail: Record<string, unknown> = {};

  for (const m of MODULES) {
    for (const j of m.jobs) {
      const key = `${m.name}:${j.name}`;
      if ((nextRunAt.get(key) ?? 0) > now) continue;
      try {
        const n = await j.run();
        detail[key] = n;
        ran++;
      } catch (e) {
        // 모듈 하나가 터져도 core 는 계속 간다. 그게 모듈인 이유다.
        failed++;
        detail[key] = "failed";
        log.error(SCOPE, "모듈 잡 실패", { module: m.name, job: j.name, error: errorMessage(e) });
      } finally {
        nextRunAt.set(key, Date.now() + j.everyMinutes * 60 * 1000);
      }
    }
  }

  return { processed: ran, detail: { ...detail, modules: MODULES.length, failed } };
}
