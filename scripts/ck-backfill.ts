/** 셸 래퍼가 잠금을 보유한 상태에서 plan/checkpoint/access를 호출한다. status는 읽기 전용. */
import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { closeDb } from '@soop-lol/core/lib/db/client';
import { resolveBackfillTarget, getBackfillProgress, ensureBackfillProgress, markedBackfillVods,
  backfillLeads, markBackfillVod, reconcileBackfill, setBackfillExhausted, recordBackfillAccess,
  type BackfillVod } from '@soop-lol/core/lib/db/ck-backfill';
import { fitsBudget, processed, fullScanDone } from '@soop-lol/core/lib/metrics/ck-backfill';
import { historicalVods } from './lib/ck-backfill.ts';
import { listBroadcasts, vodDetail } from './lib/soop-vod.mjs';

const {values,positionals} = parseArgs({allowPositionals:true,options:{
  streamer:{type:'string'},limit:{type:'string',default:'5'},'max-video-hours':{type:'string',default:'20'},
  write:{type:'string'},vod:{type:'string'},status:{type:'string'},reason:{type:'string'},help:{type:'boolean'},
}});
const command=positionals[0] ?? 'status';
async function run() {
  if(values.help) { console.log('ck:backfill status --streamer <이름>\n실행: scripts/ck-backfill.sh --streamer <이름> [--limit 5] [--max-video-hours 20]\n접근 불가: ck:backfill access --streamer <이름> --vod <번호> --status temporary|unavailable|retry --reason <근거>'); return; }
  if(!['status','plan','checkpoint','access'].includes(command) || !values.streamer) throw new Error('명령과 --streamer가 필요하다 (--help)');
  if(command!=='status' && process.env.CK_BACKFILL_LOCKED!=='1') throw new Error('변경 명령은 scripts/ck-backfill.sh의 잠금 안에서 실행해야 한다');
  const target=await resolveBackfillTarget(values.streamer);
  if(command==='status') {
    const p=await getBackfillProgress(target.channel_id);
    const items=p ? await markedBackfillVods(p) : [];
    console.log(JSON.stringify({target,progress:p,pending:items.filter(v=>!processed(v.raw,v.duration_sec)),unavailable:items.filter(v=>v.raw.backfill_access?.status==='unavailable')},null,2)); return;
  }
  if(command==='checkpoint') {
    const progress=await reconcileBackfill(target.channel_id);
    const items=progress ? await markedBackfillVods(progress):[];
    console.log(JSON.stringify({progress,pending:items.filter(v=>!processed(v.raw,v.duration_sec)).map(v=>({vod:v.title_no,scan:v.raw.scan,access:v.raw.backfill_access})),unavailable:items.filter(v=>v.raw.backfill_access?.status==='unavailable').map(v=>({vod:v.title_no,access:v.raw.backfill_access}))},null,2)); return;
  }
  if(command==='access') {
    const p=await getBackfillProgress(target.channel_id);
    const vod=Number(values.vod), status=values.status;
    if(!p || !Number.isSafeInteger(vod) || vod<=0 || !['temporary','unavailable','retry'].includes(status??'')) throw new Error('진행·VOD 번호·접근 상태를 확인할 것');
    await recordBackfillAccess(p,vod,status as 'temporary'|'unavailable'|'retry',values.reason??'');return;
  }
  const limit=Number(values.limit), maxSeconds=Number(values['max-video-hours'])*3600;
  if(!Number.isInteger(limit)||limit<1||!Number.isFinite(maxSeconds)||maxSeconds<=0||!values.write) throw new Error('양의 limit/max-video-hours와 --write 필요');
  await ensureBackfillProgress(target);
  const p=(await reconcileBackfill(target.channel_id))!;
  const pending=(await markedBackfillVods(p)).filter(v=>!processed(v.raw,v.duration_sec));
  const queue:BackfillVod[]=[];
  let total=0, blocked:string|null=null, reused=0, exhausted=false;
  const add=(v:BackfillVod)=>{
    if(!fitsBudget(queue.length,total,v.duration_sec,limit,maxSeconds)) return false;
    queue.push(v);total+=v.duration_sec??maxSeconds;return true;
  };
  // 이전에 큐를 만든 뒤 죽은 항목이 있으면 목록 조회보다 먼저 재개한다.
  if(pending.length) {
    for(const {raw:_raw,...v} of pending) if(!add(v)) break;
  } else if(!p.exhausted) {
    const cursor=p.cursor_at ? {ended_at:p.cursor_at.toISOString(),title_no:Number(p.cursor_vod)}:null;
    try {
      let stopped=false;
      for await (const v of historicalVods(target.channel_id,p.upper_before,cursor,listBroadcasts)) {
        const lead=(await backfillLeads([`vod:${v.title_no}`])).get(`vod:${v.title_no}`);
        if(target.watch && lead?.raw.scan?.status==='running' && !Object.hasOwn(lead.raw,'backfill')) {
          blocked=`자동 실행의 running VOD ${v.title_no}에서 중단. 다음 요청에 완료 여부를 확인한다.`;stopped=true;break;
        }
        if(fullScanDone(lead?.raw??{},v.duration_sec)) {
          await markBackfillVod(p,target,v);reused++;continue;
        }
        if(v.duration_sec==null) {
          // 실패를 삭제로 단정하지 않는다. 길이 미상은 단독 선택한다.
          try { const detail=await vodDetail(String(v.title_no));
            const ms=(detail?.files??[]).reduce((sum:number,f:{duration?:number})=>sum+(f.duration??0),0);
            if(ms>0) v.duration_sec=Math.round(ms/1000);
          } catch { /* 로그에 길이 미상으로 남긴다 */ }
        }
        if(!fitsBudget(queue.length,total,v.duration_sec,limit,maxSeconds)) {stopped=true;break;}
        await markBackfillVod(p,target,v);
        add(v);
        if(queue.length>=limit || total>=maxSeconds || v.duration_sec==null) {stopped=true;break;}
      }
      exhausted=!stopped;
    } catch(e) {blocked=String(e);}
  }
  // 목록을 끝까지 보았더라도 미조사 queue가 있으면 다음 요청에서 소진을 다시 확인한다.
  await reconcileBackfill(target.channel_id);
  if(exhausted && !queue.length) await setBackfillExhausted(p.id);
  const result={target,progress:await getBackfillProgress(target.channel_id),generated_at:new Date().toISOString(),
    limit,max_video_hours:maxSeconds/3600,selected_video_hours:total/3600,reused,blocked,queue};
  mkdirSync(dirname(values.write),{recursive:true});writeFileSync(values.write,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
  if(blocked && !queue.length) process.exitCode=2;
}
try {await run();} catch(e) {console.error(e instanceof Error?e.message:e);process.exitCode=1;} finally {await closeDb();}
