import { kstDateString } from '@soop-lol/core/lib/time';
import { beforeCursor, newestFirst, vodDate, type VodPosition } from '@soop-lol/core/lib/metrics/ck-backfill';
import type { BackfillVod } from '@soop-lol/core/lib/db/ck-backfill';

interface ListVod { title_no:number; ended_at:string; title:string; channel_id:string; hours:number; url:string }
export type BroadcastList = ListVod[] & {truncated?:boolean};
export type ListBroadcasts = (channel:string, opts:{from?:string;to?:string;maxPages?:number})=>Promise<BroadcastList>;
/** 날짜 경계는 다시 읽는다. 날짜 전체를 확보하기 전에는 그날의 행을 yield하지 않는다. */
export async function* historicalVods(channel:string, upper:Date, cursor:VodPosition|null, list:ListBroadcasts): AsyncGenerator<BackfillVod> {
  let to=kstDateString(cursor ? vodDate(cursor.ended_at) : new Date(upper.getTime()-1));
  while (true) {
    const peek=await list(channel,{to,maxPages:1});
    if (!peek.length) {
      if (peek.truncated) throw new Error('목록 조회 실패. 소진으로 처리하지 않는다.');
      return;
    }
    const latest=[...peek].sort(newestFirst)[0];
    const day=kstDateString(vodDate(latest.ended_at));
    if (day>to) throw new Error('API가 요청한 날짜 상한 밖의 VOD를 반환했다');
    const full=await list(channel,{from:day,to:day,maxPages:40});
    if (full.truncated || !full.length || !full.some(v=>v.title_no===latest.title_no)) throw new Error(`${day} 목록이 불완전하다. 이 날짜를 건너뛰지 않는다.`);
    const seen=new Set<number>();
    for (const v of [...full].sort(newestFirst)) {
      if (!Number.isSafeInteger(v.title_no) || v.title_no<=0 || kstDateString(vodDate(v.ended_at))!==day) throw new Error('잘못된 VOD 목록 응답');
      if (seen.has(v.title_no) || !beforeCursor(v,upper,cursor)) continue;
      seen.add(v.title_no);
      yield {title_no:v.title_no, ended_at:vodDate(v.ended_at).toISOString(), title:v.title,channel_id:channel,
        url:v.url, duration_sec:v.hours>0 && Number.isFinite(v.hours) ? Math.round(v.hours*3600) : null};
    }
    to=kstDateString(new Date(new Date(`${day}T00:00:00+09:00`).getTime()-1));
  }
}
