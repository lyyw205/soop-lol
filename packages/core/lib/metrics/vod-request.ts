/**
 * VOD 판독 요청(0097)의 규칙 — 단일 출처. docs/SUBMISSION-POLICY-PLAN.md §6
 * DB 를 모르는 순수 함수다. 웹(요청 쓰기)과 이 PC 의 ck-auto(요청 읽기)가 같은 것을 쓴다.
 */
export const VOD_REQUEST_REASONS = ["submission", "admin"] as const;
export type VodRequestReason = (typeof VOD_REQUEST_REASONS)[number];

export const VOD_REQUEST_STATES = ["queued", "claimed", "done", "unavailable", "cancelled"] as const;
export type VodRequestState = (typeof VOD_REQUEST_STATES)[number];
export const VOD_REQUEST_OPEN: readonly VodRequestState[] = ["queued", "claimed"];

export const VOD_REQUEST_STATE_LABEL: Record<VodRequestState, string> = {
  queued: "요청됨", claimed: "판독 대기열", done: "판독 끝", unavailable: "영상 없음", cancelled: "거둠",
};

/**
 * 우선순위 — 클수록 먼저. 회원 제보가 운영자 요청보다 앞이다(회원이 "검증 전" 표시를 보며 기다린다).
 * 요청 없는 매일 조사는 0 — 어떤 요청보다 뒤, 그 안에서는 오래된 순서(ck-auto-queue claim).
 */
export const VOD_REQUEST_PRIORITY: Record<VodRequestReason, number> = { submission: 100, admin: 50 };

/**
 * SOOP VOD 링크(또는 번호) → VOD 번호. 아니면 null.
 * 받는 모양: vod.sooplive.com|vod.sooplive.co.kr|vod.afreecatv.com/player/<번호>[/embed|/catch][?…], v.afree.ca/ST/<번호>, 숫자만.
 */
export function soopVodId(raw: string | null | undefined): number | null {
  const s = String(raw ?? "").trim();
  if (/^[1-9]\d{0,14}$/.test(s)) return safe(s);
  let url: URL;
  try { url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); } catch { return null; }
  const host = url.hostname.toLowerCase();
  let m: RegExpExecArray | null = null;
  if (["vod.sooplive.com", "vod.sooplive.co.kr", "vod.afreecatv.com"].includes(host)) {
    m = /^\/player\/([1-9]\d{0,14})(?:\/(?:embed|catch))?\/?$/i.exec(url.pathname);
  } else if (host === "v.afree.ca") {
    m = /^\/ST\/([1-9]\d{0,14})\/?$/i.exec(url.pathname);
  }
  return m ? safe(m[1]) : null;
}

const safe = (s: string) => { const n = Number(s); return Number.isSafeInteger(n) ? n : null; };
