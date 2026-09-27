/**
 * 스트리머 목록의 정렬 — **머리글을 눌러 내림차순 → 오름차순 → 해제** 로 돈다.
 *
 * ★ "모른다" 는 언제나 끝으로 간다
 *   티어가 없는 사람은 **낮은 티어가 아니라 값이 없는 것**이다. 오름차순이라고 그들을
 *   1위로 올리면 화면이 거짓말을 한다.
 *
 * ★ 표에 없는 정렬 키는 두지 않는다
 *   승률·경기 정렬도 만들었다가 그 열을 빼면서 같이 지웠다. 누를 수 없는 정렬은
 *   테스트만 남고 반드시 실제 동작과 어긋난다.
 */

export const STREAMER_SORTS = ["name", "tier"] as const;
export type StreamerSort = (typeof STREAMER_SORTS)[number];
export type SortDirection = "asc" | "desc";

export const isStreamerSort = (v: string | null | undefined): v is StreamerSort =>
  STREAMER_SORTS.some((s) => s === v);
export const isSortDirection = (v: string | null | undefined): v is SortDirection =>
  v === "asc" || v === "desc";

export interface SortableStreamer {
  display_name: string;
  lp_absolute: number | null;
}

/**
 * 머리글을 눌렀을 때의 다음 상태. **내림차순 → 오름차순 → 해제** 순으로 돈다.
 * 다른 열을 누르면 그 열의 내림차순부터 시작한다.
 */
export function nextSortState(
  current: { sort?: StreamerSort; dir?: SortDirection },
  column: StreamerSort,
): { sort?: StreamerSort; dir?: SortDirection } {
  if (current.sort !== column) return { sort: column, dir: "desc" };
  if (current.dir === "desc") return { sort: column, dir: "asc" };
  return {};
}

/**
 * 정렬한 새 배열을 돌려준다. 원본은 건드리지 않는다.
 * `sort` 가 없으면 받은 순서를 그대로 쓴다(질의가 정한 기본 순서).
 */
export function sortStreamerCards<T extends SortableStreamer>(
  rows: readonly T[],
  sort?: StreamerSort,
  dir: SortDirection = "desc",
): T[] {
  if (!sort) return [...rows];
  const byName = (a: T, b: T) => a.display_name.localeCompare(b.display_name, "ko");
  if (sort === "name") {
    return [...rows].sort((a, b) => (dir === "asc" ? byName(a, b) : byName(b, a)));
  }
  return [...rows].sort((a, b) => {
    const [x, y] = [a.lp_absolute, b.lp_absolute];
    // ★ 모르는 값은 방향과 무관하게 끝이다.
    if (x === null && y === null) return byName(a, b);
    if (x === null) return 1;
    if (y === null) return -1;
    return (dir === "asc" ? x - y : y - x) || byName(a, b);
  });
}
