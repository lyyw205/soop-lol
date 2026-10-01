/**
 * FC 시리즈(다전제) 파생 — **승패를 저장하지 않는다.** 세트가 원본이고 여기서 계산한다.
 * (CLAUDE.md 원칙 5 «파생은 언제나 재계산 가능», 원칙 6 «계산식은 core 단일 출처»)
 *
 * ★ LoL 공식을 그대로 못 쓰는 이유
 *   LoL 은 `내 세트승 * 2 > 세트수` 로 과반을 본다(public.ts). FC 는 **세트 자체가
 *   무승부**일 수 있어서 그 식이 거짓말을 한다 — 승·무·패 한 세트씩이면 1*2 > 3 이
 *   거짓이라 「패」로 접힌다. 그래서 FC 는 **양쪽 세트승을 직접 비교**한다.
 *
 * ★ best_of 를 모르면 「확정」을 말하지 않는다
 *   3판2선승인지 5판3선승인지는 대회 규정이고, 근거 없이 추측하지 않는다
 *   (match_series_best_of_has_evidence 가 DB 에서도 막는다). 모를 때 clinched 는 null 이다.
 */

export interface FcoSeriesParticipantLike {
  ouid: string;
  /** 공개 연결된 스트리머. 있으면 이것으로 같은 사람을 합친다(부계정·화면 경기 포함). */
  streamer_id?: string | null;
  nickname: string;
  streamer_name?: string | null;
  outcome: string;
  side_no: number;
}

export interface FcoSeriesSetLike {
  series_id: string | null;
  series_game_no: number | null;
  best_of?: number | null;
  participants: FcoSeriesParticipantLike[];
}

export interface FcoSeriesSide {
  /** OUID — 닉네임이 바뀌어도 같은 사람을 가리킨다. */
  key: string;
  name: string;
  set_wins: number;
}

export interface FcoSeriesStanding {
  series_id: string;
  best_of: number | null;
  sets: number;
  /** 무승부로 끝난 세트 수. 어느 쪽의 세트승도 아니다. */
  draws: number;
  sides: FcoSeriesSide[];
  /** 세트를 더 많이 이긴 쪽. 동률이면 null. */
  leader_key: string | null;
  /** best_of 기준 과반 확보 여부. best_of 를 모르면 null — 「모른다」와 「아니다」는 다르다. */
  clinched: boolean | null;
  /** 남은 세트를 다 줘도 뒤집히지 않거나 예정 세트를 다 치렀나. best_of 를 모르면 null. */
  complete: boolean | null;
}

const displayName = (p: FcoSeriesParticipantLike) => p.streamer_name || p.nickname;

/** 세트 묶음 → 시리즈 집계. 세트 순서는 series_game_no 를 따른다. */
export function fcoSeriesStanding(setsInput: FcoSeriesSetLike[]): FcoSeriesStanding {
  const sets = [...setsInput].sort((a, b) => (a.series_game_no ?? 0) - (b.series_game_no ?? 0));
  const sides = new Map<string, FcoSeriesSide>();
  let draws = 0;
  for (const set of sets) {
    for (const p of set.participants) {
      // 같은 사람을 한 쪽으로 합친다 — 공개 조회는 ouid 를 주지만(미공개 상대는 'unlinked:<side>'), 스트리머가 있으면 그게 정체다.
      const key = p.streamer_id ? `streamer:${p.streamer_id}` : p.ouid;
      const side = sides.get(key) ?? { key, name: displayName(p), set_wins: 0 };
      // 최신 세트의 표시 이름을 쓴다 — 닉네임이 바뀌어도 같은 key 로 합쳐진다.
      side.name = displayName(p);
      if (p.outcome === "win") side.set_wins += 1;
      sides.set(key, side);
    }
    if (set.participants.length > 0 && set.participants.every((p) => p.outcome === "draw")) draws += 1;
  }
  const best_of = sets.find((s) => s.best_of != null)?.best_of ?? null;
  const ordered = [...sides.values()].sort((a, b) => b.set_wins - a.set_wins);
  const top = ordered[0]?.set_wins ?? 0;
  const tied = ordered.filter((s) => s.set_wins === top).length > 1;
  const needed = best_of != null ? Math.floor(best_of / 2) + 1 : null;
  return {
    series_id: sets[0]?.series_id ?? "",
    best_of,
    sets: sets.length,
    draws,
    sides: ordered,
    leader_key: tied || ordered.length === 0 ? null : ordered[0].key,
    clinched: needed == null ? null : top >= needed,
    complete: best_of == null ? null : top >= (needed as number) || sets.length >= best_of,
  };
}

/** 한 사람 기준의 시리즈 결과. 기록 집계는 이 값을 쓴다. */
export function fcoSeriesResultFor(standing: FcoSeriesStanding, sideKey: string): "win" | "loss" | "draw" {
  if (standing.leader_key === null) return "draw";
  return standing.leader_key === sideKey ? "win" : "loss";
}

/** `2 : 1` 처럼 읽히는 시리즈 스코어. 무승부 세트가 있으면 뒤에 붙인다. */
export function fcoSeriesScore(standing: FcoSeriesStanding): string {
  const score = standing.sides.map((s) => s.set_wins).join(" : ");
  return standing.draws > 0 ? `${score} (무 ${standing.draws})` : score;
}

export type FcoSeriesBlock<T> =
  | { kind: "single"; game: T }
  | { kind: "series"; series_id: string; sets: T[]; standing: FcoSeriesStanding };

/**
 * 경기 목록을 시리즈 블록으로 접는다. 시리즈에 속하지 않은 경기는 단판 그대로 둔다.
 * 입력 순서를 유지한다 — 시리즈는 **첫 세트가 있던 자리**에 놓인다.
 */
export function groupFcoSeries<T extends FcoSeriesSetLike>(games: T[]): FcoSeriesBlock<T>[] {
  const blocks: FcoSeriesBlock<T>[] = [];
  const index = new Map<string, number>();
  for (const game of games) {
    if (!game.series_id) { blocks.push({ kind: "single", game }); continue; }
    const at = index.get(game.series_id);
    if (at == null) {
      index.set(game.series_id, blocks.length);
      blocks.push({ kind: "series", series_id: game.series_id, sets: [game], standing: fcoSeriesStanding([game]) });
    } else {
      const block = blocks[at] as Extract<FcoSeriesBlock<T>, { kind: "series" }>;
      block.sets.push(game);
      block.standing = fcoSeriesStanding(block.sets);
    }
  }
  return blocks;
}
