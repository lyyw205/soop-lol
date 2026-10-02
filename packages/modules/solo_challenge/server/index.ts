/**
 * 솔랭 도전 모듈 — 서버. 도전 목록은 data/challenges.json(편집 데이터), 판·랭크·라인업은 core 공개 조회(계약)로 읽는다.
 * 자기 테이블이 없다 — 전부 요청 때 계산한다(대회 모듈과 같다). 그래서 잡·마이그레이션도 없다.
 */
import { listPublicAccountRanks, listPublicLineups, listPublicRankedGames } from "@soop-lol/core/lib/contract";

import data from "../data/challenges.json" with { type: "json" };
import { buildChallenge, type ChallengeDef, type ChallengeView } from "./model.ts";

export * from "./model.ts";

const DEFS = data.challenges as ChallengeDef[];

export function listChallengeDefs(): ChallengeDef[] {
  return DEFS;
}

/** KST 그날 0시 */
const kstStart = (day: string) => new Date(`${day}T00:00:00+09:00`);

export async function getChallenge(slug: string): Promise<ChallengeView | null> {
  const def = DEFS.find((d) => d.slug === slug);
  if (!def) return null;
  const puuids = def.members.map((m) => m.puuid);
  const [games, ranks] = await Promise.all([listPublicRankedGames(puuids, kstStart(def.since)), listPublicAccountRanks(puuids)]);
  const lineups = await listPublicLineups([...new Set(games.map((g) => g.match_id))]);
  return buildChallenge(def, games, ranks, lineups);
}

/** 목록 화면 — 도전마다 진행도만 */
export async function listChallenges(): Promise<ChallengeView[]> {
  return (await Promise.all(DEFS.map((d) => getChallenge(d.slug)))).filter((v): v is ChallengeView => !!v);
}
