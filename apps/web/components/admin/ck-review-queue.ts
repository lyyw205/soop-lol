/**
 * CK 검수 큐의 경기 투영과 미연결 프레임 항목.
 *
 * ★ 사람 검수는 "공개될 값이 맞나" 를 프레임과 대조하는 일이다. 조사 후보·
 *   탐색 범위는 CLI `ck:record` 로 본다. 미연결 사진은 직접 확인하고 연결할 수 있게 큐에 남긴다.
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
  /** 연결된 근거와 이 구간 안의 미연결 프레임(시각 순). 표시용이며 DB 연결은 바꾸지 않는다. */
  frames: F[];
}

export interface ReviewQueueOptions {
  /** 명시적으로 확인된 VOD 시작 절대시각. 없으면 game_creation을 VOD 초로 추측하지 않는다. */
  vodStartedAt?: string | Date | null;
}

/** 결과창 기준으로 게임 시작 앞에 붙이는 밴픽·로비 여유(초). */
export const PREGAME_SEC = 10 * 60;

/** 시각을 모르는 경기의 자리. 큐에서는 "시각 미상", 미니맵에서는 축 밖의 점. */
export const UNPLACED = Number.MAX_SAFE_INTEGER;

/** 경기 항목 사이에 미연결 프레임을 시각 순으로 놓는다. */
export function reviewQueueEntries<M extends QueueMatchLike, F extends QueueFrameLike>(
  projection: ProjectedMatch<M, F>[], frames: readonly F[],
) {
  const entries: Array<
    { kind: "match"; id: string; at: number; item: ProjectedMatch<M, F> }
    | { kind: "frame"; id: string; at: number; frame: F }
  > = projection.map(item => ({ kind: "match", id: item.match.match_id, at: item.at, item }));
  const grouped = new Set(projection.flatMap(item => item.frames.map(frame => frame.id)));
  for (const frame of frames) if (frame.match_id == null && !grouped.has(frame.id)) {
    entries.push({ kind: "frame", id: frame.id, at: frame.at_sec ?? UNPLACED, frame });
  }
  return entries.sort((a, b) => a.at - b.at);
}

const epochMillis = (value: string | Date | null | undefined): number | null => {
  if (!value) return null;
  const millis = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
};

/** Reference candidates share the timeline, without acquiring a match association. */
export function chronologicalReviewQueue<M extends QueueMatchLike, F extends QueueFrameLike, G extends { key: string; from: number }>(
  projection: ProjectedMatch<M, F>[], frames: readonly F[], memos: readonly G[], matchesOnly = false,
) {
  const entries = reviewQueueEntries(projection, frames);
  if (matchesOnly) return entries.filter(entry => entry.kind === "match");
  return [...entries, ...memos.map(group => ({ kind: "memo" as const, id: group.key, at: group.from, group }))]
    .sort((a, b) => a.at - b.at);
}

/**
 * 경기마다 막대 범위와 비교 프레임을 정한다.
 *
 * 범위는 한 가지 출처만 쓴다: 연결 프레임 → 확인된 VOD 시작 + 경기 시각 → 미상.
 * 시간 근거가 없어도 경기를 버리지 않는다 — 고칠 수 없게 되면 검수가 아니다.
 */
export function projectReviewQueue<F extends QueueFrameLike, M extends QueueMatchLike>(
  frames: readonly F[], matches: readonly M[], options: ReviewQueueOptions = {},
): ProjectedMatch<M, F>[] {
  const byTime = (a: F, b: F) => (a.at_sec ?? UNPLACED) - (b.at_sec ?? UNPLACED);
  const projected: ProjectedMatch<M, F>[] = matches.map((match) => {
    const own = frames.filter((frame) => frame.match_id === match.match_id).sort(byTime);
    const times = own.map((frame) => frame.at_sec).filter((time): time is number => time != null);
    if (times.length) {
      // ★ 구간을 연결 사진의 처음~끝으로만 잡으면, 결과창 한 장만 연결한 경기는 구간이 한 점이 되어 그 판의
      //   밴픽·게임 화면이 하나도 안 묶였다(2026-10-08, 조사 세션이 몇 장 연결하느냐에 화면이 좌우됨).
      //   경기 길이를 알면 마지막 사진(대개 결과창)에서 게임 길이 + 밴픽·로비 여유만큼 앞까지 이 경기 구간으로 본다.
      const end = Math.max(...times);
      const fromDuration = match.game_duration && match.game_duration > 0 ? end - match.game_duration - PREGAME_SEC : end;
      return { match, frames: own, at: Math.max(0, Math.min(Math.min(...times), fromDuration)), end, rangeSource: "evidence" };
    }
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
  // 구간 안의 미연결 사진은 그 구간에서 보되, 경계 시각은 뒤 구간에만 배정한다.
  // DB match_id 는 그대로 둔다. 구간 밖/시각 미상 사진은 reviewQueueEntries 에서 독립 항목으로 남는다.
  for (const frame of frames) {
    if (frame.match_id != null || frame.at_sec == null) continue;
    const owner = projected.findLast(item => item.at !== UNPLACED && frame.at_sec! >= item.at && frame.at_sec! <= item.end);
    if (owner) owner.frames.push(frame);
  }
  for (const item of projected) item.frames.sort(byTime);
  return projected;
}
