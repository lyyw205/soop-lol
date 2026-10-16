"use client";

import { ROOMS, STATE_LABEL, type Job, type RoomId } from "@soop-lol/core/lib/ops/model";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { Robot } from "./Robot";
import { type Mood, type Brief } from "./brief";
import type { Snapshot } from "@soop-lol/core/lib/ops/model";
import { jobDialogue, placeSpeech, speakingJobs } from "./dialogue";

// A small, deterministic isometric renderer. Everything is vector geometry, including the furniture.
const p = (x: number, y: number, z = 0) => [550 + (x - y) * .84, 110 + (x + y) * .405 - z];
const pts = (points: number[][]) => points.map(([x, y]) => `${x},${y}`).join(" ");
function Plane({ x, y, w, d, z = 0, fill, stroke, ...rest }: { x: number; y: number; w: number; d: number; z?: number; fill: string; stroke?: string; className?: string }) {
  return <polygon points={pts([p(x, y, z), p(x + w, y, z), p(x + w, y + d, z), p(x, y + d, z)])} fill={fill} stroke={stroke} {...rest} />;
}
function Box({ x, y, w, d, h, z = 0, top = "#354354", side = "#202d3e", front = "#152031", stroke = "#46566b" }: {
  x: number; y: number; w: number; d: number; h: number; z?: number; top?: string; side?: string; front?: string; stroke?: string;
}) {
  return <g stroke={stroke} strokeWidth=".65" strokeLinejoin="round">
    <polygon points={pts([p(x, y + d, z), p(x + w, y + d, z), p(x + w, y + d, z + h), p(x, y + d, z + h)])} fill={front} />
    <polygon points={pts([p(x + w, y, z), p(x + w, y + d, z), p(x + w, y + d, z + h), p(x + w, y, z + h)])} fill={side} />
    <Plane x={x} y={y} w={w} d={d} z={z + h} fill={top} />
  </g>;
}
function Line({ from, to, color, width = 1, ...rest }: { from: number[]; to: number[]; color: string; width?: number; className?: string }) {
  const a = p(from[0], from[1], from[2]), b = p(to[0], to[1], to[2]);
  return <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={color} strokeWidth={width} {...rest} />;
}
function Plant({ x, y }: { x: number; y: number }) {
  const [a, b] = p(x + 9, y + 9, 22);
  return <g><Box x={x} y={y} w={18} d={18} h={16} top="#2b4244" side="#28383e" front="#1a292f" />
    <path d={`M${a} ${b + 6} q-23 -15 -14 -30 q17 0 14 25 q-5 -38 8 -40 q13 15 -6 40 q16 -30 24 -22 q6 15 -22 29`} fill="#4d9b78" stroke="#91c69c" strokeWidth="1" />
  </g>;
}
function Desk({ x, y, color, mood }: { x: number; y: number; color: string; mood: Mood }) {
  const working = mood === "working";
  return <g>
    <Box x={x + 3} y={y + 2} w={5} d={26} h={25} top="#53677b" />
    <Box x={x + 58} y={y + 2} w={5} d={26} h={25} top="#53677b" />
    <Box x={x} y={y} w={68} d={33} z={25} h={4} top="#3a4e63" side="#23364a" front="#293c50" />
    <Box x={x + 27} y={y + 11} w={12} d={8} z={29} h={2} top="#7591a3" />
    <Box x={x + 31} y={y + 9} w={3} d={3} z={31} h={7} />
    <Box x={x + 12} y={y + 6} w={43} d={3} z={37} h={24} top="#7690a3" side="#3e5468" front="#101f32" />
    <polygon points={pts([p(x + 15, y + 9.5, 40), p(x + 52, y + 9.5, 40), p(x + 52, y + 9.5, 58), p(x + 15, y + 9.5, 58)])} fill={color} opacity={working ? ".32" : ".13"} />
    {[0, 1, 2].map(i => <Line key={i} from={[x + 18, y + 10, 54 - i * 4]} to={[x + 29 + i * 7, y + 10, 54 - i * 4]} color={color} width={1.3} className={working ? "of-screen-line" : undefined} />)}
    <Plane x={x + 22} y={y + 22} w={25} d={7} z={30} fill="#91a5b6" />
    <Box x={x + 56} y={y + 21} w={5} d={5} z={29} h={6} top="#d8e3e9" front="#93a3b0" />
    <Box x={x + 25} y={y + 43} w={22} d={18} h={15} top="#253f54" front="#182d42" />
    <Box x={x + 25} y={y + 57} w={22} d={3} z={15} h={16} top="#52667d" front="#314b62" />

  </g>;
}
function Server({ x, y, color }: { x: number; y: number; color: string }) {
  return <g><Box x={x} y={y} w={25} d={22} h={58} top="#435569" side="#243647" front="#172638" />
    {[12, 22, 32, 42, 52].map(z => <g key={z}><Line from={[x + 4, y + 22.5, z]} to={[x + 20, y + 22.5, z]} color="#486078" width={3} /><Line from={[x + 4, y + 23, z]} to={[x + 7, y + 23, z]} color={color} width={2} /></g>)}
  </g>;
}
function Glass({ x, y, w, d, color }: { x: number; y: number; w: number; d: number; color: string }) {
  return <g>
    <polygon points={pts([p(x, y), p(x + w, y + d), p(x + w, y + d, 58), p(x, y, 58)])} fill={color} fillOpacity=".045" stroke={color} strokeOpacity=".26" />
    <Line from={[x, y, 59]} to={[x + w, y + d, 59]} color={color} width={1.5} />
    {[0, .5, 1].map(t => <Line key={t} from={[x + w * t, y + d * t, 0]} to={[x + w * t, y + d * t, 58]} color="#647d92" width={1} />)}
  </g>;
}
const POS = [[0, 0], [460, 0], [920, 0], [0, 540], [460, 540], [920, 540]];
export const OVERVIEW = {x:-370,y:-120,zoom:1280/2160};
export function jobMood(job: Job | undefined, disconnected: boolean): Mood {
  return disconnected || !job ? "unknown" : job.state === "working" ? "working" : ["failed", "delayed"].includes(job.state) ? "help" : job.state === "paused" ? "paused" : job.state === "healthy" ? "idle" : "unknown";
}
export function roomCenter(id: RoomId) { const index = ROOMS.findIndex(r => r.id === id); return p(POS[index][0] + 200, POS[index][1] + 220, 25); }

