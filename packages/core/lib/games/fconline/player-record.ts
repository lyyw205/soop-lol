/** 명단 등록과 실제 출전, 평점 표본을 구분한다. 평점 0은 평균에 넣지 않는다. */
export function fcoPlayerAppearance(status: Record<string, unknown>): { appeared: boolean; rating: number | null } {
  const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;
  const rating = positive(status.spRating) ? status.spRating as number : null;
  // 2026-10-13 실측: 평점 0인 59,746행 중 골/도움이 있는 행 0.
  // 향후 평점이 누락돼도 골/도움이라는 출전 근거를 버리지는 않는다.
  return { appeared: rating !== null || positive(status.goal) || positive(status.assist), rating };
}
