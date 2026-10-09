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

/**
 * **이름과 무관한 일치 수** — (승패, 챔피언, K/D/A) 묶음이 양쪽에 몇 개 겹치나(중복값은 개수만큼만).
 *
 * ★ 왜 따로 세나 (2026-10-09) — 사람 대응은 화면 이름·연결 상태가 같아야 성립한다. 같은 판인데 한쪽은
 *   스트리머로, 다른 쪽은 오독된 화면 이름으로만 남아 10명 중 2~4명만 대응된 탓에 중복 3쌍이 그대로
 *   저장됐다(최기명 vs 원브올 g3·g4, 스맵임 랜드 g11). 열 명의 챔피언·KDA·승패가 통째로 같으면
 *   누가 누구인지 몰라도 같은 판이다.
 * ★ 실측(공개 수기 LoL 1,738경기, 같은 시간 범위의 643쌍): 중복이 아닌 쌍은 0~1개, 확정 중복은 8~10개.
 *   기준 8개는 그 사이 빈 구간에 있다 — `BLIND_MIN`.
 * 챔피언·K/D/A를 모두 읽었고 승패를 아는 자리만 센다. 일부만 읽은 자리는 일치로 세지 않는다.
 */
export const BLIND_MIN = 8;
export function blindOverlap(mine: readonly DuplicateParticipant[], stored: readonly DuplicateParticipant[]): number {
  const key = (p: DuplicateParticipant) => p.win === null || !(p.champion_id > 0)
    || p.kills === null || p.deaths === null || p.assists === null
    ? null : `${p.win ? "W" : "L"}|${p.champion_id}|${p.kills}/${p.deaths}/${p.assists}`;
  const left = new Map<string, number>();
  for (const p of stored) { const k = key(p); if (k) left.set(k, (left.get(k) ?? 0) + 1); }
  let n = 0;
  for (const p of mine) {
    const k = key(p), c = k ? left.get(k) ?? 0 : 0;
    if (k && c > 0) { n++; left.set(k, c - 1); }
  }
  return n;
}

/**
 * 같은 판 후보 판정. 양쪽 경기 시간을 알면서 ±2초를 벗어나면 다른 판이다(어떤 일치보다 우선).
 * 그 밖에는 이름 무관 일치(`blind`)가 8개 이상이거나, 사람 대응 일치가 기존 기준을 넘으면 후보다.
 */
export function isDuplicateGame(
  duration: number | null, otherDuration: number | null,
  counts: { kda: number; champ: number; blind?: number },
): boolean {
  const bothKnown = duration !== null && otherDuration !== null;
  if (bothKnown && Math.abs(duration - otherDuration) > 2) return false;
  if ((counts.blind ?? 0) >= BLIND_MIN) return true;
  if (bothKnown) return counts.kda >= 6 || counts.champ >= 6;
  return counts.kda >= 8 && counts.champ >= 8;
}

/** 시각 정밀도 — 'date' 는 날짜만 안다(시각은 어림). */
export interface DuplicateClock { at: Date; precision: "datetime" | "date" | string }

const kstDay = (d: Date) => new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);

/**
 * 같은 판일 수 있는 시간 범위. 어느 한쪽이라도 날짜만 알면 같은 KST 날짜, 둘 다 시각을 알면 ±20분.
 * ★ 저장 검사와 후보 조회가 **이 함수 하나**를 쓴다. 날짜별로 나눠 경기 ID 순서로 짝을 지으면
 *   자정 양쪽(23:55·00:05) 경기 중 ID 가 뒤집힌 쌍을 빠뜨린다 — 짝은 시각 순서로 만든다.
 */
export const DUPLICATE_WINDOW_SEC = 20 * 60;
export function withinDuplicateWindow(a: DuplicateClock, b: DuplicateClock): boolean {
  if (a.precision === "date" || b.precision === "date") return kstDay(a.at) === kstDay(b.at);
  return Math.abs(a.at.getTime() - b.at.getTime()) <= DUPLICATE_WINDOW_SEC * 1000;
}
