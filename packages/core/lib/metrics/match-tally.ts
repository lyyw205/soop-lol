/**
 * **묶음 하나가 매치 전적에 몇 승·무·패로 들어가나** — 단일 출처 (0080).
 *
 * 묶음(series_key)은 화면에서 한 줄로 접히는 단위다. 대부분은 그 한 줄이 곧 매치 하나다 —
 * 다전제는 세트 과반을 이긴 쪽이 이기고, 정확히 반이면 무승부(옛 2세트제 조별리그).
 *
 * ★ 랜드만 다르다. 맞라인을 정하고 **판마다 팀을 섞는** 방식이라 묶음 단위 승패가 없다
 *   (docs/CK-COLLECTION.md §3.5-2). 랜드 한 줄은 판 수만큼의 매치다 — 4승 6패면 매치 4승 6패.
 *   묶음 키를 판으로 쪼개면 화면이 판마다 한 줄이 되고(실제로 그랬다), 그대로 두고 과반으로 세면
 *   "랜드 10판 = 1패" 가 된다. 그래서 묶음은 그대로 두고 **세는 규칙**만 여기서 가른다.
 *   SQL 쪽(listOpponents, listPersonalRecords)도 같은 규칙이다 — 바꿀 땐 같이 바꾼다.
 */
export interface GroupResult { sets: number; wins: number; land: boolean }
export interface MatchTally { matches: number; wins: number; draws: number; losses: number }

export const isLandCategory = (category: string | null | undefined) => category === "land";

export function tallyGroup({ sets, wins, land }: GroupResult): MatchTally {
  if (land) return { matches: sets, wins, draws: 0, losses: sets - wins };
  const win = wins * 2 > sets, draw = wins * 2 === sets;
  return { matches: 1, wins: win ? 1 : 0, draws: draw ? 1 : 0, losses: win || draw ? 0 : 1 };
}

export function tallyGroups(groups: readonly GroupResult[]): MatchTally {
  return groups.reduce<MatchTally>((t, g) => {
    const x = tallyGroup(g);
    return { matches: t.matches + x.matches, wins: t.wins + x.wins, draws: t.draws + x.draws, losses: t.losses + x.losses };
  }, { matches: 0, wins: 0, draws: 0, losses: 0 });
}
