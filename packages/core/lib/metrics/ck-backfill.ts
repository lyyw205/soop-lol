import { kstDateString } from '../time.ts';
import { mergeRanges } from './ranges.ts';

export const CK_RECENT_DAYS = 3;
export function recentFrom(now = new Date(), days = CK_RECENT_DAYS): string {
  if (!Number.isInteger(days) || days < 1) throw new Error('days는 양의 정수여야 한다');
  return kstDateString(new Date(now.getTime() - (days - 1) * 86400000));
}
export function backfillUpper(watch: boolean, now = new Date()): Date {
  return watch ? new Date(`${recentFrom(now)}T00:00:00+09:00`) : now;
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
export function beforeCursor(v: VodPosition, upper: Date, cursor?: VodPosition | null): boolean {
  return vodDate(v.ended_at) < upper && (!cursor || newestFirst(v, cursor) > 0);
}
export type ScanRaw = Record<string, any>;
export function isBackfill(raw: ScanRaw): boolean {
  return Object.hasOwn(raw, 'backfill');
}
export function autoQueueReason(raw?: ScanRaw): 'new' | 'lead_only' | 'running' | 'failed_left' | null {
  if (!raw) return 'new';
  if (isBackfill(raw)) return null;
  const scan = raw.scan;
  if (scan?.status === 'done') return scan.failed?.length ? 'failed_left' : null;
  return scan?.status === 'running' ? 'running' : 'lead_only';
}
export function fullScanDone(raw: ScanRaw, apiSeconds: number | null): boolean {
  const total = Number(raw.vod_total_sec ?? apiSeconds);
  const scan = raw.scan;
  const covers = (ranges: unknown[]) => mergeRanges(ranges).some(([a,b]) => a <= 0 && b >= Math.round(total));
  return total > 0 && Number.isFinite(total) && scan?.status === 'done'
    && Array.isArray(scan.failed) && scan.failed.length === 0
    && covers(scan.requested ?? []) && covers(scan.sampled ?? [])
    && Array.isArray(scan.opened) && scan.opened.length > 0;
}
export function processed(raw: ScanRaw, seconds: number | null): boolean {
  return (raw.backfill_access?.status === 'unavailable' && Boolean(raw.backfill_access.reason?.trim()))
    || fullScanDone(raw, seconds);
}
export function fitsBudget(count: number, seconds: number, duration: number | null, limit: number, maxSeconds: number): boolean {
  if (count >= limit) return false;
  if (duration == null || duration > maxSeconds) return count === 0;
  return seconds + duration <= maxSeconds;
}
