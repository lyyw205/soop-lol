/** 짧은 인계 메모. 진행의 정본/완료 조건이 아니라 다음 판단을 돕는 자료다. */
export interface ScanResume {
  next_action: string;
  next_at?: number;
  context?: string[];
}

export function validateScanResume(value: unknown): asserts value is ScanResume | null | undefined {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('scan.resume 는 객체 또는 null이어야 한다');
  const v = value as Record<string, unknown>;
  if (typeof v.next_action !== 'string' || !v.next_action.trim() || v.next_action.length > 2000)
    throw new Error('scan.resume.next_action 은 1~2000자의 다음 행동이어야 한다');
  if (v.next_at !== undefined && (typeof v.next_at !== 'number' || !Number.isSafeInteger(v.next_at) || v.next_at < 0))
    throw new Error('scan.resume.next_at 은 VOD 전체 초(0 이상 정수)여야 한다');
  if (v.context !== undefined && (!Array.isArray(v.context) || v.context.length > 20
    || v.context.some(s => typeof s !== 'string' || !s.trim() || s.length > 500)))
    throw new Error('scan.resume.context 는 최대 20개, 항목마다 1~500자의 확인 사실이어야 한다');
  if (Object.keys(v).some(k => !['next_action', 'next_at', 'context'].includes(k)))
    throw new Error('scan.resume 에는 next_action, next_at, context만 기록한다');
}
