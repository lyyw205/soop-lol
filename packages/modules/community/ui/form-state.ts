/**
 * 서버 액션의 결과. "use server" 파일은 async 함수만 내보낼 수 있어서 상수를 여기 둔다(apps/web 의 action-state 와 같은 이유).
 */
export interface FormResult {
  ok: boolean;
  message: string;
}

export const IDLE: FormResult = { ok: true, message: "" };
