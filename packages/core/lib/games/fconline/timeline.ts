/**
 * FC 경기 ↔ VOD 시간축 (실측: docs/FCO-TIME-SAMPLES.md).
 *   경기 시작 = 넥슨 matchId 앞 8자리(16진 유닉스 초). 경기 종료 = matchDate.
 *   VOD 시작 = SOOP vodDetail.broad_start(방송 시작 그대로 — 등록시각−길이로 추정하지 않는다).
 * 조사 도구(fco:context locate)와 검수 화면이 같은 계산을 쓴다.
 */

/** 넥슨 matchId 앞 8자리 = 경기 시작 유닉스 초. 형식이 아니면 null. */
export function fcoMatchStartMs(providerMatchId: string): number | null {
  const head = providerMatchId.slice(0, 8);
  if (!/^[0-9a-f]{8}$/i.test(head)) return null;
  return parseInt(head, 16) * 1000;
}

export interface FcoVodSpan { vod: number; startMs: number; lengthSec: number }

/** 경기의 시작·종료가 VOD 몇 초인가. 종료가 VOD 안에 없으면 null(다른 VOD 를 본다). */
export function fcoVodOffsets(
  match: { provider_match_id: string; played_at: string },
  vod: FcoVodSpan,
): { start: number | null; end: number } | null {
  const endMs = Date.parse(match.played_at);
  const end = Math.round((endMs - vod.startMs) / 1000);
  if (end < 0 || end > vod.lengthSec) return null;
  const startMs = fcoMatchStartMs(match.provider_match_id);
  const start = startMs == null ? null : Math.round((startMs - vod.startMs) / 1000);
  return { start: start != null && start >= 0 ? start : null, end };
}

/**
 * 조사가 뽑을 지점. 4종은 보정한 초기값이고(시작 −30/+15, 종료 +10/+45) 판정 규칙이 아니다.
 * 결과 화면은 [종료 −20, 종료 +60] 을 5분할로 시작해 좁힌다 — 방송이 결과창을 비추는 몇 초를 잡는다.
 */
export function fcoProbePlan(o: { start: number | null; end: number }, lengthSec: number) {
  const clamp = (x: number) => Math.max(0, Math.min(lengthSec, x));
  return {
    pre: o.start != null ? clamp(o.start - 30) : null,
    start: o.start != null ? clamp(o.start + 15) : null,
    end: clamp(o.end + 10),
    post: clamp(o.end + 45),
    result: [clamp(o.end - 20), clamp(o.end + 60)] as [number, number],
  };
}
