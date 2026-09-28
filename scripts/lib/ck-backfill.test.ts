import {test} from 'node:test';
import assert from 'node:assert/strict';
import {listRange,type BroadcastList} from './ck-backfill.ts';
const v=(id:number,day:string)=>({title_no:id,ended_at:`${day} 12:00:00`,title:'test',channel_id:'c',hours:1,url:'https://vod.test/'+id});
/** 실제 SOOP 처럼: 양쪽 날짜가 다 있어야 거른다. */
const soop=(rows:ReturnType<typeof v>[])=>async(_:string,o:{from?:string;to?:string})=>
 (o.from&&o.to ? rows.filter(r=>r.ended_at.slice(0,10)>=o.from!&&r.ended_at.slice(0,10)<=o.to!) : rows) as BroadcastList;
test('기간 안 VOD를 최신순으로, 중복 없이 준다',async()=>{
 const rows=[v(1,'2026-09-18'),v(3,'2026-09-20'),v(2,'2026-09-20'),v(3,'2026-09-20'),v(9,'2026-09-25')];
 assert.deepEqual((await listRange('c','2026-09-18','2026-09-20',soop(rows))).map(r=>r.title_no),[3,2,1]);
});
test('시작·끝 날짜를 항상 둘 다 보낸다',async()=>{
 const calls:any[]=[];
 await listRange('c','2026-09-01','2026-09-30',async(_,o)=>{calls.push(o);return [] as BroadcastList;});
 assert.equal(calls[0].from,'2026-09-01');assert.equal(calls[0].to,'2026-09-30');
});
test('필터가 무시된 응답(기간 밖 VOD)은 거부한다',async()=>{
 await assert.rejects(listRange('c','2026-09-18','2026-09-18',async()=>[v(9,'2026-09-25')] as BroadcastList),/기간 밖/);
});
test('잘린 목록은 일부라도 넘기지 않는다',async()=>{
 await assert.rejects(listRange('c','2026-09-18','2026-09-20',async()=>Object.assign([v(1,'2026-09-19')],{truncated:true})),/잘렸다/);
});
test('잘못된 기간은 조회하지 않는다',async()=>{
 await assert.rejects(listRange('c','2026-09-20','2026-09-18',async()=>{throw new Error('called');}),/잘못된 기간/);
});
