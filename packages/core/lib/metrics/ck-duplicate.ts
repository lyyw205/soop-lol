import { identKey } from "./pov.ts";

/** person_id는 계정의 현재 주인을 우선한 사람 ID다(조우 파생과 같은 순서). */
export interface DuplicateParticipant {
  person_id: string | null;
  puuid: string | null;
  observed_name: string | null;
  win: boolean | null;
  champion_id: number;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
}

const personKey = (p: DuplicateParticipant) => identKey({
  streamer_id: p.person_id, puuid: p.puuid, observed_name: p.observed_name,
});

function samePerson(a: DuplicateParticipant, b: DuplicateParticipant): boolean {
  // 확인된 신원이 다르면 같은 화면 이름이나 KDA로 이어 붙이지 않는다.
  if (a.person_id && b.person_id) return a.person_id === b.person_id;
  if (a.puuid && b.puuid) return a.puuid === b.puuid;
  const name = identKey({ observed_name: a.observed_name });
  return name !== null && name === identKey({ observed_name: b.observed_name });
}

/** 신원으로 먼저 대응시킨다. 모호한 이름은 제외하고 양쪽 사람을 한 번씩만 센다. */
export function duplicateParticipantCounts(mine: DuplicateParticipant[], stored: DuplicateParticipant[]) {
  const usedMine = new Set<string>(), usedStored = new Set<string>();
  let kda = 0, champ = 0;
  for (const p of mine) {
    const key = personKey(p);
    if (!key || usedMine.has(key)) continue;
    const candidates = stored.filter((s) => samePerson(p, s));
    if (candidates.length !== 1) continue;
    const other = candidates[0], otherKey = personKey(other);
    if (!otherKey || usedStored.has(otherKey)) continue;
    usedMine.add(key);
    usedStored.add(otherKey);
    if (p.win === null || other.win === null || p.win !== other.win) continue;
    if (p.champion_id > 0 && p.champion_id === other.champion_id) champ++;
    // 일부만 읽은 K/D를 완전한 KDA 일치로 세지 않는다.
    if (p.kills !== null && p.deaths !== null && p.assists !== null
      && p.kills === other.kills && p.deaths === other.deaths && p.assists === other.assists) kda++;
  }
  return { kda, champ };
}

export function isDuplicateGame(duration: number | null, otherDuration: number | null, counts: { kda: number; champ: number }): boolean {
  if (duration !== null && otherDuration !== null) {
    return Math.abs(duration - otherDuration) <= 2 && (counts.kda >= 6 || counts.champ >= 6);
  }
  return counts.kda >= 8 && counts.champ >= 8;
}
