import { progressKind, type VodWork } from '../../packages/core/lib/metrics/ck-vod-status.ts';

/** 비용 폭주 방지용 실행 횟수다. 경기 완료/재개 위치의 정본은 여전히 DB다. */
export const MAX_NO_OUTCOME_SESSIONS = 3;
export interface BackfillGuard {
  version: 1;
  attempt_id: string;
  no_outcome_sessions: number;
  after: VodWork;
}

export function parseGuard(value: unknown): BackfillGuard {
  const g = value as BackfillGuard;
  if (!g || g.version !== 1 || typeof g.attempt_id !== 'string' || !g.attempt_id
    || !Number.isSafeInteger(g.no_outcome_sessions) || g.no_outcome_sessions < 0 || !g.after
    || !['failed', 'unresolved', 'opened', 'settled'].every(k => {
      const n = g.after[k as keyof VodWork]; return typeof n === 'number' && Number.isFinite(n) && n >= 0;
    }) || (g.after.uncovered !== null && (!Number.isFinite(g.after.uncovered) || g.after.uncovered < 0))) {
    throw new Error('백필 반복 제한 기록이 손상됐다. 원인을 확인한 뒤 --reset-stall로 재개할 것');
  }
  return g;
}

export function guardBlocked(guard: BackfillGuard | null, current: VodWork): boolean {
  return current.reason !== null && guard !== null
    && guard.no_outcome_sessions >= MAX_NO_OUTCOME_SESSIONS
    && progressKind(guard.after, current) !== 'outcome';
}

export function advanceGuard(guard: BackfillGuard | null, attemptId: string, before: VodWork, after: VodWork): BackfillGuard {
  if (!attemptId) throw new Error('반복 제한에 필요한 조사 실행 ID가 없다');
  // after 재조회는 같은 세션을 두 번 세지 않는다.
  if (guard?.attempt_id === attemptId) return guard;
  const externalProgress = guard && progressKind(guard.after, before) === 'outcome';
  const count = externalProgress ? 0 : guard?.no_outcome_sessions ?? 0;
  return { version: 1, attempt_id: attemptId, after,
    no_outcome_sessions: progressKind(before, after) === 'outcome' ? 0 : count + 1 };
}
