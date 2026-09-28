import { kstDateString } from '@soop-lol/core/lib/time';
import { newestFirst, vodDate } from '@soop-lol/core/lib/metrics/ck-vod-status';
import type { BackfillVod } from '@soop-lol/core/lib/db/ck-backfill';

interface ListVod { title_no:number; ended_at:string; title:string; channel_id:string; hours:number; url:string }
export type BroadcastList = ListVod[] & {truncated?:boolean};
export type ListBroadcasts = (channel:string, opts:{from?:string;to?:string;maxPages?:number})=>Promise<BroadcastList>;

/** 한 번의 조회가 받을 수 있는 페이지 상한(페이지당 60개). 넘으면 잘린 것으로 보고 멈춘다. */
export const MAX_PAGES = 200;

/**
 * 기간(KST, VOD 종료일 기준) 안의 VOD 전부를 최신순으로.
 *
 * ★ SOOP 목록 API 는 **startDate·endDate 를 둘 다 줄 때만** 날짜로 거른다.
 *   한쪽만 주면 필터 없이 채널 전체를 최신순으로 돌려준다(2026-09-28 실측).
 *   예전 백필은 endDate 만 보내 첫날 이후 전부 "상한 밖 VOD" 오류로 멈췄다.
 * ★ 잘린 목록은 오류다. 일부만 받은 채 "기간 전체를 봤다" 고 하지 않는다.
 */
export async function listRange(channel:string, from:string, to:string, list:ListBroadcasts): Promise<BackfillVod[]> {
  if (!/^\d{4}-\d\d-\d\d$/.test(from) || !/^\d{4}-\d\d-\d\d$/.test(to) || from > to) throw new Error(`잘못된 기간: ${from} ~ ${to}`);
  const rows = await list(channel,{from,to,maxPages:MAX_PAGES});
  if (rows.truncated) throw new Error(`${from} ~ ${to} 목록이 잘렸다(조회 실패 또는 ${MAX_PAGES}페이지 초과). 기간을 나눠 요청할 것`);
  const seen = new Set<number>();
  const out: BackfillVod[] = [];
  for (const v of rows) {
    if (!Number.isSafeInteger(v.title_no) || v.title_no <= 0) throw new Error('잘못된 VOD 목록 응답');
    const day = kstDateString(vodDate(v.ended_at));
    // 필터가 무시됐다는 신호다. 받은 걸 믿고 진행하지 않는다.
    if (day < from || day > to) throw new Error(`API가 요청 기간 밖의 VOD를 반환했다: ${v.title_no} (${day})`);
    if (seen.has(v.title_no)) continue;
    seen.add(v.title_no);
    out.push({ title_no:v.title_no, ended_at:vodDate(v.ended_at).toISOString(), title:v.title, channel_id:channel, url:v.url,
      duration_sec: v.hours>0 && Number.isFinite(v.hours) ? Math.round(v.hours*3600) : null });
  }
  return out.sort(newestFirst);
}
