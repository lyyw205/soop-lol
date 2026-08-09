import "server-only";

import { RiotClient } from "@soop-lol/core/lib/riot/client";

/**
 * 웹에서 쓰는 RiotClient.
 *
 * 웹이 Riot API 를 직접 부르는 곳은 **관리자의 계정 조회 한 군데뿐**이다.
 * (Riot ID → puuid). 나머지 수집은 전부 워커가 한다 — 웹 요청 경로에서
 * 레이트리밋을 태우면 관리자 화면이 워커를 굶긴다.
 */

let client: RiotClient | null = null;

export function hasRiotKey(): boolean {
  return Boolean(process.env.RIOT_API_KEY);
}

export function riot(): RiotClient {
  if (!client) {
    const apiKey = process.env.RIOT_API_KEY;
    if (!apiKey) throw new Error("RIOT_API_KEY 가 없다");
    client = new RiotClient({ apiKey });
  }
  return client;
}
