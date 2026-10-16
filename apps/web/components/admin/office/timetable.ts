import type { Job } from "@soop-lol/core/lib/ops/model";
export type ScheduleRange = "today" | "tomorrow" | "24h";
export interface ScheduledEvent { job: Job; at: number; estimated: boolean }
const DAY=86400000;
export function scheduleWindow(now:number,range:ScheduleRange) {
  const midnight=Math.floor((now+9*3600000)/DAY)*DAY-9*3600000;
  return range==="tomorrow" ? {start:midnight+DAY,end:midnight+2*DAY} : {start:now,end:range==="today"?midnight+DAY:now+DAY};
}
function interval(cadence:string) {
  if(cadence==="매일")return DAY;
  if(cadence==="매시간")return 3600000;
  const match=/^(\d+)(분|시간)마다$/.exec(cadence);
  return match ? Number(match[1])*(match[2]==="분"?60000:3600000) : null;
}
export function schedulerEvents(jobs:Job[],now:number,range:ScheduleRange) {
  const {start,end}=scheduleWindow(now,range),events:ScheduledEvent[]=[];
  for(const job of jobs) {
    if(["paused","unconfigured","unknown"].includes(job.state)||!job.nextAt||job.trigger==="path")continue;
    const first=Date.parse(job.nextAt);
    if(!Number.isFinite(first)||first<now)continue; // An overdue observation is not a new schedule anchor.
    const step=interval(job.cadence);
    let at=first;
    if(step&&at<start)at+=Math.ceil((start-at)/step)*step;
    for(let n=0;at<end&&n<300;n++) {
      if(at>=start)events.push({job,at,estimated:at!==first});
      if(!step)break;
      at+=step;
    }
  }
  return events.sort((a,b)=>a.at-b.at||a.job.name.localeCompare(b.job.name,"ko"));
}
