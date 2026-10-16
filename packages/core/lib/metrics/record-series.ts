/**
 * 공개 세트 행을 **시리즈 한 줄**로 접는다 — 개인 기록 매치 히스토리·상대 전적 펼친 목록·상대전적 상세가 같은 함수를 쓴다.
 *
 * ★ 세는 규칙은 여기 없다. 세트 결과 묶음 → 시리즈 결과는 `tally.ts` 의 `seriesOutcome`, 세트 수는 `tally` 다.
 *   이 파일은 "어느 세트가 같은 시리즈인가 · 어떤 순서로 보이나 · 어디서 페이지를 자르나" 만 정한다.
 *   예전엔 접는 코드가 화면마다 있었고, 세는 규칙(다수결·랜드 분기)이 TS 1곳 + SQL 3곳에 복사돼 있었다.
 * ★ 넘겨받은 행이 곧 센 세트다 — 맵 탭·진행 방식·기간·관계·맞라인으로 고르는 일은 부르는 쪽(질의)이 끝낸 뒤다.
 *   맵이 섞인 시리즈는 맵 탭마다 그 탭의 세트로 시리즈가 된다(계획 §5.2).
 */
import { readRecordCursor } from "./record-cursor.ts";
import { counted, seriesOutcome, tally, type Counts, type Outcome } from "./tally.ts";

export interface SeriesSetRow {
  series_id: string;
  match_id: string;
  series_game_no: number | null;
  played_at: Date | string;
  outcome: Outcome;
  /** 확인 전 세트(0093) — 줄에는 보이고 점수·결과에는 안 들어간다. */
  pending?: boolean;
}

export interface SeriesGroup<T extends SeriesSetRow> {
  series_id: string;
  /** 시리즈에서 가장 먼저 열린 세트 — 줄 제목(행사·형식)은 이 행에서 읽는다. */
  first: T;
  /** 세트 번호 → 시각 순. */
  sets: T[];
  /** 이 줄의 세트 결과(승·무·패·미상). */
  record: Counts;
  /** 이 줄의 시리즈 결과 — tally.ts 의 seriesOutcome 하나로 정한다(확인 전 세트는 빼고). 전부 확인 전이면 미상. */
  result: Outcome;
  /** 확인 전 세트가 하나라도 있나 — 줄의 "확인 전" 표시. */
  pending: boolean;
  played_at: Date;
}

const time = (v: Date | string) => new Date(v).getTime();

/** 최신 시리즈가 먼저. 같은 시각이면 시리즈 ID 순(이어 보기 커서와 같은 순서). */
export function foldSeries<T extends SeriesSetRow>(rows: readonly T[]): SeriesGroup<T>[] {
  const by = new Map<string, T[]>();
  for (const row of rows) {
    const list = by.get(row.series_id);
    if (list) {
      // 같은 세트가 두 번 오면(질의 조인 중복) 한 번만 센다.
      if (!list.some((r) => r.match_id === row.match_id)) list.push(row);
    } else by.set(row.series_id, [row]);
  }
  return [...by.entries()].map(([series_id, list]) => {
    const sets = [...list].sort((a, b) => (a.series_game_no ?? 0) - (b.series_game_no ?? 0) || time(a.played_at) - time(b.played_at)
      || a.match_id.localeCompare(b.match_id));
    const first = [...list].sort((a, b) => time(a.played_at) - time(b.played_at) || a.match_id.localeCompare(b.match_id))[0];
    return {
      series_id, first, sets,
      record: tally(sets).sets,
      pending: sets.some((s) => !counted(s)),
      // 센 세트가 없으면(전부 확인 전) 미상 — 빈 묶음을 seriesOutcome 에 넘기면 0:0 무가 된다.
      result: sets.some(counted) ? seriesOutcome(sets.filter(counted).map((s) => s.outcome)) : "unknown",
      played_at: new Date(first.played_at),
    };
  }).sort((a, b) => b.played_at.getTime() - a.played_at.getTime() || a.series_id.localeCompare(b.series_id));
}

/**
 * 이어 보기 — 커서(`recordCursor(시각, 시리즈 ID)`) 다음부터 `limit` 줄. 시리즈를 중간에서 자르지 않는다.
 * 잘못된 커서는 처음부터다(readRecordCursor 가 null).
 */
export function pageSeries<G extends { series_id: string; played_at: Date }>(groups: readonly G[], cursor: string | null | undefined, limit: number): { rows: G[]; more: boolean } {
  const at = readRecordCursor(cursor);
  const after = at
    ? groups.filter((g) => g.played_at.getTime() < new Date(at.at).getTime()
      || (g.played_at.getTime() === new Date(at.at).getTime() && g.series_id > at.id))
    : groups;
  return { rows: after.slice(0, limit), more: after.length > limit };
}
