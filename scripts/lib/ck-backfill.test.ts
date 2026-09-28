import {test} from 'node:test';
import assert from 'node:assert/strict';
import {historicalVods,type BroadcastList} from './ck-backfill.ts';
const v=(id:number,day:string)=>({title_no:id,ended_at:`${day} 12:00:00`,title:'test',channel_id:'c',hours:1,url:'https://vod.test/'+id});
async function all<T>(it:AsyncGenerator<T>) {const out=[];for await(const x of it)out.push(x);return out;}
test('경계 날짜 전체를 조회하고 같은 날짜의 cursor 뒤부터 재개한다',async()=>{
 const calls:unknown[]=[];
 const rows=[v(3,'2026-09-20'),v(2,'2026-09-20'),v(1,'2026-09-18')];
 const result=await all(historicalVods('c',new Date('2026-09-21T00:00:00+09:00'),rows[0],async(_,opts)=>{
  calls.push(opts);
  return rows.filter(r=>r.ended_at.slice(0,10)<=opts.to! && (!opts.from||r.ended_at.slice(0,10)>=opts.from)) as BroadcastList;
 }));
 assert.deepEqual(result.map(r=>r.title_no),[2,1]);
 assert.ok(calls.some((x:any)=>x.from==='2026-09-20'&&x.to==='2026-09-20'));
});
test('날짜 조회가 잘리면 확보된 일부 행도 넘기지 않는다',async()=>{
 await assert.rejects(all(historicalVods('c',new Date('2026-09-21'),null,async(_,opts)=>
  Object.assign([v(3,'2026-09-20')],{truncated:!!opts.from}))),/불완전/);
});
test('오류 빈 목록은 소진이 아니다',async()=>{
 await assert.rejects(all(historicalVods('c',new Date(),null,async()=>Object.assign([],{truncated:true}))),/실패/);
});
