"use client";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { CalendarDays, ChevronRight, X } from "lucide-react";
import { ROOMS, STATE_LABEL, type Job, type Snapshot } from "@soop-lol/core/lib/ops/model";
import { schedulerEvents, type ScheduleRange } from "./timetable";
const clock=(at:number)=>new Date(at).toLocaleTimeString("ko-KR",{timeZone:"Asia/Seoul",hour:"2-digit",minute:"2-digit",hour12:false});
const date=(at:number)=>new Date(at).toLocaleDateString("ko-KR",{timeZone:"Asia/Seoul",month:"long",day:"numeric",weekday:"short"});
export function SchedulerBoard({data,now,disconnected,close,select}:{data:Snapshot|null;now:number;disconnected:boolean;close:()=>void;select:(job:Job)=>void}) {
  const [range,setRange]=useState<ScheduleRange>("today"),[department,setDepartment]=useState("all"),[repeats,setRepeats]=useState(true);
  const panel=useRef<HTMLDivElement>(null),closeRef=useRef(close);closeRef.current=close;
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key=(e:KeyboardEvent)=>{if(e.key==="Escape"){e.preventDefault();closeRef.current();}if(e.key==="Tab"){const nodes=panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select,input,a[href]');if(!nodes?.length)return;const first=nodes[0],last=nodes[nodes.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}};
    document.addEventListener("keydown",key);return()=>{document.removeEventListener("keydown",key);previous?.focus();};
  },[]);
  const jobs=useMemo(()=>(data?.jobs??[]).filter(j=>department==="all"||j.room===department),[data,department]);
  const events=schedulerEvents(jobs,now,range).filter(e=>repeats||!e.estimated);
  const groups=new Map<string,typeof events>();
  for(const event of events){const hour=Math.floor((event.at+9*3600000)/3600000);const key=String(hour);groups.set(key,[...(groups.get(key)??[]),event]);}
  const unscheduled=jobs.filter(j=>["paused","unconfigured","unknown"].includes(j.state)||!j.nextAt||Date.parse(j.nextAt)<now||j.trigger==="path");
  const running=jobs.filter(j=>j.state==="working");
  return <div className="of-modal-backdrop of-scheduler-backdrop" onClick={e=>{if(e.target===e.currentTarget)close();}}><div className="of-modal of-scheduler" ref={panel} role="dialog" aria-modal="true" aria-labelledby="of-scheduler-title">
    <header><div><span className="of-eyebrow">OPERATIONS / TIMELINE</span><h3 id="of-scheduler-title"><CalendarDays size={21}/> 스케줄러 일정표</h3><p>한국 시간 · {date(now)} {clock(now)}</p></div><button className="of-icon-button" aria-label="일정표 닫기" onClick={close}><X size={20}/></button></header>
    <div className="of-scheduler-controls"><div className="of-alert-tabs">{([["today","오늘 남은 일정"],["tomorrow","내일"],["24h","향후 24시간"]] as const).map(([id,label])=><button key={id} aria-pressed={range===id} onClick={()=>setRange(id)}>{label}</button>)}</div><select aria-label="일정 부서 필터" value={department} onChange={e=>setDepartment(e.target.value)}><option value="all">모든 부서</option>{ROOMS.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
    <div className="of-timeline-legend"><span><i/>관측된 다음 실행 <i className="is-estimated"/>반복 예상</span><label><input type="checkbox" checked={repeats} onChange={e=>setRepeats(e.target.checked)}/>반복 예상 포함</label></div>
    {disconnected&&<p className="of-scheduler-warning">{data?"관측이 끊겼습니다. 아래는 마지막 기록에 따른 일정으로, 현재 실행 여부를 확인할 수 없습니다.":"아직 수신한 일정이 없습니다. 운영 상태 연결을 기다리고 있습니다."}</p>}
    <div className="of-scheduler-scroll">
      {!!running.length&&<section className="of-running-strip"><h4>{disconnected?"마지막 관측 당시 실행 중":"지금 진행 중"}</h4>{running.map(j=><button key={j.id} onClick={()=>select(j)}><span className="of-status" data-state={disconnected?"unknown":"working"}><i/>{j.name}</span><ChevronRight size={12}/></button>)}</section>}
      <div className="of-timeline-count">{events.length}개 실행 {repeats?"예정·예상":"예정"}<span>시작 시각 기준 · 소요 시간 미관측</span></div>
      {Array.from(groups.entries()).map(([key,items])=><section className="of-hour-block" key={key}><div className="of-hour-label"><small>{date(items[0].at)}</small><strong>{clock(Math.floor(items[0].at/3600000)*3600000)}</strong></div><div className="of-hour-events">{items.map(e=>{const room=ROOMS.find(r=>r.id===e.job.room)!;return <button className="of-scheduled-event" key={`${e.job.id}:${e.at}`} data-estimated={e.estimated} style={{"--room-color":room.color} as CSSProperties} onClick={()=>select(e.job)}><time>{clock(e.at)}</time><i/><span><b>{e.job.name}</b><small>{room.name} · {e.job.cadence}{["failed","delayed"].includes(e.job.state)?` · 현재 ${STATE_LABEL[e.job.state]}`:""}</small></span><em>{e.estimated?"예상":"다음 실행"}</em><ChevronRight size={13}/></button>;})}</div></section>)}
      {!events.length&&<p className="of-empty">선택한 범위에 {repeats?"표시할":"관측된 다음 실행"} 일정이 없습니다.{!repeats?" 이후 반복은 ‘반복 예상 포함’에서 확인할 수 있습니다.":""}</p>}
      {!!unscheduled.length&&<section className="of-unscheduled"><h4>정해진 시각이 없는 작업 · 중지 · 확인 필요</h4>{unscheduled.map(j=><button key={j.id} onClick={()=>select(j)}><span><b>{j.name}</b><small>{j.cadence}</small></span><em>{j.state==="paused"?"중지됨":j.state==="unconfigured"?"미등록":j.state==="unknown"?"상태 미확인":j.trigger==="path"?"이벤트 발생 시":j.nextAt?"예정 시각 경과":"다음 시각 미관측"}</em></button>)}</section>}
    </div><footer><p>‘다음 실행’은 스케줄러에서 읽은 시각입니다. 이후 ‘예상’은 등록된 반복 주기로 계산하며 실행 지연·설정 변경에 따라 달라질 수 있습니다. 중지·미등록·상태 미확인 작업의 반복 일정은 만들지 않습니다.</p></footer>
  </div></div>;
}
