/**
 * 관리 화면의 상태 용어 — **한 곳에서만 정한다.**
 *
 * 화면마다 따로 적었더니 같은 것을 다르게 불렀다: 목록은 "탐색 완료", 검수대는 "스캔 완료",
 * 같은 `scan.failed` 를 "못 본 구간" / "판독 누락", 나무위키 시드를 "수기" / "시드",
 * 분류는 CK 쪽 "이벤트·스크림" / FC 쪽 "이벤트전·연습".
 *
 * 사람 검수 화면이 쓰는 상태는 두 축이다. 하나의 "검수 단계" 로 합쳐 읽지 않는다.
 *   관리자 확인 (match.reviewed_at)  사람이 고치거나 확인해서 **자동 갱신을 막았나**
 *   공개 여부  (match.visibility)    공개 화면과 집계에 넣는가
 * 탐색 상태·후보 결론 같은 조사 상태는 사람 화면에 없다 — CLI(`npm run ck:record`)가 보여준다.
 */

/** 행사 분류(event.kind). CK 조사와 FC 판정이 같은 값을 쓴다. */
export const EVENT_KIND_LABEL: Record<string, string> = {
  ck: "CK", land: "랜드", tournament: "대회", showmatch: "이벤트", scrim: "스크림", other: "기타",
};

/**
 * match.reviewed_at. **모든 칸을 검수했다는 뜻이 아니다** — KDA 한 칸만 고쳐도, 근거만 고쳐도 찍힌다.
 * 뜻은 "관리자가 손댄 경기라 자동 수집이 덮어쓰지 않는다" 이다.
 */
export const REVIEWED_LABEL = "관리자 확인";
export const REVIEWED_HINT = "관리자가 고치거나 확인한 경기입니다. 자동 수집이 이 경기를 덮어쓰지 않습니다. 모든 칸을 검수했다는 뜻은 아닙니다.";

/**
 * 이 경기를 **어떻게 알게 됐나**(관리 화면용). 공개 화면은 source(API/수기)만 쓴다.
 * ★ API 경기는 origin 이 없다 — "origin 이 없으면 시드" 로 두면 API 경기가 시드로 보인다.
 */
export function matchOriginLabel(m: { origin: string | null; source: string | null }): string {
  if (m.source === "provider_api" || m.source === "public_queue") return "API";
  if (m.origin === "wiki_seed") return "나무위키 시드";
  if (m.origin === "admin") return "검수에서 생성";
  if (m.origin === "vod_scan") return "VOD 판독";
  return "출처 미상";
}

/** FC 검수 단위의 판정 상태. */
export const FCO_STATUS_LABEL: Record<string, string> = {
  uninvestigated: "미조사", unresolved: "미해결", casual: "단순 친선", event: "행사",
};
