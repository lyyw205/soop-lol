/**
 * 양끝을 포함해 구간을 같은 길이의 `divisions`개 구간으로 나누는 정수 초 지점.
 * 짧은 구간에서는 반올림으로 겹친 지점을 제거한다.
 */
export function dividedPoints(start, end, divisions) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    throw new Error("시작·끝은 0 이상의 올바른 구간이어야 한다.");
  }
  if (!Number.isInteger(divisions) || divisions < 2) {
    throw new Error("분할 수는 2 이상의 정수여야 한다.");
  }

  return [...new Set(Array.from(
    { length: divisions + 1 },
    (_, i) => Math.round(start + ((end - start) * i) / divisions),
  ))];
}
