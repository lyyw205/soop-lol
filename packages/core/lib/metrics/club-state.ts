import { nextKstHour } from "../time.ts";
/** Engine F는 매일 한 번 실행한다. 한 회차의 지연을 허용하고 48시간부터 순위에서 제외한다. */
const COLLECTION_DAYS = 1;
export const CLUB_COLLECTION_POLICY = { cadenceDays: COLLECTION_DAYS, maxAgeMs: 2 * COLLECTION_DAYS * 24 * 60 * 60 * 1000 } as const;
export function nextClubCollectionAt(now: Date, hourKst: number): Date {
  const next = nextKstHour(now,hourKst);
  return new Date(next.getTime() + (CLUB_COLLECTION_POLICY.cadenceDays - 1) * 86_400_000);
}
export interface ClubAttempt {
  startedAt: string;
  completedAt: string | null;
  outcome: "ok" | "missing" | "error" | null;
  legacy: boolean;
}
export function resolveClubState(
  account: { attempt: ClubAttempt | null; value: number | null; valueAt: string | null },
  now: Date,
  policy = CLUB_COLLECTION_POLICY,
) {
  const age = account.valueAt ? now.getTime() - Date.parse(account.valueAt) : Infinity;
  const fresh = account.value !== null && age >= 0 && age < policy.maxAgeMs;
  const status: ClubAttempt["outcome"] | "pending" = account.attempt ? account.attempt.outcome ?? "pending" : null;
  return {
    status, checked_at: account.attempt?.startedAt ?? null,
    completed_at: account.attempt?.completedAt ?? null,
    history_complete: !!account.attempt && !account.attempt.legacy,
    fresh,
    // 실패/진행 중에는 최근 성공 값을 보존한다. 실제 missing은 현재 계정 순위에서 제외한다.
    rank_eligible: fresh && status !== "missing" && status !== null,
  };
}
export function pickRepresentative<T extends {rank_eligible: boolean; club_value: number | null; nickname: string}>(accounts: T[]): T | null {
  return accounts.filter(a => a.rank_eligible && a.club_value !== null)
    .sort((a,b) => b.club_value! - a.club_value! || a.nickname.localeCompare(b.nickname, "ko"))[0] ?? null;
}
