import { isIP } from "node:net";

import type { AiAgent } from "./bot-guard.ts";

/**
 * AI 검색봇 확인 — 운영사가 공개한 IP 목록에 들어 있는지 본다(역방향 DNS 대신 쓰는 공식 방법).
 * 목록에 있으면 "verified"(검색봇 한도), 없거나 목록을 못 받았으면 "unknown"(일반 방문자 한도, 막지 않음).
 *
 * ★ 목록에 없다고 "fake" 로 막지 않는다 — 목록 갱신이 늦을 수 있고, 진짜 AI 검색을 403 하면 GEO 유입을 잃는다.
 *   꾸민 UA 는 일반 방문자 한도를 받을 뿐이라 막을 이유도 없다.
 * ★ 목록은 하루에 한 번 받는다. 받는 동안·실패하면 그 사이 요청은 unknown 이다(요청을 기다리게 하지 않는다).
 * ★ Claude-SearchBot·Claude-User 는 공개 목록이 없다(2026-10-15 확인) — 항상 unknown.
 */
const FEEDS: Partial<Record<AiAgent, string>> = {
  "oai-searchbot": "https://openai.com/searchbot.json",
  "chatgpt-user": "https://openai.com/chatgpt-user.json",
  "perplexitybot": "https://www.perplexity.com/perplexitybot.json",
  "perplexity-user": "https://www.perplexity.com/perplexity-user.json",
};
const REFRESH_MS = 24 * 3600_000;
const RETRY_MS = 10 * 60_000;

type Range = { v: 4 | 6; base: bigint; bits: number };
const lists = new Map<AiAgent, { ranges: Range[]; until: number }>();
const loading = new Set<AiAgent>();

function toBig(ip: string): { v: 4 | 6; n: bigint } | null {
  const v = isIP(ip);
  if (v === 4) return { v: 4, n: ip.split(".").reduce((a, o) => (a << 8n) + BigInt(Number(o)), 0n) };
  if (v !== 6) return null;
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [], t = tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8) return null;
  return { v: 6, n: groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g || "0", 16)), 0n) };
}

export function parseCidr(cidr: string): Range | null {
  const [addr, len] = cidr.split("/");
  const ip = addr ? toBig(addr) : null;
  const total = ip?.v === 4 ? 32 : 128;
  const bits = len === undefined ? total : Number(len);
  if (!ip || !Number.isInteger(bits) || bits < 0 || bits > total) return null;
  return { v: ip.v, base: ip.n >> BigInt(total - bits), bits };
}

export function inRanges(ip: string, ranges: Range[]): boolean {
  const x = toBig(ip);
  if (!x) return false;
  const total = x.v === 4 ? 32 : 128;
  return ranges.some((r) => r.v === x.v && x.n >> BigInt(total - r.bits) === r.base);
}

/** 공개 목록 JSON({prefixes:[{ipv4Prefix}|{ipv6Prefix}]}) → 범위. 모양이 틀리면 빈 목록. */
export function parseFeed(json: unknown): Range[] {
  const prefixes = (json as { prefixes?: unknown })?.prefixes;
  if (!Array.isArray(prefixes)) return [];
  return prefixes.flatMap((p) => {
    const cidr = (p as { ipv4Prefix?: string; ipv6Prefix?: string })?.ipv4Prefix ?? (p as { ipv6Prefix?: string })?.ipv6Prefix;
    const r = typeof cidr === "string" ? parseCidr(cidr) : null;
    return r ? [r] : [];
  });
}

async function refresh(agent: AiAgent, url: string) {
  if (loading.has(agent)) return;
  loading.add(agent);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { "User-Agent": "Mozilla/5.0 (compatible; soop-seek-bot-guard)" } });
    const ranges = res.ok ? parseFeed(await res.json()) : [];
    // 빈 목록으로 덮어쓰지 않는다 — 이전에 받은 것이 있으면 그대로 두고 금방 다시 시도한다.
    const prev = lists.get(agent);
    lists.set(agent, ranges.length ? { ranges, until: Date.now() + REFRESH_MS } : { ranges: prev?.ranges ?? [], until: Date.now() + RETRY_MS });
    if (!ranges.length) console.warn(`[bot-guard] AI 봇 IP 목록을 못 받았다: ${url} (${res.status})`);
  } catch (error) {
    const prev = lists.get(agent);
    lists.set(agent, { ranges: prev?.ranges ?? [], until: Date.now() + RETRY_MS });
    console.warn(`[bot-guard] AI 봇 IP 목록을 못 받았다: ${url} (${error})`);
  } finally {
    loading.delete(agent);
  }
}

export function checkAiBot(ip: string, agent: AiAgent): "verified" | "unknown" {
  const url = FEEDS[agent];
  if (!url) return "unknown";
  const list = lists.get(agent);
  if (!list || list.until <= Date.now()) void refresh(agent, url);
  return list && inRanges(ip, list.ranges) ? "verified" : "unknown";
}
