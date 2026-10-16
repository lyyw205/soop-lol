/**
 * 세트 한 판을 부르는 이름 — **모르는 것을 아는 척하지 않는** 단 하나의 규칙 (0035).
 *
 * ★ 왜 한 곳에 두나: 검수 목록·검수 상세·대회 상세·공개 상대전적·개인 기록이 각자
 *   "시리즈가 있으면 N세트, 없으면 단판" 을 따로 적고 있었다. 그러면 대회 상세에서 "세트" 로
 *   보이던 판이 검수 화면을 누르면 다시 "1세트" 가 된다 — 검수자가 임시 순서를 사실로 읽는다.
 *
 * ★ 네 가지를 구분한다.
 *   · 단판   — 원래 한 판짜리다. 시리즈가 없거나(공개 큐·단독 경기) 규정상 한 판(best_of=1).
 *              **수집한 세트가 하나뿐인 것**과는 다르다. Bo3 의 첫 판만 모았어도 하나다.
 *   · 시리즈 미지정 — 아직 시리즈로 묶지 않은 판(한 판짜리 시리즈 `set:<match_id>`, 0089). 단판인지 다전제의 한 판인지
 *              **모른다**(`unassigned`). 2026-10-12 관리자 화면의 "단판" 241경기가 전부 이것이었다 —
 *              확인된 단판(best_of=1)은 0경기. 단판으로 확인하면 경기 ID 와 같은 키의 시리즈에 best_of=1 을 적는다.
 *   · N세트  — 세트 순서를 출처에서 확인했다(set_order_known).
 *   · 세트   — 시리즈의 한 판인 건 아는데 몇 번째인지는 모른다. 시드 생성기는 세트별 승자가
 *              없으면 승리 세트를 앞에 몰아 넣는다(build-meljang) — 그 번호는 우리가 만든 것이다.
 */
export interface SetLabelInput {
  /** 혼자인 시리즈의 단독 경기인가 (isStandaloneSet). */
  standalone: boolean;
  /** 시리즈를 아직 정하지 않은 판인가 — 한 판짜리 시리즈(isUnbundledSet). 넘기지 않으면 단독 경기를 단판으로 본다. */
  unassigned?: boolean;
  best_of: number | null;
  set_order_known: boolean;
  series_game_no: number | null;
  /** 본게임 뒤의 추가 판이면 "bonus" — 방송에서 부른 이름(set_label)으로, 없으면 "보너스" 로 부른다(0079). */
  set_role?: "main" | "bonus" | string | null;
  set_label?: string | null;
  /** 랜드 묶음의 판. 세트가 아니라 "N판" 이다 — 팀이 매 판 바뀌어 시리즈가 아니다(0079). */
  land?: boolean;
}

export function setLabel(s: SetLabelInput): string {
  if (s.set_role === "bonus") return s.set_label?.trim() || "보너스";
  if (s.land) return s.set_order_known && s.series_game_no ? `${s.series_game_no}판` : "판";
  if (s.unassigned) return "시리즈 미지정";
  if (s.standalone || s.best_of === 1) return "단판";
  if (s.set_order_known && s.series_game_no) return `${s.series_game_no}세트`;
  return "세트";
}

/**
 * 한 판짜리 시리즈의 키 — 묶이지 않은 판은 이 키의 시리즈에 혼자 있다(0089 · classification.singleSetSeriesId 와
 * 같은 값이어야 한다 — set-label.test.ts 가 대조한다). 이 모듈은 화면(클라이언트)도 쓰므로 DB 쓰기 모듈을 들이지 않는다.
 */
export const SINGLE_SET_SERIES_PREFIX = "set:";

/**
 * 단독 경기인가 — 판이 혼자인 시리즈. 시드는 단판을 경기 ID 와 같은 이름의 시리즈로 넣고(0035),
 * 묶이지 않은 판은 한 판짜리 시리즈(`set:<match_id>`)에 있다(0089). 시리즈가 없는 판(개인 기록)도 단독이다.
 */
export const isStandaloneSet = (matchId: string, seriesKey: string | null) =>
  seriesKey == null || seriesKey === matchId || seriesKey === SINGLE_SET_SERIES_PREFIX + matchId;

/** 묶이지 않은 판인가 — 한 판짜리 시리즈(`set:<match_id>`)에 혼자 있다. 시리즈를 정하지 않았다는 뜻이다("시리즈 미지정"). */
export const isUnbundledSet = (matchId: string, seriesKey: string | null) =>
  seriesKey === SINGLE_SET_SERIES_PREFIX + matchId;
