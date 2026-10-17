/**
 * 실행 순서만 관리한다. 완료·진척·반복 제한은 ck:queue / DB가 판정한다.
 * 순서 = 우선순위(판독 요청 0097 — 클수록 먼저, 요청 없는 매일 조사는 0) → 오래된 VOD.
 */
export interface AutoVod {
  key: string; title_no: number; channel_id: string; streamer: string; slug: string;
  title: string; ended_at: string; hours: number; category: string | null; reason: string; duration_sec?: number | null;
  /** 판독 요청의 우선순위(metrics/vod-request.ts). 없으면 0. 매 회차 목록이 덮는다 — 요청이 닫히면 0으로 돌아간다. */
  priority?: number;
}
export interface AutoJob { item: AutoVod; not_before: number; owner?: string }
export interface AutoQueue { version: 1; jobs: Record<string, AutoJob> }
export const emptyQueue = (): AutoQueue => ({ version: 1, jobs: {} });

export function vodTime(value: string): number {
  // SOOP의 시간대 없는 날짜는 KST, DB ISO 문자열은 명시된 시간대 그대로.
  return Date.parse(/[zZ]$|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(" ", "T")}+09:00`);
}

export function enqueue(q: AutoQueue, items: AutoVod[], now: number): boolean {
  for (const item of items) {
    if (!Number.isSafeInteger(item.title_no) || item.title_no <= 0 || item.key !== `vod:${item.title_no}`
      || !/^[\w-]+$/.test(item.channel_id) || !Number.isFinite(vodTime(item.ended_at))
      || (item.priority !== undefined && !(Number.isInteger(item.priority) && item.priority >= 0))) {
      throw new Error(`잘못된 VOD 작업: ${item.key}`);
    }
    const old = q.jobs[item.key];
    q.jobs[item.key] = old ? { ...old, item } : { item, not_before: now };
  }
  // 실행 중인 작업도 깨우기 요청을 남긴다. 작업자가 죽었다면 다음 실행이 소유권을 회수한다.
  return Object.values(q.jobs).some((j) => j.not_before <= now);
}

export function recover(q: AutoQueue): void {
  for (const job of Object.values(q.jobs)) delete job.owner;
}

export function claim(q: AutoQueue, owner: string, now: number): AutoVod | "wait" | null {
  const busy = new Set(Object.values(q.jobs).filter((j) => j.owner).map((j) => j.item.channel_id));
  const next = Object.values(q.jobs).filter((j) => !j.owner && j.not_before <= now && !busy.has(j.item.channel_id))
    .sort((a, b) => (b.item.priority ?? 0) - (a.item.priority ?? 0)
      || vodTime(a.item.ended_at) - vodTime(b.item.ended_at) || a.item.title_no - b.item.title_no)[0];
  if (!next) return busy.size ? "wait" : null;
  next.owner = owner;
  return next.item;
}

export function release(q: AutoQueue, key: string, owner: string, next: number | null): void {
  const job = q.jobs[key];
  if (!job || job.owner !== owner) throw new Error(`작업 소유권 불일치: ${key}`);
  if (next === null) delete q.jobs[key];
  else { delete job.owner; job.not_before = next; }
}

export interface PendingVod { channel_id: string; since: string; item?: AutoVod }
export function rememberPending(pending: Record<string, PendingVod>, item: AutoVod, today: string): void {
  pending[item.key] = { channel_id: item.channel_id, since: pending[item.key]?.since ?? today, item };
}
