/** 워커 설정. 전부 환경변수이고, 기본값은 **Development 키 기준**으로 보수적이다. */

export interface WorkerConfig {
  riotApiKey: string;

  /** Engine A — 랭크 스냅샷을 돌릴 KST 시각 (docs/PLAN.md §5). */
  rankHourKst: number;
  /** 프로필(닉네임·레벨)을 다시 받기까지의 최소 간격. */
  profileMaxAgeMs: number;

  /** Engine B — 라이브 폴링 주기. */
  liveIntervalMs: number;
  /** N 틱마다 spectator 판정을 무시하고 전 계정을 훑는다 (놓친 경기 안전망). */
  liveSweepEveryTicks: number;
  /** 커서가 없는 계정을 Engine B 가 볼 범위. 그 이전은 Engine C 의 몫이다. */
  liveLookbackMs: number;

  /** Engine C — 백필. */
  backfillEnabled: boolean;
  backfillYears: number;
  /** 한 슬라이스에서 상세 조회할 최대 매치 수. 작을수록 A/B 가 덜 굶는다. */
  backfillBatch: number;

  /** Engine D — 파생. */
  deriveIntervalMs: number;
  championStatIntervalMs: number;

  /** 할 일이 없을 때 쉬는 시간. */
  idleMs: number;
  /** Riot 호출 하나하나를 찍는다. 리밋 디버깅용. */
  verbose: boolean;
}

const num = (v: string | undefined, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const bool = (v: string | undefined, fallback: boolean): boolean =>
  v === undefined || v === "" ? fallback : !["0", "false", "no", "off"].includes(v.toLowerCase());

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const riotApiKey = env.RIOT_API_KEY ?? "";
  if (!riotApiKey) {
    throw new Error(
      "RIOT_API_KEY 가 없다. developer.riotgames.com 에서 발급해 apps/web/.env.local 에 넣을 것 (docs/SETUP.md §1)",
    );
  }
  if (!env.DATABASE_URL) {
    throw new Error("DATABASE_URL 이 없다 (docs/SETUP.md §4)");
  }

  return {
    riotApiKey,
    rankHourKst: num(env.RANK_HOUR_KST, 9),
    profileMaxAgeMs: num(env.PROFILE_MAX_AGE_HOURS, 20) * 60 * 60 * 1000,

    liveIntervalMs: num(env.LIVE_INTERVAL_MINUTES, 10) * 60 * 1000,
    liveSweepEveryTicks: num(env.LIVE_SWEEP_EVERY_TICKS, 6),
    liveLookbackMs: num(env.LIVE_LOOKBACK_DAYS, 3) * 24 * 60 * 60 * 1000,

    backfillEnabled: bool(env.BACKFILL_ENABLED, true),
    backfillYears: num(env.BACKFILL_YEARS, 2),
    backfillBatch: num(env.BACKFILL_BATCH, 25),

    deriveIntervalMs: num(env.DERIVE_INTERVAL_MINUTES, 15) * 60 * 1000,
    championStatIntervalMs: num(env.CHAMPION_STAT_INTERVAL_HOURS, 6) * 60 * 60 * 1000,

    idleMs: num(env.IDLE_SECONDS, 30) * 1000,
    verbose: bool(env.WORKER_VERBOSE, false),
  };
}
