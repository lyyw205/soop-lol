/**
 * 시간 구간 연산 — 「어디까지 봤나」의 단일 출처.
 *
 * 조사 기록(`event_lead.raw.scan`)은 구간의 모음이다: 요청한 범위·실제로 훑은 범위·
 * 못 본 범위. 조사는 한 번에 안 끝나고 **여러 번에 나눠** 돌기 때문에, 이 값들은
 * 덮어쓰는 게 아니라 **누적**돼야 한다. 그리고 못 본 구간은 나중에 다시 훑으면
 * **해소**돼야 한다 — 안 그러면 이미 본 구간이 영원히 "못 봤다" 로 남는다.
 *
 * ★ 왜 core 에 두나: 같은 계산을 조사 도구(`ck:probe`)와 저장 경로(`markLeadScan`)가
 *   둘 다 한다. 따로 구현하면 "도구는 다 봤다는데 DB 는 안 봤다" 로 갈린다.
 */

export type Range = [number, number];

const valid = (r: unknown): r is Range =>
  Array.isArray(r) && r.length === 2
  && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[1] >= r[0];

/**
 * 겹치거나 맞닿은 구간을 합친다.
 *
 * ⚠ `a <= last[1] + 1` — 1초 틈은 붙은 것으로 본다. 프레임 시각이 정수 초라
 *   `[0,600]` 과 `[601,1200]` 은 사실 이어진 범위인데, 안 붙이면 기록이 잘게 쪼개진다.
 */
export function mergeRanges(ranges: readonly unknown[]): Range[] {
  const sorted = ranges.filter(valid).map((r): Range => [r[0], r[1]]).sort((a, b) => a[0] - b[0]);
  const out: Range[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/**
 * `from` 에서 `cut` 이 덮는 부분을 덜어낸다.
 *
 * 「못 본 구간」의 해소가 이것이다 — 다시 훑어 본 범위를 실패 목록에서 뺀다.
 * ⚠ 경계는 **양끝 포함**으로 다룬다(구간이 초 단위 시각이라). `[0,100]` 에서
 *   `[40,60]` 을 빼면 `[0,39]` 와 `[61,100]` 이다.
 */
export function subtractRanges(from: readonly unknown[], cut: readonly unknown[]): Range[] {
  const cuts = mergeRanges(cut);
  let out = mergeRanges(from);
  for (const [ca, cb] of cuts) {
    const next: Range[] = [];
    for (const [a, b] of out) {
      if (cb < a || ca > b) { next.push([a, b]); continue; }  // 안 겹친다
      if (a < ca) next.push([a, Math.min(b, ca - 1)]);
      if (b > cb) next.push([Math.max(a, cb + 1), b]);
    }
    out = next;
  }
  return out.filter(([a, b]) => b >= a);
}

/** 구간들이 덮는 총 길이(초). 「얼마나 봤나」를 한 숫자로 말할 때. */
export function coveredSeconds(ranges: readonly unknown[]): number {
  return mergeRanges(ranges).reduce((sum, [a, b]) => sum + (b - a), 0);
}
