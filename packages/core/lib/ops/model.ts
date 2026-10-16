/** Shared, serializable operations contract. No LLM and no browser/server dependencies. */
import { REGISTRY } from "./jobs.generated.ts";
export type RoomId = "lol" | "fc" | "schedule" | "community" | "research" | "backfill";
export type State = "working" | "healthy" | "delayed" | "failed" | "paused" | "unconfigured" | "unknown";
export const STATE_LABEL: Record<State, string> = {
  working: "작업 중", healthy: "정상", delayed: "지연", failed: "실패", paused: "일시 중지", unconfigured: "미등록", unknown: "확인 필요",
};
export const ROOMS: { id: RoomId; name: string; en: string; color: string; href: string; description: string }[] = [
  { id: "lol", name: "리그 오브 레전드", en: "LEAGUE DIVISION", color: "#59caff", href: "/admin/ck", description: "랭크 스냅샷과 공개 경기 수집" },
  { id: "fc", name: "FC 온라인", en: "FC DIVISION", color: "#a5ee74", href: "/admin/fco", description: "경기 · 구단가치 · 티어 · 카드 시세" },
  { id: "schedule", name: "편성표", en: "BROADCAST STUDIO", color: "#ffbd69", href: "/admin/schedule", description: "방송 공지 수집과 일정 분석" },
  { id: "community", name: "커뮤니티", en: "COMMUNITY LOUNGE", color: "#fa92ba", href: "/admin/community", description: "회원 데이터 보존 기간과 정리 작업" },
  { id: "research", name: "자동 조사", en: "RESEARCH LAB", color: "#b7a1ff", href: "/admin/ck", description: "VOD 발견 · 조사 큐 · FC 맥락 조사" },
  { id: "backfill", name: "백필 아카이브", en: "ARCHIVE VAULT", color: "#65e3cb", href: "/admin/ck", description: "과거 기록 수집과 사용자 요청 범위" },
];
export interface JobSpec {
  id: string; name: string; room: RoomId; unit?: string; trigger?: "timer" | "path";
  cadence: string; maxAgeMin?: number; maxRunMin: number; stopFile?: string;
  /** 화면에서 묶어 보일 이름(목록 확인·조사처럼 실행은 다르지만 한 업무). */
  displayGroup?: string;
  /** 멈추면 서비스 차별점이 사라진다 — 정지도 경보로 올린다. */
  critical?: boolean;
  /** 조사 작업 — 최근 실행만이 아니라 대기·진척으로 정상을 판정한다. */
  research?: boolean;
  /** 사람이 요청할 때만 띄운다(백필) — 오래 안 돈 것이 이상이 아니다. */
  manual?: boolean;
  /** 이 작업의 이력으로 읽을 job_run.job 이름(감싸기 이전·상주 루프 기록). */
  legacyNames: string[];
}
/**
 * 작업 목록은 등록부(ops/jobs/*.json → jobs.generated.ts)에서 온다 — 여기에 손으로 적지 않는다(2026-10-16 재설계 2단계).
 * 화면 카드(office)가 없는 작업은 화면에 따로 안 보인다(운영 DB 점검은 health 칸, 운영 오피스는 스냅샷 시각 자체가 생존 신호).
 * maxAgeMin is an overdue allowance, not a replacement for the actual systemd schedule.
 */
