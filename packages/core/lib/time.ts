/**
 * 시간 — 이 서비스의 하루는 **KST** 기준이다.
 *
 * 한국은 서머타임이 없어서 UTC+9 가 항상 고정이다. 그래서 Intl 없이
 * 단순 덧셈으로 정확히 계산할 수 있다 (워커가 어느 타임존의 서버에서 돌든 같은 값).
 *
 * `rank_snapshot.snapshot_date` 가 서버 로컬 날짜로 찍히면 UTC 서버에서는
 * 09:00 KST 스냅샷이 **전날 날짜**로 들어간다. 그러면 티어 추이 그래프의
 * x축이 하루씩 밀리고, 재실행하면 같은 날에 두 행이 생긴다.
 */

export const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** KST 기준 'YYYY-MM-DD'. rank_snapshot.snapshot_date 의 단일 출처. */
export function kstDateString(at: Date): string {
  return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
}

/** KST 기준 연도. champion_stat.season 라벨에 쓴다. */
export function kstYear(at: Date): number {
  return new Date(at.getTime() + KST_OFFSET_MS).getUTCFullYear();
}

/**
 * `at` 이후 가장 이른 KST `hour`시 정각.
 * `at` 이 정확히 그 시각이면 **다음 날**을 준다 (같은 실행에서 두 번 돌지 않게).
 */
export function nextKstHour(at: Date, hour: number): Date {
  const shifted = new Date(at.getTime() + KST_OFFSET_MS);
  const target = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
    hour, 0, 0, 0,
  );
  const asUtc = target - KST_OFFSET_MS;
  return new Date(asUtc > at.getTime() ? asUtc : asUtc + 24 * 60 * 60 * 1000);
}

/** Riot 의 match-v5 startTime/endTime 은 **초** 단위다. ms 로 넣으면 조용히 빈 배열이 온다. */
export const toEpochSeconds = (at: Date): number => Math.floor(at.getTime() / 1000);