function MovingCrew({job,x,y,color,selected,select,disconnected,motion,location,onTravel,onInspect}: {
  job:Job;x:number;y:number;color:string;selected:boolean;select:(job:Job)=>void;disconnected:boolean;motion:boolean;location:string;onTravel:(id:string,moving:boolean)=>void;onInspect:(id:string|null)=>void;
}) {
  const element=useRef<SVGGElement>(null), previous=useRef([x,y]);
  const [walking,setWalking]=useState(false);
  useLayoutEffect(()=>{
    const node=element.current, from=previous.current; previous.current=[x,y];
    if (!node || (from[0]===x && from[1]===y) || !motion || disconnected || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {setWalking(false);return;}
    // Follow the aisle between the workstation and lounge, instead of teleporting.
    const a=p(from[0],from[1],19), mid=p(from[0],y,19), b=p(x,y,19);
    setWalking(true);onTravel(job.id,true);
    const animation=node.animate([
      {transform:`translate(${a[0]}px, ${a[1]}px)`},
      {transform:`translate(${mid[0]}px, ${mid[1]}px)`,offset:.65},
      {transform:`translate(${b[0]}px, ${b[1]}px)`},
    ], {duration:2000,easing:"linear"});
    animation.onfinish=()=>{setWalking(false);onTravel(job.id,false);};
    return ()=>{animation.cancel();setWalking(false);onTravel(job.id,false);};
  },[x,y,motion,disconnected,job.id,onTravel]);
  const [a,b]=p(x,y,19), mood=jobMood(job,disconnected);
  return <g ref={element} style={{transform:`translate(${a}px, ${b}px)`}} className={`of-agent-character ${selected ? "is-selected" : ""}`} data-job={job.id} data-state={disconnected ? "unknown" : job.state} data-location={location} data-walking={walking}
    onPointerEnter={()=>onInspect(job.id)} onPointerLeave={()=>onInspect(null)} onFocus={()=>onInspect(job.id)} onBlur={()=>onInspect(null)} role="button" tabIndex={0} aria-label={`${job.name} · ${disconnected ? "관측 끊김" : STATE_LABEL[job.state]}`} aria-pressed={selected} onClick={()=>select(job)} onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();select(job);}}}>
    <rect x="-30" y="-60" width="68" height="86" fill="transparent"/>
    <ellipse cy="18" rx="27" ry="12" className="of-selection-ring" fill={color} fillOpacity={selected ? .15 : .04} stroke={selected ? "#d4fff3" : color} strokeOpacity={selected ? 1 : .35}/>
    <Robot color={color} mood={walking ? "walking" : mood}/>
    {walking && <g className="of-walking-feet" stroke="#c6deeb" strokeWidth="4" strokeLinecap="round"><path className="left" d="M-5 -3v7"/><path className="right" d="M5 -3v7"/></g>}
  </g>;
}
export function OfficeScene({ jobs, briefs, selectedJob, select, disconnected, now, camera, bubbles, data, motion, focusedRoom }: {
  jobs: Job[]; briefs: Brief[]; selectedJob: string | null; select: (job: Job) => void; disconnected: boolean; now: number;
  camera: { x: number; y: number; zoom: number }; bubbles: boolean; data:Snapshot|null; motion:boolean; focusedRoom:RoomId|null;
}) {
  const [inspected,setInspected]=useState<string|null>(null);
  const inspectTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const onInspect=useCallback((id:string|null)=>{if(inspectTimer.current)clearTimeout(inspectTimer.current);if(id)setInspected(id);else inspectTimer.current=setTimeout(()=>setInspected(null),180);},[]);
  useEffect(()=>()=>{if(inspectTimer.current)clearTimeout(inspectTimer.current);},[]);
  const [travelling,setTravelling]=useState<Set<string>>(()=>new Set());
  const onTravel=useCallback((id:string,moving:boolean)=>setTravelling(old=>{const next=new Set(old);if(moving)next.add(id);else next.delete(id);return next;}),[]);
  const container=useRef<HTMLDivElement>(null);
  const [size,setSize]=useState({width:1100,height:650});
  const [heights,setHeights]=useState<Record<string,number>>({});
  const speechNodes=useRef(new Map<string,HTMLButtonElement>());
  useEffect(()=>{const node=container.current;if(!node)return;const observer=new ResizeObserver(([entry])=>setSize({width:entry.contentRect.width,height:entry.contentRect.height}));observer.observe(node);return()=>observer.disconnect();},[]);
  const crew = ROOMS.flatMap((room, i) => jobs.filter(j => j.room === room.id).map((job, slot) => {
    const dx=POS[i][0]+40+(slot%2)*180,dy=POS[i][1]+65+Math.floor(slot/2)*115;
    const resting=job.state==="healthy"||job.state==="paused";
    return {job,room,dx,dy,x:resting ? POS[i][0]+50+slot*85 : dx+35,y:resting ? POS[i][1]+365 : dy+43,resting};
  }));
  const scale=Math.min(size.width/(1280/camera.zoom),size.height/(800/camera.zoom));
  const offsetX=(size.width-1280/camera.zoom*scale)/2,offsetY=(size.height-800/camera.zoom*scale)/2;
  const visibleCrew=crew.map(c=>{const [x,y]=p(c.x,c.y,58);return {...c,anchorX:(x-camera.x)*scale+offsetX,anchorY:(y-camera.y)*scale+offsetY,lines:jobDialogue(c.job,data,now,disconnected)};})
    .filter(c=>(!focusedRoom||c.room.id===focusedRoom)&&!travelling.has(c.job.id)&&c.anchorX>=0&&c.anchorX<=size.width&&c.anchorY>=0&&c.anchorY<=size.height);
  const speakers=speakingJobs(visibleCrew.map(c=>c.job),now,selectedJob?null:inspected,disconnected);
  const talking=selectedJob?[]:visibleCrew.filter(c=>speakers.includes(c.job.id)).map(c=>({...c,lines:inspected===c.job.id||focusedRoom?c.lines:c.lines.slice(0,1)}));
  const width=size.width<600 ? Math.min(204,size.width-24) : 218;
  useLayoutEffect(()=>{
    const next:Record<string,number>={};speechNodes.current.forEach((node,id)=>{next[id]=node.offsetHeight;});
    setHeights(old=>JSON.stringify(old)===JSON.stringify(next)?old:next);
  },[data,now,disconnected,width,bubbles,camera,size,travelling,focusedRoom,inspected,selectedJob]);
  const layout=placeSpeech(talking.map(c=>({id:c.job.id,anchorX:c.anchorX,anchorY:c.anchorY,width,height:heights[c.job.id]??110})),Math.max(width+16,size.width-58),size.height);
  return <div ref={container} className="of-scene-container">
  <svg className="of-scene of-game-scene" viewBox={`${camera.x} ${camera.y} ${1280 / camera.zoom} ${800 / camera.zoom}`} role="group" aria-label="운영 사무실. 캐릭터와 말풍선에서 상태를 확인하고 선택하세요.">
    <defs>
      <linearGradient id="office-floor" x2="0" y2="1"><stop stopColor="#233b4c"/><stop offset="1" stopColor="#122534"/></linearGradient>
      <pattern id="office-grid" width="48" height="24" patternUnits="userSpaceOnUse"><path d="M0 12 24 0 48 12 24 24Z" fill="none" stroke="#77adc5" strokeOpacity=".055" strokeWidth=".6"/></pattern>
    </defs>
    <rect x="-4000" y="-3000" width="9000" height="8000" fill="#09131f"/><rect x="-4000" y="-3000" width="9000" height="8000" fill="url(#office-grid)"/>
    <g className="of-building">
      <Box x={-20} y={-20} w={1360} d={1010} z={-22} h={22} top="url(#office-floor)" front="#121e2e" side="#182c3d" stroke="#496377"/>
      <Line from={[-20,990,-12]} to={[1340,990,-12]} color="#50b8bf" width={3}/><Line from={[1340,-20,-12]} to={[1340,990,-12]} color="#50b8bf" width={3}/>
      <Plane x={0} y={440} w={1320} d={80} fill="#132a3a" stroke="#3a596b"/>
      <Line from={[0,480,1]} to={[1320,480,1]} color={disconnected ? "#65768a" : "#62d8d3"} width={3} className={!disconnected&&jobs.some(j=>j.state==="working")?"of-data-flow":undefined}/>
      {ROOMS.map((room,index)=>{
        const [x,y]=POS[index],brief=briefs[index],color=brief?.problemKind==="active"?"#ffa075":room.color;
        const members=crew.filter(c=>c.room.id===room.id),sign=p(x+200,y,35),floor=p(x+20,y+420,3),lounge=p(x+20,y+300,3);
        return <g key={room.id} className="of-room" style={{"--room-color":color} as CSSProperties}>
          <Plane x={x} y={y} w={400} d={430} z={1} fill="#1a3041" stroke="#496174"/>
          <Plane x={x+4} y={y+4} w={392} d={422} z={2} fill={room.color} className="of-room-wash"/>
          {[60,120,180,240,300,360].map(v=><Line key={v} from={[x,y+v,2]} to={[x+400,y+v,2]} color="#668196" width={.4}/>)}
          <Glass x={x} y={y} w={400} d={0} color={color}/><Glass x={x} y={y} w={0} d={240} color={color}/>
          <g transform={`translate(${sign[0]} ${sign[1]}) rotate(25.7)`}><rect x="-100" y="-15" width="200" height="30" rx="4" fill="#102638" stroke={color}/><text y="5" textAnchor="middle" fill={color} fontSize="15">{room.name}</text></g>
          {members.map(c=><Desk key={c.job.id} x={c.dx} y={c.dy} color={color} mood={jobMood(c.job,disconnected)}/>)}
          <Plane x={x+15} y={y+285} w={370} d={125} z={3} fill="#314642" stroke="#668374"/>
          <text x={lounge[0]} y={lounge[1]} transform={`rotate(25.7 ${lounge[0]} ${lounge[1]})`} fill="#a5bca9" fontSize="11" letterSpacing="2">COFFEE & REST</text>
          {[0,1,2,3].map(i=><g key={i}><Box x={x+35+i*85} y={y+352} w={38} d={34} h={14} top="#638079" front="#344f50"/><Box x={x+35+i*85} y={y+376} w={38} d={6} z={14} h={15} top="#88a295" front="#4a6963"/></g>)}
          <Box x={x+300} y={y+290} w={60} d={24} h={28} top="#ac9e7b" front="#655e4d"/><Box x={x+318} y={y+295} w={18} d={12} z={28} h={20} top="#788d98" front="#1a2833"/>
          <Plant x={x+365} y={y+38}/><Plant x={x+365} y={y+300}/>
          {room.id==="backfill"&&<><Server x={x+290} y={y+55} color={color}/><Server x={x+330} y={y+55} color={color}/></>}
          <Line from={[x+4,y+428,3]} to={[x+396,y+428,3]} color={color} width={brief?.attention?3:1.5} className={brief?.problemKind==="active"&&!disconnected?"of-floor-alert":undefined}/>
          <text x={floor[0]} y={floor[1]} transform={`rotate(25.7 ${floor[0]} ${floor[1]})`} fill={color} fontSize="13" letterSpacing="3">{`${String(index+1).padStart(2,"0")} / ${room.en}`}</text>
          {members.map(c=><MovingCrew key={c.job.id} job={c.job} x={c.x} y={c.y} color={color} selected={selectedJob===c.job.id} select={select} disconnected={disconnected} motion={motion} location={c.resting?"lounge":"desk"} onTravel={onTravel} onInspect={onInspect}/>)}
        </g>;
      })}
    </g>
  </svg>
  {bubbles&&<div className="of-speech-layer" data-overflow={layout.some(box=>box.y+box.height>size.height)}>
    <svg className="of-speech-leaders" width={size.width} height={size.height} aria-hidden="true">{layout.map(box=>{const c=talking.find(c=>c.job.id===box.id)!;return <g key={box.id}><path d={`M${box.x+box.width/2} ${box.y+box.height} Q${box.x+box.width/2} ${box.y+box.height+14} ${box.anchorX} ${box.anchorY}`} fill="none" stroke={c.room.color} strokeOpacity=".6" strokeWidth="1.2"/><circle cx={box.anchorX} cy={box.anchorY} r="3" fill={c.room.color}/></g>;})}</svg>
    {layout.map(box=>{const c=talking.find(c=>c.job.id===box.id)!;return <button key={box.id} ref={node=>{if(node)speechNodes.current.set(box.id,node);else speechNodes.current.delete(box.id);}} className={`of-world-speech is-${jobMood(c.job,disconnected)} ${selectedJob===c.job.id?"is-selected":""}`} data-room={c.room.id} data-job={c.job.id} aria-label={c.lines.join(" ")} style={{left:box.x,top:box.y,width:box.width,"--room-color":c.room.color} as CSSProperties} onPointerEnter={()=>onInspect(c.job.id)} onPointerLeave={()=>onInspect(null)} onFocus={()=>onInspect(c.job.id)} onBlur={()=>onInspect(null)} onClick={()=>select(c.job)}>{c.lines.map((line,i)=><p key={i}>{line}</p>)} </button>;})}
  </div>}
  </div>;
}
