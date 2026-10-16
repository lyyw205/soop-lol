import assert from "node:assert/strict";
import { test } from "node:test";
import { jobDialogue, placeSpeech } from "../apps/web/components/admin/office/dialogue.ts";
import { JOBS, type Job } from "../packages/core/lib/ops/model.ts";
const now=Date.parse("2026-10-14T10:00:00Z");
const job:Job={...JOBS.find(j=>j.id==="fco-matches")!,state:"healthy",message:"최근 실행 성공",lastAt:new Date(now-48*60000).toISOString(),lastSuccessAt:new Date(now-47*60000).toISOString(),nextAt:new Date(now+13*60000).toISOString(),processed:12,evidence:"DB"};
test("one worker speaks about its own completion and known next schedule",()=>{
  assert.deepEqual(jobDialogue(job,{recent:[]},now,false),["47분 전에 FC 경기 동기화를 마쳤어요.","13분 후에 다시 동기화할 예정이에요."]);
});
test("another job's completion never becomes this worker's history",()=>{
  const lines=jobDialogue({...job,lastSuccessAt:null},{recent:[{id:"x",job:"other",state:"ok",startedAt:new Date(now).toISOString(),finishedAt:new Date(now).toISOString(),processed:3,error:null}]},now,false);
  assert.match(lines[0],/완료 기록이 없어요/);
});
test("missing and expired schedules never promise a made-up next run",()=>{
  assert.match(jobDialogue({...job,nextAt:null},null,now,false)[1],/아직 전달받지/);
  assert.match(jobDialogue({...job,nextAt:new Date(now-60000).toISOString()},null,now,false)[1],/예정 시각이 지났어요/);
});
test("paused, working and disconnected dialogue reflects observed state",()=>{
  assert.match(jobDialogue({...job,state:"paused"},null,now,false).join(" "),/쉬고 있을게요/);
  assert.match(jobDialogue({...job,state:"working"},null,now,false)[0],/진행하고 있어요/);
  assert.match(jobDialogue(job,null,now,true).join(" "),/현재 상태는 알 수 없어요/);
});
test("all 14 crowded speakers fit without overlap at desktop sizes",()=>{
  for(const [w,h] of [[1318,830],[1158,640],[1000,600]]) {
    const boxes=placeSpeech(Array.from({length:14},(_,i)=>({id:String(i),anchorX:w/2+(i%4)*18,anchorY:h/2+Math.floor(i/4)*15,width:218,height:i%3===0?100:82})),w,h);
    for(const a of boxes){assert.ok(a.x>=0&&a.y>=0&&a.x+a.width<=w&&a.y+a.height<=h,`bounds at ${w}x${h}`);for(const b of boxes){if(a.id===b.id)continue;assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y,"no overlapping speech");}}
  }
});

test("quiet office caps ambient speech and hover takes precedence",async()=>{
  const {speakingJobs}=await import("../apps/web/components/admin/office/dialogue.ts");
  const jobs:Job[]=JOBS.map(spec=>({...job,...spec,state:"healthy" as const,lastSuccessAt:new Date(now-3600000).toISOString()}));
  assert.deepEqual(speakingJobs(jobs,now,null,false),[]);
  jobs[0].state="failed";
  jobs[3].state="delayed";
  assert.equal(speakingJobs(jobs,now,null,false).length,2);
  assert.deepEqual(speakingJobs(jobs,now,jobs[5].id,false),[jobs[5].id]);
  assert.deepEqual(speakingJobs(jobs,now,null,true),[]);
});
