import { promises as dns } from "node:dns";

import { normalizeIp, SEARCH_ENGINES, type SearchEngine } from "./bot-guard.ts";

/**
 * 검색봇 자칭 확인 — 역방향 DNS(IP → 이름)가 엔진 도메인으로 끝나고, 그 이름을 다시 찾으면 같은 IP 가 나와야 한다.
 * 구글·빙·네이버가 공식으로 안내하는 방법이다. UA 는 아무나 쓸 수 있으니 이걸 통과해야 검색봇 한도를 준다.
 *
 * ★ DNS 가 **실패**하면(시간 초과·서버 오류·대기열 가득) "unknown" — 가짜로 몰지 않는다.
 *   진짜 구글봇을 403 하면 색인이 빠진다. unknown 은 일반 방문자처럼 센다.
 *   "fake" 는 이름이 엔진 도메인이 아니거나, 정방향이 다른 IP 를 줄 때만이다.
 * ★ 같은 IP 동시 조회는 하나로 합치고, 전체 동시 조회 수를 묶는다 — 가짜 구글봇이 몰려와도 DNS 를 두드리지 못하게.
 * ★ 결과는 IP 별로 하루(실패는 10분) 캐시한다. 첫 요청만 수십 ms 늦다.
 */
export type SearchCheck = "verified" | "fake" | "unknown";
type Entry = { result: SearchCheck; until: number; host?: string };

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
const DAY = 86_400_000;
const LOOKUP_TIMEOUT_MS = 1500;
const MAX_CONCURRENT = 8;
let running = 0;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), LOOKUP_TIMEOUT_MS); })])
    .finally(() => clearTimeout(timer));
}

async function lookup(ip: string, engine: SearchEngine, now: number): Promise<Entry> {
  const hosts = SEARCH_ENGINES[engine].hosts;
  try {
    const names = await withTimeout(dns.reverse(ip));
    const host = names.find((name) => hosts.some((suffix) => name.toLowerCase().replace(/\.$/, "").endsWith(suffix)));
    if (!hosts.length) return { result: "unknown", until: now + DAY, host: names[0] };
    if (!host) return { result: "fake", until: now + DAY, host: names[0] };
    const forward = await withTimeout(ip.includes(":") ? dns.resolve6(host) : dns.resolve4(host));
    return { result: forward.some((addr) => normalizeIp(addr) === ip) ? "verified" : "fake", until: now + DAY, host };
  } catch (error) {
    // PTR 이 아예 없다고 확답(ENOTFOUND)이면 엔진 주소가 아니다. 다만 1시간만 기억한다.
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOTFOUND" && hosts.length
      ? { result: "fake", until: now + 3600_000 }
      : { result: "unknown", until: now + 10 * 60_000 };
  }
}

export async function checkSearchBot(ip: string, engine: SearchEngine, now = Date.now()): Promise<{ result: SearchCheck; host?: string }> {
  const key = `${engine}|${ip}`;
  const hit = cache.get(key);
  if (hit && hit.until > now) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;
  if (running >= MAX_CONCURRENT) return { result: "unknown" };

  running++;
  const job = lookup(ip, engine, now).then((entry) => {
    cache.set(key, entry);
    if (cache.size > 20_000) cache.delete(cache.keys().next().value!);
    return entry;
  }).finally(() => { running--; inflight.delete(key); });
  inflight.set(key, job);
  return job;
}
