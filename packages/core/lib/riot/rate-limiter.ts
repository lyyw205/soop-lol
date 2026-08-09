/**
 * Riot API 레이트리밋.
 *
 * Riot 은 **두 겹**으로 제한한다. 둘 다 만족해야 통과한다.
 *   - 앱 리밋    `X-App-Rate-Limit: 20:1,100:120`      (키 전체)
 *   - 메서드 리밋 `X-Method-Rate-Limit: 2000:60`        (엔드포인트별)
 * 하나만 지키면 반드시 429 를 맞는다.
 *
 * 설계 원칙 (docs/PLAN.md §11-4): 호출은 게이트웨이 하나만 통과한다.
 * 여기서 계산한 카운트가 실제 호출과 어긋나면 의미가 없으므로,
 * "검사 + 기록"을 **직렬화**한다. 처리량 상한이 어차피 앱 리밋이라 손해가 아니다.
 */

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/** "20:1,100:120" → [{limit:20, windowSec:1}, {limit:100, windowSec:120}] */
export function parseLimitSpec(spec: string): { limit: number; windowSec: number }[] {
  return spec
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [limit, windowSec] = part.split(":").map(Number);
      return { limit, windowSec };
    })
    .filter((x) => Number.isFinite(x.limit) && Number.isFinite(x.windowSec) && x.windowSec > 0);
}

class SlidingWindow {
  private hits: number[] = [];
  readonly limit: number;
  readonly windowSec: number;

  // ★ 파라미터 프로퍼티(`constructor(readonly x: number)`)를 쓰지 않는다.
  //   node 의 타입 스트리핑(`node --test *.ts`)이 지원하지 않아 런타임에 터진다.
  constructor(limit: number, windowSec: number) {
    this.limit = limit;
    this.windowSec = windowSec;
  }

  private prune(now: number) {
    const cutoff = now - this.windowSec * 1000;
    let i = 0;
    while (i < this.hits.length && this.hits[i] <= cutoff) i++;
    if (i > 0) this.hits.splice(0, i);
  }

  /** 0 이면 지금 통과 가능. 아니면 기다려야 할 ms. */
  waitMs(now: number): number {
    this.prune(now);
    if (this.hits.length < this.limit) return 0;
    return this.hits[0] + this.windowSec * 1000 - now + 1;
  }

  record(now: number) {
    this.hits.push(now);
  }

  /**
   * 서버가 보고한 카운트가 우리 계산보다 크면 그 차이를 메운다.
   * 프로세스를 재시작했거나 다른 인스턴스가 같은 키를 쓰는 경우에 대비한 보수적 보정.
   */
  syncCount(reported: number, now: number) {
    this.prune(now);
    for (let i = this.hits.length; i < reported; i++) this.hits.push(now);
  }
}

class LimiterGroup {
  private windows = new Map<number, SlidingWindow>();
  private spec = "";

  /** 헤더에서 받은 스펙으로 재구성. 스펙이 그대로면 카운트를 보존한다. */
  configure(spec: string) {
    if (!spec || spec === this.spec) return;
    const next = new Map<number, SlidingWindow>();
    for (const { limit, windowSec } of parseLimitSpec(spec)) {
      next.set(windowSec, new SlidingWindow(limit, windowSec));
    }
    this.windows = next;
    this.spec = spec;
  }

  get configured() {
    return this.windows.size > 0;
  }

  waitMs(now: number): number {
    let max = 0;
    for (const w of this.windows.values()) max = Math.max(max, w.waitMs(now));
    return max;
  }

  record(now: number) {
    for (const w of this.windows.values()) w.record(now);
  }

  syncCounts(countSpec: string, now: number) {
    for (const { limit: count, windowSec } of parseLimitSpec(countSpec)) {
      this.windows.get(windowSec)?.syncCount(count, now);
    }
  }
}

export interface RateLimiterOptions {
  /**
   * 헤더를 처음 보기 전까지 쓸 초기 추정치.
   * 기본값은 Development 키 기준(20 req/s, 100 req/2min) — 가장 빡빡한 쪽으로 잡는다.
   * Production 키를 쓰면 첫 응답 헤더를 보고 자동으로 넓어진다.
   */
  initialAppLimits?: string;
  now?: () => number;
  onWait?: (info: { methodId: string; waitMs: number; reason: string }) => void;
}

export class RateLimiter {
  private app = new LimiterGroup();
  private methods = new Map<string, LimiterGroup>();
  /** 429 를 맞았을 때 전체를 막는 시각 (application / service 스코프) */
  private globalGateUntil = 0;
  private methodGateUntil = new Map<string, number>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  private readonly onWait?: RateLimiterOptions["onWait"];

  constructor(opts: RateLimiterOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.onWait = opts.onWait;
    this.app.configure(opts.initialAppLimits ?? "20:1,100:120");
  }

  private methodGroup(methodId: string): LimiterGroup {
    let g = this.methods.get(methodId);
    if (!g) {
      g = new LimiterGroup();
      this.methods.set(methodId, g);
    }
    return g;
  }

  /** 통과할 수 있을 때까지 기다린 뒤 호출을 기록한다. */
  async acquire(methodId: string): Promise<void> {
    const run = this.chain.then(() => this.acquireInner(methodId));
    // 앞선 호출이 실패해도 체인이 끊기면 안 된다.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async acquireInner(methodId: string): Promise<void> {
    const method = this.methodGroup(methodId);
    for (;;) {
      const now = this.now();

      const gate = Math.max(this.globalGateUntil, this.methodGateUntil.get(methodId) ?? 0);
      if (gate > now) {
        const waitMs = gate - now;
        this.onWait?.({ methodId, waitMs, reason: "429-gate" });
        await sleep(waitMs);
        continue;
      }

      const waitMs = Math.max(this.app.waitMs(now), method.waitMs(now));
      if (waitMs > 0) {
        this.onWait?.({ methodId, waitMs, reason: "bucket" });
        await sleep(waitMs);
        continue;
      }

      this.app.record(now);
      method.record(now);
      return;
    }
  }

  /** 응답 헤더로 리밋 스펙과 카운트를 최신화한다. 매 응답마다 부른다. */
  observe(methodId: string, headers: Headers): void {
    const now = this.now();
    const appSpec = headers.get("x-app-rate-limit");
    if (appSpec) this.app.configure(appSpec);
    const appCount = headers.get("x-app-rate-limit-count");
    if (appCount) this.app.syncCounts(appCount, now);

    const method = this.methodGroup(methodId);
    const methodSpec = headers.get("x-method-rate-limit");
    if (methodSpec) method.configure(methodSpec);
    const methodCount = headers.get("x-method-rate-limit-count");
    if (methodCount) method.syncCounts(methodCount, now);
  }

  /**
   * 429 처리. **Retry-After 를 존중한다** — 임의 백오프로 덮어쓰지 않는다.
   * Riot 이 알려준 시간보다 일찍 다시 찌르면 제재가 길어진다.
   */
  penalize(methodId: string, headers: Headers): number {
    const retryAfterSec = Number(headers.get("retry-after") ?? "1");
    const waitMs = (Number.isFinite(retryAfterSec) ? retryAfterSec : 1) * 1000 + 250;
    const scope = (headers.get("x-rate-limit-type") ?? "application").toLowerCase();
    const until = this.now() + waitMs;
    if (scope === "method") {
      this.methodGateUntil.set(methodId, Math.max(this.methodGateUntil.get(methodId) ?? 0, until));
    } else {
      // application / service 는 키 전체를 막는다.
      this.globalGateUntil = Math.max(this.globalGateUntil, until);
    }
    return waitMs;
  }
}
