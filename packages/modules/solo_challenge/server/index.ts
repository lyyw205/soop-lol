/**
 * 솔랭 도전 모듈 — 서버. 자기 테이블이 없다 — 전부 요청 때 계산한다(대회 모듈과 같다). 그래서 잡·마이그레이션도 없다.
 *
 *   · 누구·언제·어느 큐 → core 지명(owner `module:solo_challenge/<slug>`, docs/COLLECTION-DESIGNATION-PLAN.md). 정본이 core 한 곳이다 —
 *     수집 범위와 화면 범위가 어긋날 수 없다.
 *   · 화면 꾸밈·도전 계정 → data/challenges.json. 도전 계정은 "이 도전은 그 사람의 어느 계정으로 하나"라는 도전 자체의 내용이다
 *     (지명은 그 사람의 계정 전부를 모은다).
 *   · 판·랭크·라인업 → core 공개 조회(계약).
 */
import {
  getPublicCollectionOrder, kstDateString, listPublicAccountRanks, listPublicLineups, listPublicRankedGames,
  type PublicCollectionOrder,
} from "@soop-lol/core/lib/contract";

import data from "../data/challenges.json" with { type: "json" };
import { buildChallenge, type ChallengeDef, type ChallengeFileDef, type ChallengeView } from "./model.ts";

export * from "./model.ts";

const FILE_DEFS = data.challenges as ChallengeFileDef[];

/** 이 도전의 지명 목적 키 — core 지명의 owner. */
export const challengeOwner = (slug: string) => `module:solo_challenge/${slug}`;

/**
 * 파일의 꾸밈 + 지명의 범위 → 화면이 쓰는 도전 정의. 지명이 없으면 도전도 없다(모으지 않는 것을 보여 주지 않는다).
 * ★ 사람은 지명된(그리고 공개인) 사람만 남긴다 — 파일에만 있는 사람은 그 판이 모이지 않으므로 화면에 올리지 않는다.
 */
export function resolveChallenge(file: ChallengeFileDef, order: PublicCollectionOrder | null): ChallengeDef | null {
  if (!order) return null;
  const named = new Set(order.members.map((m) => m.streamer_slug));
  const members = file.members.filter((m) => named.has(m.streamer));
  if (!members.length) return null;
  return {
    ...file,
    members,
    since: kstDateString(order.starts_at),
    until: order.ends_at ? kstDateString(order.ends_at) : null,
  };
}

async function load(slug: string): Promise<{ def: ChallengeDef; order: PublicCollectionOrder } | null> {
  const file = FILE_DEFS.find((d) => d.slug === slug);
  if (!file) return null;
  const order = await getPublicCollectionOrder(challengeOwner(slug));
  const def = resolveChallenge(file, order);
  return def && order ? { def, order } : null;
}

export async function getChallenge(slug: string): Promise<ChallengeView | null> {
  const found = await load(slug);
  if (!found) return null;
  const { def, order } = found;
  const puuids = def.members.map((m) => m.puuid);
  const [games, ranks] = await Promise.all([
    listPublicRankedGames(puuids, { since: order.starts_at, until: order.ends_at, queueIds: order.queue_ids }),
    listPublicAccountRanks(puuids),
  ]);
  const lineups = await listPublicLineups([...new Set(games.map((g) => g.match_id))]);
  return buildChallenge(def, games, ranks, lineups);
}

/** 목록 화면 — 도전마다 진행도만 */
export async function listChallenges(): Promise<ChallengeView[]> {
  return (await Promise.all(FILE_DEFS.map((d) => getChallenge(d.slug)))).filter((v): v is ChallengeView => !!v);
}
