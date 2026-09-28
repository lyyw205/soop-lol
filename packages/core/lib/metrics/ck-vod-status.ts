/**
 * VOD 조사 도장 — 「이 VOD 를 다시 봐야 하나」의 단일 출처.
 *
 * ★ 자동 조사(ck:queue)와 수동 백필(ck:backfill)이 **같은 함수**를 쓴다.
 *   예전엔 자동은 `done` 만, 백필은 「영상 길이까지 정확히 덮었나」까지 봐서
 *   자동이 끝낸 VOD 를 백필이 1초 차이로 미완료로 보고 12시간짜리를 다시 조사했다.
 *
 * ★ 정본은 `event_lead.raw` 하나다. 커서·백필 표시 같은 두 번째 진척 기록을 두지 않는다.
 */
import { kstDateString } from '../time.ts';
import { coveredSeconds, mergeRanges, subtractRanges, type Range } from './ranges.ts';

export const CK_RECENT_DAYS = 3;
/** 자동 조사 창의 첫 KST 날짜(오늘 포함 days 일). */
export function recentFrom(now = new Date(), days = CK_RECENT_DAYS): string {
  if (!Number.isInteger(days) || days < 1) throw new Error('days는 양의 정수여야 한다');
  return kstDateString(new Date(now.getTime() - (days - 1) * 86400000));
}

export function vodDate(value: string): Date {
  // SOOP 목록의 timezone 없는 시각은 KST다.
  const iso = value.replace(' ', 'T');
  const date = new Date(/[zZ]$|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}+09:00`);
  if (!Number.isFinite(date.getTime())) throw new Error(`잘못된 VOD 시각: ${value}`);
  return date;
}
export interface VodPosition { ended_at: string; title_no: number }
export function newestFirst(a: VodPosition, b: VodPosition): number {
  return vodDate(b.ended_at).getTime() - vodDate(a.ended_at).getTime() || b.title_no - a.title_no;
}

/**
 * 영상 **끝** 경계에서만 허용하는 오차(초).
 * 목록 API 길이(ms 반올림)와 조사 도구 길이(초 내림)가 다르다. 실측 250여 건에서 차이는 0~1초였다.
 * ⚠ 중간의 빈 구간·실패 구간에는 적용하지 않는다 — 못 본 곳을 완료로 덮지 않는다.
 */
export const END_TOLERANCE_SEC = 5;

export type ScanRaw = Record<string, any>;
/** 다시 봐야 하는 이유. null 이면 완료 또는 확인된 접근 불가. */
export type VodReason = 'new' | 'lead_only' | 'running' | 'failed_left' | 'partial';
export interface VodWork {
  reason: VodReason | null;
  unavailable: boolean;
  /** 요청 범위가 아직 덮지 못한 초. 길이를 모르면 null. */
  uncovered: number | null;
  failed: number;
  unresolved: number;
}

/** 확인된 삭제·비공개. 근거 없는 표시는 인정하지 않는다. */
export function isUnavailable(raw?: ScanRaw): boolean {
  return raw?.access?.status === 'unavailable' && Boolean(String(raw.access.reason ?? '').trim());
}

/**
 * VOD 한 개의 남은 일.
 * `apiSeconds` 는 목록 API 가 준 길이다. 조사 때 기록한 `raw.vod_total_sec` 가 있으면 그게 우선이다.
 */
export function vodWork(raw: ScanRaw | undefined, apiSeconds: number | null): VodWork {
  const scan = raw?.scan;
  const known = Number(raw?.vod_total_sec ?? apiSeconds);
  const total = Number.isFinite(known) && known > 0 ? Math.round(known) : null;
  const requested = mergeRanges(scan?.requested ?? []);
  const failed = coveredSeconds(scan?.failed ?? []);
  const unresolved = Array.isArray(raw?.candidates)
    ? raw!.candidates.filter((c: any) => c?.conclusion === 'unresolved').length : 0;
  // 끝 오차만 허용: [0, total - 허용] 을 요청 범위에서 빼고 남는 게 있으면 덜 본 것이다.
  // 구간은 양끝 포함 정수 초라 [5,5] 도 1초다(coveredSeconds 는 길이라 0 으로 센다).
  const uncovered = total == null ? null
    : subtractRanges([[0, Math.max(0, total - END_TOLERANCE_SEC)] as Range], requested)
        .reduce((sum, [a, b]) => sum + b - a + 1, 0);
  const work = { unavailable: isUnavailable(raw), uncovered, failed, unresolved };
  if (work.unavailable) return { ...work, reason: null };
  if (!raw) return { ...work, reason: 'new' };
  const status = scan?.status;
  if (status === 'running') return { ...work, reason: 'running' };
  if (status !== 'done' && status !== 'failed') return { ...work, reason: 'lead_only' };
  if (status === 'failed' || (scan.failed?.length ?? 0) > 0) return { ...work, reason: 'failed_left' };
  // done 선언만 믿지 않는다: 실제로 연 화면이 있고, 요청 범위가 영상 끝까지 이어져야 한다.
  const complete = Array.isArray(scan.opened) && scan.opened.length > 0 && uncovered === 0;
  return { ...work, reason: complete ? null : 'partial' };
}

/**
 * 한 번의 조사 세션이 실제로 남은 일을 줄였나.
 * 도장(status)이 그대로여도 running 2시간 → 4시간이면 진척이다. 메모·시각만 바뀐 건 진척이 아니다.
 */
export function madeProgress(before: VodWork, after: VodWork): boolean {
  if (after.reason === null && before.reason !== null) return true;
  if (after.unavailable && !before.unavailable) return true;
  if (before.uncovered == null ? after.uncovered != null : after.uncovered != null && after.uncovered < before.uncovered) return true;
  return after.failed < before.failed || after.unresolved < before.unresolved;
}
