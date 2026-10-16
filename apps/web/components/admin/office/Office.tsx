"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { Archive, CalendarDays, Gamepad2, MessageCircle, MessagesSquare, Radio, Trophy, Activity, ArrowUpRight, Bell, BellRing, Check, ChevronRight, CircleHelp, Clock3, Database, Expand, Layers3, Pause, Play, RefreshCw, ShieldCheck, X, ZoomIn, ZoomOut } from "lucide-react";
import { ROOMS, STATE_LABEL, STOP_REASON, type Alert, type Job, type RoomId, type Snapshot, type State } from "@soop-lol/core/lib/ops/model";
import { OfficeScene, jobMood, roomCenter, OVERVIEW } from "./OfficeScene";
import { RobotPortrait } from "./Robot";
import { roomBrief } from "./brief";
import { SchedulerBoard } from "./SchedulerBoard";
import "./office.css";

const ROOM_ICONS = [Trophy, Gamepad2, CalendarDays, MessagesSquare, Radio, Archive];
function RoomIcon({ index }: { index: number }) { const Icon = ROOM_ICONS[index]; return <Icon size={19}/>; }
const count = (n: number | null | undefined) => n == null ? "—" : n.toLocaleString("ko-KR");
function ago(value: string | null | undefined, now: number) {
  if (!value) return "기록 없음";
  const min = Math.floor((now - Date.parse(value)) / 60_000);
  if (min < 0) return `약 ${Math.abs(min)}분 후`;
  if (min < 1) return "방금";
  if (min < 60) return `${min}분 전`;
  if (min < 1440) return `${Math.floor(min / 60)}시간 전`;
  return `${Math.floor(min / 1440)}일 전`;
}
function time(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "예정 없음";
}
function Status({ state }: { state: State }) { return <span className="of-status" data-state={state}><i />{STATE_LABEL[state]}</span>; }
export function Office() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<RoomId>("fc");
  const [focusedRoom,setFocusedRoom]=useState<RoomId|null>(null);
  const [selectedJob, setSelectedJob] = useState<string | null>(null);
  const [camera, setCamera] = useState(OVERVIEW);
  const [bubbles, setBubbles] = useState(true);
  const [equipmentTab, setEquipmentTab] = useState<"task" | "history" | "issues">("task");
  const surface=useRef<HTMLDivElement>(null);
  const drag = useRef<{x: number; y: number; cx: number; cy: number} | null>(null);
  const selectJob = (job: Job) => { setSelected(job.room); setSelectedJob(job.id); setEquipmentTab("task"); };
  const resetCamera = () => {setCamera(OVERVIEW);setSelectedJob(null);setFocusedRoom(null);};
  const selectRoom = (id: RoomId) => {
    setSelected(id);setSelectedJob(null);
    if (selected===id && camera.zoom>OVERVIEW.zoom+.1) {resetCamera();return;}
    setFocusedRoom(id);
    const [x,y]=roomCenter(id),z=window.innerWidth<600?2.2:1.4;
    setCamera({x:x-640/z,y:y-400/z,zoom:z});
  };
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [now, setNow] = useState(Date.now()), [motion, setMotion] = useState(true);
  const [scheduleOpen,setScheduleOpen]=useState(false);
  const [alertsOpen, setAlertsOpen] = useState(false), [focus, setFocus] = useState(false);
  const [tab, setTab] = useState<"active" | "history">("active");
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const busy = useRef(false), alive = useRef(true);
  const modal = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (busy.current && !request.current?.signal.aborted) return;
    busy.current = true; setLoading(true);
    const controller = new AbortController(); request.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 25_000);
    try {
      const response = await fetch("/admin/office/status", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(response.status === 401 ? "관리자 인증이 만료되었습니다. 페이지를 다시 열어 주세요." : "운영 상태를 가져오지 못했습니다.");
      const snapshot = await response.json() as Snapshot;
      if (alive.current && request.current === controller) { setData(snapshot); setError(""); setNow(Date.now()); }
    } catch (e) { if (alive.current && request.current === controller) setError(e instanceof Error && e.name !== "AbortError" ? e.message : "응답이 지연되고 있습니다. 마지막 관측 상태를 표시합니다."); }
    finally { window.clearTimeout(timeout); if (request.current === controller) { busy.current = false; if (alive.current) setLoading(false); } }
  }, []);
  useEffect(() => {
    alive.current = true; void refresh();
    if (window.innerWidth < 600) { setFocusedRoom("fc"); const [x,y]=roomCenter("fc"); setCamera({x:x-640/2.2,y:y-400/2.2,zoom:2.2}); }
    const interval = window.setInterval(() => { setNow(Date.now()); if (!document.hidden) void refresh(); }, 30_000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    try { const saved: unknown = JSON.parse(localStorage.getItem("office-ack") ?? "[]"); if (Array.isArray(saved)) setAcknowledged(saved.filter((v): v is string => typeof v === "string")); } catch { /* Storage unavailable. */ }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setMotion(false);
    return () => { alive.current = false; request.current?.abort(); window.clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);
  useEffect(() => {
    if (!alertsOpen) return;
    const previous = document.activeElement as HTMLElement;
    modal.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAlertsOpen(false);
      if (event.key === "Tab") {
        const nodes = modal.current?.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]');
        if (!nodes?.length) return;
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", listener);
    return () => { document.removeEventListener("keydown", listener); previous?.focus(); };
  }, [alertsOpen]);
  const jobs = data?.jobs ?? [];
  const stale = !!data && now - Date.parse(data.at) > 180_000;
  const alerts = useMemo(() => {
    const result: Alert[] = [...(data?.alerts ?? [])];
    if (stale) result.unshift({ id: "collector:stale", title: "상태 수집이 멈췄습니다", detail: "3분 이상 새 관측이 없습니다. 아래 상태는 마지막 기록이며 현재 정상 여부를 보장하지 않습니다.", severity: "error" });
    if (data?.mode === "on-demand") result.push({ id: "collector:ondemand", title: "화면을 열 때만 확인 중", detail: "정기 수집기가 연결되지 않았습니다. 화면을 닫은 동안의 감시·알림 이력은 수집되지 않습니다.", severity: "warning" });
    if (error) result.unshift({ id: "connection:error", title: "연결 확인 필요", detail: error, severity: "error" });
    return result;
  }, [data, stale, error]);
  const disconnected = stale || !!error || !data;
  const briefs = ROOMS.map(r => roomBrief(r.id, data, alerts, now, disconnected));
  const room = ROOMS.find(r => r.id === selected)!;
  const chosen = jobs.find(j => j.id === selectedJob);
  const running = disconnected ? null : jobs.filter(j => j.state === "working").length;
  const zoom = (step: number) => setCamera(c => { const z = Math.max(.4, Math.min(4, c.zoom + step)); return {zoom:z,x:c.x+640/c.zoom-640/z,y:c.y+400/c.zoom-400/z}; });
  useEffect(()=>{if(camera.zoom<=OVERVIEW.zoom+.05)setFocusedRoom(null);},[camera.zoom]);
  useEffect(()=>{
    const node=surface.current;if(!node)return;
    const wheel=(event:WheelEvent)=>{if((event.target as Element).closest('.of-speech-layer[data-overflow="true"]'))return;event.preventDefault();zoom(event.deltaY>0?-.12:.12);};
    node.addEventListener("wheel",wheel,{passive:false});return()=>node.removeEventListener("wheel",wheel);
  },[]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (scheduleOpen || alertsOpen || (e.target as HTMLElement).closest?.("input,textarea,select")) return;
      if (e.key === "Escape") { if(selectedJob) setSelectedJob(null); else if(camera.zoom !== OVERVIEW.zoom || camera.x !== OVERVIEW.x || camera.y !== OVERVIEW.y) resetCamera(); else setFocus(false); }
      if (/^[1-6]$/.test(e.key)) { e.preventDefault(); selectRoom(ROOMS[Number(e.key)-1].id); }
      if (e.key === "0" || e.key === "Home") {e.preventDefault();resetCamera();}
      if (e.key === "-" || e.key === "_") {e.preventDefault();zoom(-.2);}
      if (e.key === "+" || e.key === "=") {e.preventDefault();zoom(.2);}
    };
    document.addEventListener("keydown", key); return () => document.removeEventListener("keydown",key);
  }, [alertsOpen, scheduleOpen, selectedJob, selected, camera]);
  const firstAlert = alerts[0];
  const keyFor = (a: Alert) => `${a.id}:${data?.incidents.find(i => i.id === a.id && !i.resolvedAt)?.openedAt ?? "current"}`;
  const acknowledge = (a: Alert) => {
    const next = [...new Set([...acknowledged, keyFor(a)])].slice(-200);
    setAcknowledged(next); try { localStorage.setItem("office-ack", JSON.stringify(next)); } catch { /* In-memory fallback. */ }
  };
  const goToAlert = (a: Alert) => { if (a.room) selectRoom(a.room); setAlertsOpen(false); };
  const unread = alerts.filter(a => !acknowledged.includes(keyFor(a))).length;
  return <section className={`office office-game ${focus ? "of-focus" : ""}`} data-motion={motion}>
    <div className="of-world-surface" onDoubleClick={e=>{if(!(e.target as Element).closest("button,[role=button]")) resetCamera();}} ref={surface} onPointerDown={e => {
      if ((e.target as Element).closest('button,[role="button"],.of-speech-layer[data-overflow="true"]')) return;
      drag.current = {x:e.clientX,y:e.clientY,cx:camera.x,cy:camera.y}; e.currentTarget.setPointerCapture(e.pointerId);
    }} onPointerMove={e => { const d=drag.current; if (!d) return; if(Math.hypot(e.clientX-d.x,e.clientY-d.y)>8)setFocusedRoom(null); const rect=e.currentTarget.getBoundingClientRect(); const scale=Math.max(1280/camera.zoom/rect.width,800/camera.zoom/rect.height); setCamera(c=>({...c,x:d.cx-(e.clientX-d.x)*scale,y:d.cy-(e.clientY-d.y)*scale})); }} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}>
      <OfficeScene jobs={jobs} briefs={briefs} selectedJob={selectedJob} select={selectJob} disconnected={disconnected} now={now} camera={camera} bubbles={bubbles} data={data} motion={motion} focusedRoom={focusedRoom}/>
    </div>
    <header className="of-game-top">
      <div className="of-game-brand"><Layers3 size={23}/><div><small>SOOP SEEK / OPERATIONS</small><h2>운영 오피스 <em>01</em></h2></div></div>
      <div className="of-game-resources"><span title="현재 관측된 실행 작업"><Activity size={14}/><b>{count(running)}</b> 작업 중</span><span title="최근 24시간 DB 완료 기록"><Check size={14}/><b>{count(data?.completed24h)}</b> 완료</span><span title="최근 24시간 DB 처리량"><Database size={14}/><b>{count(data?.processed24h)}</b> 건</span></div>
      <div className="of-hud-actions"><button className="of-schedule-button" aria-label="스케줄러 일정표" onClick={()=>{setAlertsOpen(false);setScheduleOpen(true);}}><CalendarDays size={17}/><span>일정표</span></button><button className="of-alert-button" aria-label="알림함" onClick={()=>setAlertsOpen(true)}><Bell size={17}/><span>알림함</span><b>{unread}</b></button></div>
    </header>
    <div className="of-mission-stack">
      <span className={`of-connection ${disconnected ? "is-offline" : ""}`}><i/>{!data ? "연결 중" : disconnected ? "연결 확인" : data.mode === "scheduled" ? "자동 관측 중" : "화면 관측 중"}<small>{data ? `${ago(data.at,now)} 관측` : "신호 수신 대기"}</small></span>
      {firstAlert && <button className="of-attention" onClick={()=>setAlertsOpen(true)}><span className="of-quest-mark">!</span><span><small>확인할 운영 신호 · {alerts.length}건</small><b>{firstAlert.title}</b></span><ChevronRight size={15}/></button>}
    </div>
    <button className="of-return-overview" onClick={resetCamera}><ZoomOut size={18}/><span>전체 사무실로 돌아가기</span><kbd>Esc / 0</kbd></button>
    <div className="of-world-caption"><span>FLOOR 01</span><b>OPERATIONS CAMPUS</b><small>드래그 이동 · 휠 확대/축소 · 빈 바닥 두 번 클릭으로 전체 보기</small></div>
    <div className="of-camera-tools"><button aria-label="상태 새로고침" disabled={loading} onClick={()=>void refresh()}><RefreshCw size={16} className={loading ? "of-spin" : ""}/></button><button aria-label="지도 확대" onClick={()=>zoom(.3)}><ZoomIn size={17}/></button><button aria-label="지도 축소" onClick={()=>zoom(-.3)}><ZoomOut size={17}/></button><button aria-label="전체 사무실 보기" onClick={resetCamera}><Layers3 size={17}/></button><button aria-label="말풍선 표시" aria-pressed={bubbles} onClick={()=>setBubbles(!bubbles)}><MessageCircle size={17}/></button><button aria-label={motion ? "애니메이션 멈추기" : "애니메이션 재생"} onClick={()=>setMotion(!motion)}>{motion ? <Pause size={16}/> : <Play size={16}/>}</button><button aria-label={focus ? "집중 모드 종료" : "집중 모드"} onClick={()=>setFocus(!focus)}><Expand size={17}/></button></div>
    <nav className="of-hotbar" aria-label="부서 이동">{ROOMS.map((r,i)=><button key={r.id} style={{"--room-color":r.color} as CSSProperties} aria-pressed={selected===r.id} onClick={()=>selectRoom(r.id)}><kbd>{i+1}</kbd><span className="of-hotbar-icon"><RoomIcon index={i}/>{briefs[i].attention && <b>!</b>}</span><span>{r.name}</span><i data-state={briefs[i].state}/></button>)}</nav>
    <footer className="of-game-footer"><span><ShieldCheck size={11}/>상주 감시 AI 0 · 감시 LLM 호출 0</span><span>타이핑 실행 · 손들기 확인 필요 · Z 중지</span></footer>
    {chosen && <aside className="of-equipment" aria-label="작업 장비창" style={{"--room-color":room.color} as CSSProperties}>
      <header><span>CREW / {room.name}</span><button aria-label="장비창 닫기" onClick={()=>setSelectedJob(null)}><X size={18}/></button></header>
      <div className="of-character-sheet"><div className="of-gear-slot"><Database size={20}/><small>실행 기록</small></div><div className="of-character-podium"><RobotPortrait mood={jobMood(chosen,disconnected)} color={room.color}/><div className="of-podium-ring"/></div><div className="of-gear-slot"><Clock3 size={20}/><small>{chosen.unit ? "자동 실행" : "수동 업무"}</small></div></div>
      <div className="of-crew-title"><small>{room.en} / OPERATOR</small><h3>{chosen.name}</h3><Status state={disconnected ? "unknown" : chosen.state}/></div>
      <div className="of-equipment-tabs">{([["task","현재 업무"],["history","최근 행동"],["issues","문제 기록"]] as const).map(([id,label])=><button key={id} aria-pressed={equipmentTab===id} onClick={()=>setEquipmentTab(id)}>{label}</button>)}</div>
      <div className="of-equipment-content">
        {equipmentTab === "task" && <><p className="of-task-message">{disconnected ? "관측이 끊겼습니다. 아래는 마지막으로 수신한 기록입니다." : chosen.message}</p><dl><dt>최근 실행</dt><dd>{ago(chosen.lastAt,now)}</dd><dt>마지막 성공</dt><dd>{time(chosen.lastSuccessAt)}</dd><dt>다음 실행</dt><dd>{time(chosen.nextAt)}</dd><dt>실행 주기</dt><dd>{chosen.cadence}</dd><dt>최근 처리량</dt><dd>{count(chosen.processed)}건</dd>{chosen.stopReason && <><dt>멈춘 이유</dt><dd>{STOP_REASON[chosen.stopReason].label}{chosen.stopDetail ? ` · ${chosen.stopDetail}` : ""}</dd></>}{chosen.state === "working" && chosen.heartbeatAt && <><dt>생존 신호</dt><dd>{ago(chosen.heartbeatAt,now)}</dd></>}{chosen.progress && <><dt>진척</dt><dd>{count(chosen.progress.done)}{chosen.progress.total ? ` / ${count(chosen.progress.total)}` : ""} {chosen.progress.unit ?? ""}{chosen.progress.last_item ? ` · ${chosen.progress.last_item}` : ""}{chosen.progress.at ? ` (${ago(chosen.progress.at,now)})` : ""}</dd></>}</dl>{chosen.action && !disconnected && <p className="of-task-note">할 일 · {chosen.action}</p>}
          {chosen.room === "research" && <p className="of-task-note">조사 큐 · 대기 {count(data?.queue?.pending)} / 할당 {count(data?.queue?.owned)} / 재시도 {count(data?.queue?.deferred)}{data?.queue?.oldestPendingAt ? ` · 가장 오래된 대기 ${ago(data.queue.oldestPendingAt,now)}` : ""}<small>할당 수는 실제 실행 수와 다를 수 있습니다.</small></p>}
          {chosen.room === "backfill" && <p className="of-task-note">백필 요청 {count(data?.backfill?.requests)}개<small>{data?.backfill?.from ?? "기간 미등록"} ~ {data?.backfill?.to ?? "—"}<br/>요청 범위 기준 · 실행별 진척은 감싼 실행(run-job)에만 있다</small></p>}
          <p className="of-evidence">관측 근거 · {chosen.evidence}</p></>}
        {equipmentTab === "history" && <>{data?.recent.filter(r=>r.job===chosen.id).slice(0,12).map(r=><article className="of-log-entry" key={r.id}><i data-state={["failed","lost"].includes(r.state) ? "failed" : "healthy"}/><div><b>{r.state === "running" ? "실행 시작" : r.stopReason ? STOP_REASON[r.stopReason].label : r.state === "ok" ? `${count(r.processed)}건 처리 완료` : "실행 실패"}</b><small>{time(r.finishedAt ?? r.startedAt)}</small>{(r.stopDetail || r.error) && <p>{r.stopDetail ?? r.error}</p>}</div></article>)}{!data?.recent.some(r=>r.job===chosen.id) && <p className="of-empty">표시할 DB 실행 이력이 없습니다.</p>}<p className="of-task-note">마지막 성공 · {time(chosen.lastSuccessAt)}</p></>}
        {equipmentTab === "issues" && <>{alerts.filter(a=>a.jobId===chosen.id || (!a.jobId && a.room===chosen.room)).map(a=><article className="of-log-entry" key={a.id}><BellRing size={15}/><div><b>{a.title}</b><p>{a.detail}</p></div></article>)}{data?.incidents.filter(a=>a.resolvedAt && (a.jobId===chosen.id || (!a.jobId && a.room===chosen.room))).slice(0,6).map(a=><article className="of-log-entry" key={`${a.id}${a.openedAt}`}><Check size={15}/><div><b>해결 · {a.title}</b><small>{time(a.resolvedAt)}</small></div></article>)}<p className="of-task-note">{disconnected ? "현재 문제 유무를 확인할 수 없습니다." : ["failed","delayed","unknown","unconfigured"].includes(chosen.state) ? chosen.message : "관측된 현재 상태 · " + STATE_LABEL[chosen.state]}</p></>}
      </div><Link className="of-open-section" href={room.href}>관리 화면 열기<ArrowUpRight size={14}/></Link>
    </aside>}
    {scheduleOpen && <SchedulerBoard data={data} now={now} disconnected={disconnected} close={()=>setScheduleOpen(false)} select={job=>{setScheduleOpen(false);selectJob(job);}}/>}
    {alertsOpen && <div className="of-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setAlertsOpen(false); }}><div ref={modal} className="of-modal" role="dialog" aria-modal="true" aria-labelledby="of-alert-title"><header><div><span className="of-eyebrow">OPERATIONS INBOX</span><h3 id="of-alert-title">운영 알림함 <b>{alerts.length}</b></h3></div><button className="of-icon-button" aria-label="알림함 닫기" onClick={() => setAlertsOpen(false)}><X size={20} /></button></header>
      <div className="of-alert-tabs"><button aria-pressed={tab === "active"} onClick={() => setTab("active")}>확인할 알림</button><button aria-pressed={tab === "history"} onClick={() => setTab("history")}>해결 이력</button></div>
      <div className="of-alert-list">{tab === "active" ? alerts.length ? alerts.map(a => <article key={a.id} data-severity={a.severity}><span className="of-alert-severity"><BellRing size={16} /></span><div><h4>{a.title}</h4><p>{a.detail}</p><div className="of-alert-controls">{a.room && <button onClick={() => goToAlert(a)}>부서 보기<ArrowUpRight size={12} /></button>}<button onClick={() => acknowledge(a)} disabled={acknowledged.includes(keyFor(a))}><Check size={12} />{acknowledged.includes(keyFor(a)) ? "확인함" : "확인 표시"}</button></div></div></article>) : <p className="of-empty">현재 감지된 알림이 없습니다.</p>
        : data?.incidents.some(i => i.resolvedAt) ? data.incidents.filter(i => i.resolvedAt).slice(0, 30).map(i => <article key={`${i.id}:${i.openedAt}`}><Check size={16} /><div><h4>{i.title}</h4><p>{time(i.openedAt)} 발생 → {time(i.resolvedAt)} 해소</p></div></article>) : <p className="of-empty">기록된 해결 이력이 없습니다. 정기 수집기가 발생·해소 시점을 보존합니다.</p>}</div>
      <footer><CircleHelp size={14} /><p>확인 표시는 이 브라우저에 저장됩니다. 실제 문제가 해소되면 알림이 자동으로 해결 이력으로 이동합니다. 정기 수집기는 새 알림을 로컬 데스크톱에도 전달합니다(알림 서비스가 있는 환경).</p></footer>
    </div></div>}
  </section>;
}
