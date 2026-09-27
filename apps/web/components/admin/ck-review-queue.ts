/**
 * CK 검수 큐의 투영 규칙 — **경기와 그 경기의 비교 프레임만** 다룬다.
 *
 * ★ 사람 검수는 "공개될 값이 맞나" 를 프레임과 대조하는 일이다. 조사 후보·미배정 프레임·
 *   탐색 범위는 LLM 조사의 몫이라 여기 없다(CLI `ck:record` 로 본다).
 */

export interface QueueFrameLike {
  id: string;
  match_id: string | null;
  at_sec: number | null;
}

export interface QueueMatchLike {
  match_id: string;
  /** VOD 상대 초로 옮길 때만 쓰는 실제 경기 시작 절대시각. */
  game_creation?: string | Date | null;
  game_creation_epoch_ms?: number | null;
  game_duration?: number | null;
}

export interface QueueRange { at: number; end: number }

export interface ProjectedMatch<M, F> extends QueueRange {
  match: M;
  rangeSource: "evidence" | "game_time" | "unknown";
  /** 이 경기에 연결된 비교 프레임(시각 순). */
  frames: F[];
}

export interface ReviewQueueOptions {
  /** 명시적으로 확인된 VOD 시작 절대시각. 없으면 game_creation을 VOD 초로 추측하지 않는다. */
  vodStartedAt?: string | Date | null;
}

/** 시각을 모르는 경기의 자리. 큐에서는 "시각 미상", 미니맵에서는 축 밖의 점. */
export const UNPLACED = Number.MAX_SAFE_INTEGER;

const epochMillis = (value: string | Date | null | undefined): number | null => {
  if (!value) return null;
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
};

/**
 * 경기마다 막대 범위와 비교 프레임을 정한다.
 *
 * 범위는 한 가지 출처만 쓴다: 연결 프레임 → 확인된 VOD 시작 + 경기 시각 → 미상.
 * 시간 근거가 없어도 경기를 버리지 않는다 — 고칠 수 없게 되면 검수가 아니다.
 */
export function projectReviewQueue<F extends QueueFrameLike, M extends QueueMatchLike>(
  frames: readonly F[], matches: readonly M[], options: ReviewQueueOptions = {},
): ProjectedMatch<M, F>[] {
  const byTime = (a: F, b: F) => (a.at_sec ?? 0) - (b.at_sec ?? 0);
  const projected: ProjectedMatch<M, F>[] = matches.map((match) => {
    const own = frames.filter((frame) => frame.match_id === match.match_id).sort(byTime);
    const times = own.map((frame) => frame.at_sec).filter((time): time is number => time != null);
    if (times.length) return { match, frames: own, at: Math.min(...times), end: Math.max(...times), rangeSource: "evidence" };
    const vodStartedAt = epochMillis(options.vodStartedAt);
    const gameCreation = Number.isFinite(match.game_creation_epoch_ms)
      ? match.game_creation_epoch_ms!
      : epochMillis(match.game_creation);
    if (vodStartedAt != null && gameCreation != null) {
      const at = Math.max(0, (gameCreation - vodStartedAt) / 1000);
      return { match, frames: own, at, end: at + Math.max(0, match.game_duration ?? 0), rangeSource: "game_time" };
    }
    return { match, frames: own, at: UNPLACED, end: UNPLACED, rangeSource: "unknown" };
  });
  projected.sort((a, b) => a.at - b.at);
  for (let index = 0; index < projected.length - 1; index++) {
    const current = projected[index], next = projected[index + 1];
    // 같은 VOD 의 두 경기가 시간축을 동시에 차지하지 않게 한다. 늦게 남은 결과 프레임은
    // 앞 경기의 비교 프레임으로 계속 볼 수 있지만 막대는 다음 경기 시작에서 끝난다.
    if (next.at !== UNPLACED && current.end > next.at) current.end = next.at;
  }
  return projected;
}
