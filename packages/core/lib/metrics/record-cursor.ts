/** 날짜+고유키의 안정적인 이어 보기. 값은 질의 매개변수로만 사용한다. */
export function recordCursor(at: Date | string, id: string): string {
  return `${new Date(at).toISOString()}|${id}`;
}
export function readRecordCursor(value?: string | null): {at: string; id: string} | null {
  if (!value || value.length > 300) return null;
  const sep = value.indexOf("|");
  if (sep < 0) return null;
  const at = value.slice(0, sep), id = value.slice(sep + 1);
  const date = new Date(at);
  // 발급할 때의 ISO 형식과 일치해야 한다. Date.parse는 2월 30일도 3월로 보정한다.
  return /^\d{4}-\d{2}-\d{2}T/.test(at) && Number.isFinite(date.getTime())
    && date.toISOString() === at && /^[\w:.-]+$/.test(id) ? {at, id} : null;
}