export const JOBS: JobSpec[] = REGISTRY.filter(j => j.office).map(j => {
  const names = j.units.map(u => u.slice(u.lastIndexOf("/") + 1));
  const trigger = names.find(n => n.endsWith(".timer") || n.endsWith(".path"));
  return {
    id: j.id, name: j.title, room: j.office!.room, cadence: j.office!.cadence, maxRunMin: j.office!.max_run_min,
    ...(j.office!.max_age_min ? { maxAgeMin: j.office!.max_age_min } : {}),
    ...(trigger ? { unit: trigger.replace(/\.(timer|path)$/, ""), trigger: trigger.endsWith(".path") ? "path" as const : "timer" as const } : {}),
    ...(j.stop_files?.length ? { stopFile: j.stop_files[0]!.replace(/^out\//, "") } : {}),
    ...(j.display_group ? { displayGroup: j.display_group } : {}),
    ...(j.critical ? { critical: true } : {}),
    ...(j.group === "research" ? { research: true } : {}),
    ...(j.install === "manual" ? { manual: true } : {}),
    legacyNames: j.job_run_names ?? [],
  };
});
/** 멈춘 이유(job_run.stop_reason — 0088). 종료 코드에서 번역하지 않고 실행기가 남긴다. */
export type StopReason = "completed" | "no_work" | "skipped" | "user_stop" | "time_cap" | "blocked_external" | "no_progress"
  | "budget" | "lock_busy" | "error" | "killed" | "lost" | "unknown";
export interface Progress { done?: number; total?: number; unit?: string; last_item?: string; at?: string }
export interface Run {
  id: string; job: string; startedAt: string; finishedAt: string | null; state: string;
  processed: number; error: string | null;
  stopReason?: StopReason | null; stopDetail?: string | null; heartbeatAt?: string | null; progress?: Progress | null; exitCode?: number | null;
}
export interface Unit {
  loaded: boolean; enabled: boolean; active: boolean; running: boolean;
  failed: boolean; startedAt: string | null; finishedAt: string | null; nextAt: string | null;
}
export interface Job extends JobSpec {
  state: State; message: string; lastAt: string | null; lastSuccessAt: string | null;
  nextAt: string | null; processed: number | null; evidence: string;
  /** 마지막으로 끝난 실행이 남긴 멈춘 이유·설명, 실행 중 생존 신호·진척, 사람이 할 일. */
  stopReason?: StopReason | null; stopDetail?: string | null; heartbeatAt?: string | null; progress?: Progress | null; action?: string;
}
/**
 * 멈춘 이유 → 화면 상태·문구·사람이 할 일. 같은 종료 코드라도 이유가 다르면 다르게 보인다(재설계 계획 §5.2-3).
 * healthy 인 이유는 주기 지연 판정을 계속 받는다(완료여도 다음 회차가 안 오면 지연).
 */
export const STOP_REASON: Record<StopReason, { state: State; label: string; action: string }> = {
  completed: { state: "healthy", label: "완료", action: "" },
  no_work: { state: "healthy", label: "할 일 없음(대상 0)", action: "" },
  skipped: { state: "healthy", label: "앞 실행이 돌고 있어 이번 회차 생략", action: "" },
  time_cap: { state: "healthy", label: "시간·세션 상한 — 남은 일은 다음 회차가 잇는다", action: "" },
  budget: { state: "healthy", label: "세션 예산 — 다음 세션이 잇는다", action: "" },
  user_stop: { state: "paused", label: "사용자 정지", action: "다시 켜려면 멈춤 파일을 지운다" },
  blocked_external: { state: "failed", label: "외부 차단", action: "차단 원인(DB 점검·디스크·사용량 한도) 해소를 확인한다 — 다음 회차가 다시 본다" },
  no_progress: { state: "failed", label: "진척 없음 반복으로 멈춤", action: "조사 기록을 확인한 뒤 재개한다" },
  lock_busy: { state: "delayed", label: "다른 실행이 잠금을 쥐고 있어 시작하지 못함", action: "앞 실행이 끝났는지 확인한다" },
  error: { state: "failed", label: "오류로 멈춤", action: "서비스 로그를 확인한다" },
  killed: { state: "failed", label: "중단 신호로 끊김(재부팅·수동 중지)", action: "다시 돌릴지 정한다" },
  lost: { state: "failed", label: "기록 없이 끊김", action: "서비스 로그를 확인한다" },
  unknown: { state: "unknown", label: "멈춘 이유를 남기지 않았다", action: "서비스 로그로 이유를 확인한다" },
};
const CRITICAL = " · 출시 차별점 위험(롤 CK 자동화 정지)";
/** 감싸는 실행기가 60초마다 생존 신호를 쓴다 — 이만큼 끊기면 프로세스가 기록 없이 죽은 것으로 본다. */
export const HEARTBEAT_STALE_MIN = 5;
export interface Alert { id: string; jobId?: string; room?: RoomId; title: string; detail: string; severity: "warning" | "error" }
export interface Incident extends Alert { openedAt: string; resolvedAt: string | null }
export interface Snapshot {
  version: 1; at: string; mode: "scheduled" | "on-demand"; jobs: Job[]; alerts: Alert[]; incidents: Incident[];
  recent: Run[]; completed24h: number | null; processed24h: number | null;
  sources: { database: boolean; systemd: boolean; local: boolean };
  queue: { pending: number; owned: number; deferred: number; updatedAt: string; oldestPendingAt?: string | null } | null;
  backfill: { requests: number; latestAt: string | null; from: string | null; to: string | null } | null;
  health: { at: string; verdict: string; totalBytes: number | null; reasons: string[] } | null;
}
const ms = (s: string | null | undefined) => s ? Date.parse(s) : NaN;
export function evaluateJob(spec: JobSpec, run: Run | undefined, unit: Unit | undefined, stopped: boolean, now: number, lastSuccessAt: string | null = null): Job {
  const latestIsDb = !!run && (!unit?.startedAt || ms(run.startedAt) >= ms(unit.startedAt));
  const lastAt = latestIsDb ? run!.startedAt : unit?.startedAt ?? null;
  const result: Job = { ...spec, state: "unknown", message: "실행 근거를 확인할 수 없습니다", lastAt,
    lastSuccessAt, nextAt: unit?.nextAt ?? null, processed: latestIsDb ? run!.processed : null,
    evidence: latestIsDb ? "DB 실행 이력" : unit?.loaded ? "systemd 실행 이력" : "관측 기록 없음",
    ...(run ? { stopReason: run.stopReason ?? null, stopDetail: run.stopDetail ?? null, heartbeatAt: run.heartbeatAt ?? null, progress: run.progress ?? null } : {}) };
  const set = (state: State, message: string, action?: string) => ({ ...result, state, message, ...(action ? { action } : {}) });
  // A stop file lets the current research session save and exit. Do not call that a crash.
  if (stopped) return set("paused", (unit?.running ? "중지 요청됨 · 진행 중 세션 저장 후 종료" : "중지 파일이 설정되어 있습니다") + (spec.critical ? CRITICAL : ""),
    "다시 켜려면 멈춤 파일을 지운다");
  const running = latestIsDb ? run!.state === "running" : unit?.running;
  // 생존 신호가 끊긴 running 행 — 서비스도 안 돌면 기록 없이 죽은 것이다. 실행 중으로 보이게 두지 않는다.
  if (running && latestIsDb && run!.heartbeatAt && !unit?.running && now - ms(run!.heartbeatAt) > HEARTBEAT_STALE_MIN * 60_000)
    return set("failed", `생존 신호가 ${Math.round((now - ms(run!.heartbeatAt)) / 60_000)}분 전에 끊겼습니다 · 기록 없이 끝난 것으로 보입니다`, STOP_REASON.lost.action);
  if (running) return now - ms(lastAt) > spec.maxRunMin * 60_000
    ? set("delayed", `실행 시간이 ${spec.maxRunMin}분을 넘었습니다 · 진행 확인 필요`)
    : set("working", "현재 작업을 실행하고 있습니다");
  // 감싼 실행은 멈춘 이유가 있다 — 종료 코드·state 보다 이것을 먼저 본다.
  const reason = latestIsDb && run!.stopReason ? STOP_REASON[run!.stopReason] : null;
  const why = reason && `${reason.label}${run!.stopDetail ? ` · ${run!.stopDetail}` : ""}`;
  if (reason && reason.state !== "healthy") return set(reason.state, why! + (spec.critical && reason.state === "paused" ? CRITICAL : ""), reason.action);
  if (!reason && (latestIsDb ? run!.state === "failed" : unit?.failed)) return set("failed", latestIsDb ? "최근 실행에 실패 또는 부분 실패가 있습니다" : "서비스가 실패로 종료되었습니다");
  if (unit?.loaded && !unit.active && !unit.enabled) return set("paused", "자동 실행이 비활성화되어 있습니다");
  if (unit?.enabled && !unit.active) return set("delayed", "등록된 자동 실행 트리거가 멈춰 있습니다");
  if (unit?.nextAt && now - ms(unit.nextAt) > 10 * 60_000) return set("delayed", "예정된 실행 시각을 지났습니다");
  if (spec.maxAgeMin && lastAt && now - ms(lastAt) > spec.maxAgeMin * 60_000 && unit?.active)
    return set("delayed", "예상 주기 안에 실행 기록이 없습니다");
  if (!lastAt) {
    if (spec.manual) return set("healthy", "사용자가 요청할 때만 돈다 · 아직 기록된 실행 없음");
    if (unit?.active) return set("healthy", "자동 실행 대기 · 아직 실행 이력 없음");
    if (unit && !unit.loaded) return set("unconfigured", "자동 실행이 등록되지 않았습니다");
    return set("unknown", "실행 기록 없음 · 운영 여부 확인 필요");
  }
  if (!spec.unit && !spec.manual && now - ms(lastAt) > 90 * 60_000) return set("unknown", "과거 실행 이력만 있습니다 · 상주 워커 상태 미관측");
  if (latestIsDb && run!.state === "ok") result.lastSuccessAt = run!.finishedAt ?? run!.startedAt;
  else if (unit && !unit.failed && unit.finishedAt) result.lastSuccessAt = unit.finishedAt;
  return { ...result, state: "healthy", message: why ? `최근 실행 · ${why}` : "최근 실행 완료 · 다음 작업 대기" };
}
export function roomState(jobs: Job[]): State {
  for (const state of ["failed", "delayed", "working", "unknown", "paused", "healthy", "unconfigured"] as State[])
    if (jobs.some(j => j.state === state)) return state;
  return "unknown";
}
export function reconcileIncidents(previous: Incident[], alerts: Alert[], at: string): Incident[] {
  const active = new Set(alerts.map(a => a.id));
  const history = previous.map(i => !i.resolvedAt && !active.has(i.id) ? { ...i, resolvedAt: at } : i);
  for (const alert of alerts) {
    const open = history.find(i => i.id === alert.id && !i.resolvedAt);
    if (open) Object.assign(open, alert);
    else history.unshift({ ...alert, openedAt: at, resolvedAt: null });
  }
  return [...history.filter(i => !i.resolvedAt), ...history.filter(i => i.resolvedAt).slice(0, 200)];
}
