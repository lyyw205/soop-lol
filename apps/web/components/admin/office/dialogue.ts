import type { Job, Snapshot } from "@soop-lol/core/lib/ops/model";

const stamp = (s: string | null | undefined) => s ? Date.parse(s) : 0;
function elapsed(at: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - stamp(at)) / 60_000));
  return minutes < 1 ? "방금" : minutes < 60 ? `${minutes}분 전에` : minutes < 1440 ? `${Math.floor(minutes / 60)}시간 전에` : `${Math.floor(minutes / 1440)}일 전에`;
}
function object(name: string) {
  const code = name.charCodeAt(name.length - 1);
  return name + (code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 ? "을" : "를");
}
/** A character speaks only about its own observed job. Missing schedules are never invented. */
export function jobDialogue(job: Job, data: Pick<Snapshot, "recent"> | null, now: number, disconnected: boolean): string[] {
  const name = ({"fco-club":"구단가치와 스쿼드 갱신","fco-rating":"공식경기 티어 갱신","fco-prices":"카드 시세 확인","ck-auto-lol-poll":"새 VOD 찾기","community-housekeep":"회원 데이터 정리"} as Record<string,string>)[job.id] ?? job.name;
  const task = object(name);
  if (disconnected) return [`${name} 소식이 끊겼어요.`, "새 관측이 올 때까지 현재 상태는 알 수 없어요."];
  const successes = [job.lastSuccessAt, ...(data?.recent.filter(r => r.job === job.id && r.state === "ok").map(r => r.finishedAt) ?? [])]
    .filter((s): s is string => !!s && stamp(s) <= now).sort((a,b) => stamp(b)-stamp(a));
  const last = successes[0] ? `${elapsed(successes[0], now)} ${task} 마쳤어요.` : `아직 ${name} 완료 기록이 없어요.`;
  if (job.state === "working") return [`${task} 진행하고 있어요.`, job.lastAt ? `${elapsed(job.lastAt, now)} 시작했어요.` : "실행은 확인됐지만 시작 시각은 아직 몰라요."];
  if (job.state === "failed") return [`${task} 진행하다 문제가 생겼어요.`, "문제 기록을 함께 확인해 주실래요?"];
  if (job.state === "delayed") return [job.message.includes("실행 시간이") ? `${name} 작업이 예상보다 오래 걸리고 있어요.` : `${name}의 새 결과가 늦어지고 있어요.`, job.lastAt ? `${elapsed(job.lastAt, now)} 실행 기록이 남아 있어요. 확인해 주실래요?` : "실행 상태를 확인해 주실래요?"];
  if (job.state === "paused") return [`${task} 잠시 멈춰 두었어요.`, "재개 설정을 기다리며 쉬고 있을게요."];
  if (job.state === "unconfigured") return [`${name} 담당이에요.`, "아직 자동 실행이 연결되지 않았어요."];
  if (job.state === "unknown") return [`${name} 상태를 아직 확인하지 못했어요.`, "실행 기록이 연결되면 알려 드릴게요."];
  const minutes = Math.ceil((stamp(job.nextAt) - now) / 60_000);
  const next = minutes > 0 ? `${minutes < 60 ? `${minutes}분` : minutes < 1440 ? `${Math.floor(minutes/60)}시간${minutes%60 ? ` ${minutes%60}분` : ""}` : `${Math.floor(minutes/1440)}일`} 후에 다시 ${job.name.includes("동기화") ? "동기화할" : "진행할"} 예정이에요.`
    : job.nextAt ? "예정 시각이 지났어요. 다음 실행 신호를 기다리고 있어요." : "다음 실행 시각은 아직 전달받지 못했어요.";
  return [last, next];
}

export interface SpeechBox { id: string; anchorX: number; anchorY: number; width: number; height: number; x: number; y: number }
const intersects = (a: SpeechBox, b: SpeechBox, gap = 8) => a.x < b.x+b.width+gap && a.x+a.width+gap > b.x && a.y < b.y+b.height+gap && a.y+a.height+gap > b.y;
/** Screen-space placement keeps speech readable when the world zooms out. */
export function placeSpeech(items: Omit<SpeechBox,"x"|"y">[], width: number, height: number): SpeechBox[] {
  const placed: SpeechBox[] = [];
  for (const item of items) {
    let best: SpeechBox | undefined, score = Infinity;
    for (let y=8; y <= height-item.height-8; y+=12) for (let x=8; x <= width-item.width-8; x+=12) {
      const candidate={...item,x,y};
      if (placed.some(b=>intersects(candidate,b))) continue;
      const occluded=items.filter(anchor=>x<anchor.anchorX+20&&x+item.width>anchor.anchorX-20&&y<anchor.anchorY+48&&y+item.height>anchor.anchorY).length;
      const distance=occluded*10000+Math.hypot(x+item.width/2-item.anchorX,(y+item.height+16-item.anchorY)*1.15);
      if (distance < score) {score=distance;best=candidate;}
    }
    if (!best) {
      // Guaranteed non-overlap fallback: a compact shelf layout, still connected to each speaker.
      let x=8,y=8,rowHeight=0;
      return items.map(item=>{if(x+item.width>width-8){x=8;y+=rowHeight+8;rowHeight=0;} const box={...item,x,y};x+=item.width+8;rowHeight=Math.max(rowHeight,item.height);return box;});
    }
    placed.push(best);
  }
  return placed;
}

/** The office is quiet by default: one intentional conversation, or at most two useful signals. */
export function speakingJobs(jobs: Job[], now: number, inspected: string | null, disconnected: boolean): string[] {
  if (inspected && jobs.some(j=>j.id===inspected)) return [inspected];
  if (disconnected) return [];
  const priority=(j:Job)=>j.state==="failed"?4:j.state==="delayed"?3:j.lastSuccessAt&&now-stamp(j.lastSuccessAt)>=0&&now-stamp(j.lastSuccessAt)<120_000?2:j.state==="working"?1:0;
  const rooms=new Set<string>();
  return jobs.map((job,index)=>({job,index,priority:priority(job)})).filter(v=>v.priority>0)
    .sort((a,b)=>b.priority-a.priority||a.index-b.index).filter(({job})=>{if(rooms.has(job.room))return false;rooms.add(job.room);return true;}).slice(0,2).map(v=>v.job.id);
}
