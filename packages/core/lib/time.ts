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
 * 화면에 찍는 KST 날짜 `YYYY.MM.DD`.
 *
 * ★ 왜 헬퍼로 올렸나: 화면마다 `kstDateString(x).replaceAll("-", ".")` 을 따로 적고 있었고,
 *   그 사이에 **ISO 문자열을 그대로 자르는 코드**(`played_at.slice(0, 10)`)가 섞여 들어와
 *   상대전적 화면만 **UTC 날짜**를 그리고 있었다. 자정을 넘긴 경기에서 개인 기록은
 *   09-20, 상대전적은 09-19 로 **같은 경기가 다른 날짜**로 보였다.
 *   날짜를 만드는 길을 하나로 좁혀야 그 틈이 안 생긴다.
 */
export function kstDotted(at: Date): string {
  return kstDateString(at).replaceAll("-", ".");
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

/**
 * `<input type="datetime-local">` 에 넣을 **KST 벽시계** 문자열 (`YYYY-MM-DDTHH:mm:ss`).
 *
 * ⚠⚠ 왜 이 짝이 필요한가 — 실제로 데이터가 밀렸다.
 *   예전엔 `game_creation.toISOString().slice(0,16)` 을 그대로 넣었다. 그건 **UTC** 인데
 *   `datetime-local` 은 값에 시간대가 없어 브라우저가 **로컬 시각**으로 읽고, 서버도
 *   `new Date(값)` 으로 **로컬**로 파싱한다. 그래서 KST 에서는 폼을 열어 **아무것도
 *   안 고치고 저장만 해도 경기 시각이 9시간 뒤로 밀렸다.** 초도 잘려 나갔다.
 *   승자 하나 고치려고 저장할 때마다 시각이 틀어지는 셈이라, 검수할수록 나빠졌다.
 *
 * ★ 그래서 화면은 KST 로 보여주고 서버도 KST 로 읽는다. 한국은 서머타임이 없어
 *   +9 고정이고(`KST_OFFSET_MS`), 그래서 서버가 어느 타임존이든 같은 값이 나온다.
 */
export function toKstInputValue(at: Date): string {
  return new Date(at.getTime() + KST_OFFSET_MS).toISOString().slice(0, 19);
}

/**
 * 위 짝. `datetime-local` 이 돌려준 KST 벽시계를 실제 시각으로 되돌린다.
 * 형식이 아니면 `null` — 호출부가 "형식이 올바르지 않다" 고 말할 수 있게 던지지 않는다.
 *
 * ★ 없는 날짜·시각도 `null` 이다. `Date.UTC` 는 넘친 값을 조용히 다음 달·다음 날로 넘긴다 —
 *   `2026-02-30` 이 3월 2일로, `25:00` 이 다음 날 01시로 저장됐다. 되돌려 같은지로 확인한다.
 */
export function fromKstInputValue(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const wall = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0));
  const back = [wall.getUTCFullYear(), wall.getUTCMonth() + 1, wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds()];
  if (back.join() !== [+y, +mo, +d, +h, +mi, s ? +s : 0].join()) return null;
  return new Date(wall.getTime() - KST_OFFSET_MS);
}

/**
 * 경기 시각을 **아는 만큼만** 적는다. 'date' 면 시각은 생성기가 지어낸 값이라 날짜만 낸다(0035).
 * ★ 화면마다 따로 판단하면 한쪽은 "19:00" 을 내고 다른 쪽은 날짜만 낸다 — 규칙은 여기 하나다.
 */
export function kstPlayedAt(at: Date, precision: "datetime" | "date"): string {
  const wall = new Date(at.getTime() + KST_OFFSET_MS).toISOString();
  const date = wall.slice(2, 10).replaceAll("-", ".");
  return precision === "datetime" ? `${date} ${wall.slice(11, 16)}` : date;
}
