import assert from "node:assert/strict";
import {test} from "node:test";
import {schedulerEvents,scheduleWindow} from "../apps/web/components/admin/office/timetable.ts";
import {JOBS,type Job} from "../packages/core/lib/ops/model.ts";
const now=Date.parse("2026-10-14T14:30:00Z"); // 23:30 KST
const job:Job={...JOBS[0],state:"healthy",cadence:"10분마다",message:"",lastAt:null,lastSuccessAt:null,nextAt:"2026-10-14T14:40:00Z",processed:0,evidence:"test"};
test("KST midnight separates today's and tomorrow's schedules",()=>{
 assert.equal(scheduleWindow(now,"today").end,Date.parse("2026-10-14T15:00:00Z"));
 const today=schedulerEvents([job],now,"today");assert.equal(today.length,2);assert.equal(today[0].estimated,false);assert.equal(today[1].estimated,true);
 const tomorrow=schedulerEvents([job],now,"tomorrow");assert.equal(tomorrow.length,144);assert.equal(tomorrow[0].at,Date.parse("2026-10-14T15:00:00Z"));assert.ok(tomorrow.every(e=>e.estimated));
});
test("never invents future runs from stopped, unknown, event-based or overdue observations",()=>{
 for(const state of ["paused","unknown","unconfigured"] as const)assert.equal(schedulerEvents([{...job,state}],now,"24h").length,0);
 for(const change of [{nextAt:null},{nextAt:"invalid"},{nextAt:"2026-10-14T14:00:00Z"},{trigger:"path" as const}])assert.equal(schedulerEvents([{...job,...change}],now,"24h").length,0);
});
test("unknown repeat rules retain only the observed next run; order is chronological",()=>{
 const events=schedulerEvents([{...job,id:"a",cadence:"워커 루프"},{...job,id:"b",cadence:"워커 루프",nextAt:"2026-10-14T14:35:00Z"}],now,"24h");assert.deepEqual(events.map(e=>e.job.id),["b","a"]);assert.ok(events.every(e=>!e.estimated));
});
