import { roomState, type Alert, type Job, type RoomId, type Snapshot, type State } from "@soop-lol/core/lib/ops/model";

export type Mood = "working" | "idle" | "help" | "paused" | "unknown" | "walking";
export interface Brief {
  id: RoomId; state: State; mood: Mood; working: number; attention: boolean;
  current: string; context: string; last: string; lastAt: string | null;
  problem: string; problemKind: "active" | "resolved" | "unknown" | "clear";
  problemAt: string | null; recentSuccess: boolean; jobs: Job[];
}
const stamp = (value: string | null | undefined) => value ? Date.parse(value) : 0;
export function relative(value: string | null, now: number) {
  if (!value) return "기록 없음";
  const minutes = Math.max(0, Math.floor((now - stamp(value)) / 60_000));
  return minutes < 1 ? "방금" : minutes < 60 ? `${minutes}분 전` : minutes < 1440 ? `${Math.floor(minutes / 60)}시간 전` : `${Math.floor(minutes / 1440)}일 전`;
}
function due(value: string, now: number) {
  const minutes = Math.max(1, Math.ceil((stamp(value) - now) / 60_000));
  return minutes < 60 ? `${minutes}분 후` : `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ""} 후`;
}
/** All dialogue is a deterministic summary of observed facts, never generated role-play. */
export function roomBrief(id: RoomId, data: Snapshot | null, alerts: Alert[], now: number, disconnected = false): Brief {
  const jobs = data?.jobs.filter(j => j.room === id) ?? [];
  const belongs = (a: { room?: RoomId; jobId?: string }) => a.room === id || jobs.some(j => j.id === a.jobId);
  const issues = alerts.filter(belongs).sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"));
  const active = jobs.filter(j => j.state === "working");
  const blocked = jobs.find(j => j.state === "failed" || j.state === "delayed");
  const paused = jobs.find(j => j.state === "paused");
  const unknown = jobs.filter(j => j.state === "unknown");
  const next = jobs.filter(j => stamp(j.nextAt) > now).sort((a, b) => stamp(a.nextAt) - stamp(b.nextAt))[0];
  const stale = disconnected || (!!data && now - stamp(data.at) > 180_000);
  const state = stale ? "unknown" : roomState(jobs);
  const mood: Mood = stale || !data ? "unknown" : active.length ? "working" : issues.length || blocked ? "help" : paused ? "paused" : unknown.length || state === "unconfigured" ? "unknown" : "idle";
  let current = active.length ? active[0].name : blocked ? `${blocked.name} 확인 필요` : paused ? `${paused.name} 중지` : unknown.length ? "작업 상태 확인 필요" : state === "unconfigured" ? "아직 업무가 연결되지 않았어요" : "다음 작업을 기다리는 중";
  let context = active.length ? `${relative(active[0].lastAt, now)} 시작${active.length > 1 ? ` · 외 ${active.length - 1}개 실행 중` : " · 실행 중"}`
    : next ? `${due(next.nextAt!, now)} · ${next.name}` : paused ? "중지 설정 유지 중" : "다음 실행 시각 미관측";
  if (stale || !data) { current = data ? "현재 상태 확인 불가" : "운영 신호 연결 중"; context = data ? `${relative(data.at, now)} 관측 · 동작 표시 보류` : "기록을 기다리고 있어요"; }
  if (id === "research" && data?.queue && !stale && !active.length && !blocked) context = `VOD 대기 ${data.queue.pending}건 · 할당 ${data.queue.owned}건${paused ? " · 중지됨" : ""}`;
  // Include service-only completions, and do not infer a result count from an unrelated last run.
  const results = (data?.recent ?? []).filter(r => jobs.some(j => j.id === r.job) && r.state !== "running").map(r => ({
    at: r.finishedAt ?? r.startedAt, text: `${jobs.find(j => j.id === r.job)!.name} · ${r.state === "ok" ? `${r.processed.toLocaleString("ko-KR")}건 완료` : "실패"}`, ok: r.state === "ok",
  }));
  for (const job of jobs) if (job.lastSuccessAt) results.push({ at: job.lastSuccessAt, text: `${job.name} 완료`, ok: true });
  results.sort((a, b) => stamp(b.at) - stamp(a.at));
  const latest = results[0];
  const resolvedRecord = data?.incidents.filter(i => belongs(i) && i.resolvedAt).sort((a, b) => stamp(b.resolvedAt) - stamp(a.resolvedAt))[0];
  const priorFailure = data?.recent.filter(r => r.state === "failed" && jobs.some(j => j.id === r.job)).sort((a, b) => stamp(b.finishedAt ?? b.startedAt) - stamp(a.finishedAt ?? a.startedAt))[0];
  const resolved = stamp(resolvedRecord?.resolvedAt) >= stamp(priorFailure?.finishedAt ?? priorFailure?.startedAt) ? resolvedRecord : undefined;
  const issueText = issues[0]?.detail.replace(/ · 진행 확인 필요$/, "").replace(/입니다\.$/, "입니다");
  let problem = issueText ? `${issueText}${issues.length > 1 ? ` · 외 ${issues.length - 1}건` : ""}` : blocked?.message ?? (resolved ? `해결 · ${resolved.title}` : priorFailure ? `지난 실패 · ${jobs.find(j => j.id === priorFailure.job)!.name}` : unknown.length ? `${unknown.length}개 작업 상태 미확인` : state === "unconfigured" ? "자동 실행 미등록" : "관측된 문제 없음");
  let problemKind: Brief["problemKind"] = issues.length || blocked ? "active" : resolved ? "resolved" : priorFailure || unknown.length || state === "unconfigured" || !data ? "unknown" : "clear";
  if (stale) { problem = "새 관측이 없어 정상 여부를 알 수 없어요"; problemKind = "unknown"; }
  if (!data) { problem = "관측 기록을 기다리고 있어요"; problemKind = "unknown"; }
  const problemAt = issues[0] ? data?.incidents.find(i => i.id === issues[0].id && !i.resolvedAt)?.openedAt ?? null
    : blocked?.lastAt ?? resolved?.resolvedAt ?? priorFailure?.finishedAt ?? priorFailure?.startedAt ?? null;
  return { id, state, mood, working: stale ? 0 : active.length, attention: !!issues.length || !!blocked || stale || unknown.length > 0,
    current, context, last: latest?.text ?? "아직 완료 기록이 없어요", lastAt: latest?.at ?? null, problem, problemKind, problemAt,
    recentSuccess: !!latest?.ok && !stale && now - stamp(latest.at) >= 0 && now - stamp(latest.at) < 120_000, jobs };
}
