/** match_series 의 값 규칙. 시리즈를 만들고 판을 두는 쓰기는 classification.ts(ensureSeriesInTx·placeSetInTx) 한 곳이다. */

export function validateBestOf(bestOf: number | null | undefined, evidence: string | null | undefined): void {
  if (bestOf == null) return;
  if (!Number.isInteger(bestOf) || bestOf <= 0 || bestOf % 2 === 0) {
    throw new Error("best_of는 양의 홀수여야 합니다. 고정 2세트제나 모르는 포맷은 비워 두세요.");
  }
  if (!evidence?.trim()) throw new Error("best_of를 채우려면 대회 규정이나 VOD 시각 근거가 필요합니다.");
}
