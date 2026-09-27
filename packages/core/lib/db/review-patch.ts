/** CK 검수의 변경 필드 비교. SQL 컬럼은 호출자가 정한 allowlist로 제한한다. */
export class ReviewConflictError extends Error {
  readonly field: string;
  readonly mine: unknown;
  readonly theirs: unknown;
  constructor(field: string, mine: unknown, theirs: unknown) {
    super(`${field} 은(는) 그 사이 다른 검수자가 ${JSON.stringify(theirs)} 로 고쳤습니다`
      + ` (내 화면은 ${JSON.stringify(mine)}). 최신 값을 불러와 다시 확인하세요.`);
    this.name = "ReviewConflictError";
    this.field = field;
    this.mine = mine;
    this.theirs = theirs;
  }
}

export function sameReviewValue(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return (a ?? null) === (b ?? null);
  if (a instanceof Date || b instanceof Date) {
    return new Date(a as string).getTime() === new Date(b as string).getTime();
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length
      && a.every((v, i) => sameReviewValue(v, b[i]));
  }
  return (a ?? null) === (b ?? null);
}

export function checkedReviewChanges(
  current: Record<string, unknown>, changes: Record<string, unknown>,
  expect: Record<string, unknown>, allowed: readonly string[],
): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!allowed.includes(key)) throw new Error(`검수에서 바꿀 수 없는 필드: ${key}`);
    if (value === undefined) continue;
    if (!Object.hasOwn(expect, key) || expect[key] === undefined) throw new Error(`${key} 기대값이 없습니다.`);
    if (!sameReviewValue(current[key], expect[key])) throw new ReviewConflictError(key, expect[key], current[key]);
    if (!sameReviewValue(current[key], value)) next[key] = value;
  }
  for (const key of Object.keys(expect)) {
    if (!allowed.includes(key)) throw new Error(`검수에서 비교할 수 없는 필드: ${key}`);
    if (!sameReviewValue(current[key], expect[key])) throw new ReviewConflictError(key, expect[key], current[key]);
  }
  return next;
}
