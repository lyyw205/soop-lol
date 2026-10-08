/**
 * 커뮤니티 규칙 — docs/COMMUNITY-PLAN.md §2·§3. 계산은 여기 하나다(접근자·정기 작업·화면이 같이 쓴다 — 원칙 6).
 * DB 를 모른다. 단위 테스트로 지킨다.
 */

const DAY_MS = 86_400_000;

// ── 탈퇴와 재가입 ─────────────────────────────────────────────────────

/** 탈퇴 뒤 같은 소셜 계정으로 다시 가입할 수 없는 기본 기간. 신고 중복 제한·쓰기 한도를 탈퇴로 초기화하는 것을 막는다. */
export const REJOIN_COOLDOWN_DAYS = 30;
/** 영구 제재를 받은 계정의 로그인 연결을 남겨 두는 기간 — 무기한 보관하지 않는다. */
export const PERMANENT_SANCTION_HOLD_DAYS = 365;

export interface SanctionPeriod {
  created_at: Date;
  /** NULL = 영구 */
  ends_at: Date | null;
  lifted_at: Date | null;
}

/**
 * 탈퇴 회원이 같은 소셜 계정으로 다시 가입할 수 있게 되는 시각.
 *
 * ★ 저장하지 않고 그때그때 계산한다 — 탈퇴 뒤에 걸리거나 풀린 제재도 바로 반영된다
 *   (탈퇴 29일째 영구 제재 → 31일째 연결이 지워지는 일이 없다).
 * - 기본: 탈퇴 + 30일
 * - 풀리지 않은 기간 제재: 끝날 때까지(탈퇴 + 30일보다 짧으면 30일)
 * - 풀리지 않은 영구 제재: 제재 시각 + 1년
 */
export function rejoinBlockedUntil(withdrawnAt: Date, sanctions: readonly SanctionPeriod[]): Date {
  let until = withdrawnAt.getTime() + REJOIN_COOLDOWN_DAYS * DAY_MS;
  for (const s of sanctions) {
    if (s.lifted_at) continue;
    const end = s.ends_at ? s.ends_at.getTime() : s.created_at.getTime() + PERMANENT_SANCTION_HOLD_DAYS * DAY_MS;
    if (end > until) until = end;
  }
  return new Date(until);
}

/** 지금 쓰기를 막는 제재가 있나. */
export function activeSanction<T extends SanctionPeriod>(sanctions: readonly T[], now: Date): T | null {
  return sanctions.find((s) => !s.lifted_at && s.created_at.getTime() <= now.getTime()
    && (s.ends_at === null || s.ends_at.getTime() > now.getTime())) ?? null;
}
