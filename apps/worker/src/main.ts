/**
 * 수집 워커 진입점.
 *
 *   node apps/worker/src/main.ts <command>
 *
 *   rank      Engine A — 랭크 스냅샷 1회
 *   live      Engine B — 신규 매치 따라잡기 1회
 *   backfill  Engine C — 백필 한 조각 (--all 이면 대기열이 빌 때까지)
 *   derive    Engine D — 조우 재파생 (--stats 면 champion_stat 도)
 *   loop      전부를 우선순위대로 상시 실행 (운영 기본값)
 *
 * 루트에서 `npm run worker -- <command>` 로 부르면 .env.local 이 자동으로 붙는다.
 */

import { closeDb } from "@soop-lol/core/lib/db/client";
import { sleep } from "@soop-lol/core/lib/riot/rate-limiter";
import { nextKstHour } from "@soop-lol/core/lib/time";

import { loadConfig } from "./config.ts";
import { createContext, isFatal, type WorkerContext } from "./context.ts";
import { runBackfillSlice } from "./engines/backfill.ts";
import { runDeriveEngine } from "./engines/derive.ts";
import { createLiveState, runLiveEngine } from "./engines/live.ts";
import { runRankEngine } from "./engines/rank.ts";
import { runJob } from "./job.ts";
import { errorMessage, log } from "./log.ts";

const SCOPE = "worker";

// ── 종료 신호 ────────────────────────────────────────────────────────

let stopping = false;
let wake: (() => void) | null = null;

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(130); // 두 번 누르면 즉시
    log.info(SCOPE, `${sig} — 진행 중인 작업을 마치고 종료한다`);
    stopping = true;
    wake?.();
  });
}

/** 종료 신호가 오면 즉시 깨는 sleep. */
function nap(ms: number): Promise<void> {
  if (stopping) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    wake = finish;
    function finish() {
      clearTimeout(timer);
      wake = null;
      resolve();
    }
  });
}

// ── 명령 ─────────────────────────────────────────────────────────────

async function main() {
  const [command = "loop", ...flags] = process.argv.slice(2);
  const cfg = loadConfig();
  const ctx = createContext(cfg);

  switch (command) {
    case "rank":
      await runJob(ctx, "engine_a_rank", () => runRankEngine(ctx));
      break;

    case "live":
      await runJob(ctx, "engine_b_live", () => runLiveEngine(ctx, createLiveState()));
      break;

    case "backfill": {
      const all = flags.includes("--all");
      for (;;) {
        const r = await runJob(ctx, "engine_c_backfill", () => runBackfillSlice(ctx));
        if (!all || r.exhausted || stopping) break;
      }
      break;
    }

    case "derive":
      await runJob(ctx, "engine_d_derive", () =>
        runDeriveEngine(ctx, { championStats: flags.includes("--stats") }),
      );
      break;

    case "loop":
      await loop(ctx);
      break;

    default:
      console.error(`알 수 없는 명령: ${command}\n  rank | live | backfill | derive | loop`);
      process.exitCode = 2;
  }
}

// ── 스케줄러 ─────────────────────────────────────────────────────────

/**
 * 우선순위 루프. 엔진들은 서로를 막지 않아야 하지만, **레이트리밋은 하나**다.
 * 그래서 동시에 돌리는 대신 순서를 정한다: A > B > D > C.
 *
 * 백필(C)은 한 번에 한 조각만 하므로, 다음 A/B 차례가 오면 자연스럽게 양보한다.
 */
async function loop(ctx: WorkerContext) {
  const { cfg } = ctx;
  const liveState = createLiveState();

  let nextRank = nextKstHour(new Date(), cfg.rankHourKst).getTime();
  let nextLive = 0;
  let nextDerive = 0;
  let nextStats = Date.now() + cfg.championStatIntervalMs;
  let backfillPausedUntil = 0;

  log.info(SCOPE, "시작", {
    rankAt: `${String(cfg.rankHourKst).padStart(2, "0")}:00 KST`,
    nextRank: new Date(nextRank).toISOString(),
    liveEveryMin: cfg.liveIntervalMs / 60000,
    backfill: cfg.backfillEnabled,
  });

  while (!stopping) {
    const now = Date.now();
    try {
      if (now >= nextRank) {
        await runJob(ctx, "engine_a_rank", () => runRankEngine(ctx));
        nextRank = nextKstHour(new Date(), cfg.rankHourKst).getTime();
        continue;
      }
      if (now >= nextLive) {
        await runJob(ctx, "engine_b_live", () => runLiveEngine(ctx, liveState));
        nextLive = Date.now() + cfg.liveIntervalMs;
        continue;
      }
      if (now >= nextDerive) {
        const stats = now >= nextStats;
        await runJob(ctx, "engine_d_derive", () => runDeriveEngine(ctx, { championStats: stats }));
        nextDerive = Date.now() + cfg.deriveIntervalMs;
        if (stats) nextStats = Date.now() + cfg.championStatIntervalMs;
        continue;
      }
      if (cfg.backfillEnabled && now >= backfillPausedUntil) {
        const r = await runJob(ctx, "engine_c_backfill", () => runBackfillSlice(ctx));
        // 대기열이 비었으면 잠시 쉰다 — 빈 큐를 초당 몇 번씩 긁을 이유가 없다.
        if (r.exhausted) backfillPausedUntil = Date.now() + 10 * 60 * 1000;
        continue;
      }
    } catch (e) {
      if (isFatal(e)) throw e;
      log.error(SCOPE, "잡 실패 — 계속 진행한다", { error: errorMessage(e) });
      await nap(cfg.idleMs);
      continue;
    }

    const deadlines = [nextRank, nextLive, nextDerive];
    if (cfg.backfillEnabled) deadlines.push(backfillPausedUntil);
    const waitMs = Math.min(cfg.idleMs, Math.max(1000, Math.min(...deadlines) - Date.now()));
    await nap(waitMs);
  }
}

// ── 실행 ─────────────────────────────────────────────────────────────

try {
  await main();
} catch (e) {
  if (isFatal(e)) {
    // Development 키는 24시간마다 죽는다. 조용히 0건 처리를 반복하는 것보다
    // 여기서 죽는 편이 낫다 — 재발급하고 다시 띄우라는 신호다. (docs/SETUP.md §1-1)
    log.error(SCOPE, "Riot API 키가 만료됐거나 권한이 없다. 재발급 후 다시 띄울 것", {
      error: errorMessage(e),
    });
  } else {
    log.error(SCOPE, "치명적 오류", { error: errorMessage(e) });
  }
  process.exitCode = 1;
} finally {
  await closeDb();
  await sleep(0); // 풀이 닫히는 마이크로태스크를 흘려보낸다
  log.info(SCOPE, "종료");
}
