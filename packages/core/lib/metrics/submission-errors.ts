/** 제보 입력의 형식 오류 — 화면에 그대로 보여 준다. submission.ts·addition.ts 가 같이 쓴다(서로를 부르지 않게 따로 둔다). */
export class SubmissionInputError extends Error {
  constructor(message: string) { super(message); this.name = "SubmissionInputError"; }
}
