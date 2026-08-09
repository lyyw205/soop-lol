/**
 * 서버 액션의 반환 타입.
 *
 * ★ 이 상수가 actions.ts 가 아니라 여기 있는 이유:
 *   `"use server"` 파일은 **async 함수만** export 할 수 있다.
 *   객체 상수를 하나라도 내보내면 빌드가 `invalid-use-server-value` 로 죽는다.
 *   (타입은 컴파일에 지워지므로 괜찮지만 값은 안 된다)
 */
export interface ActionState {
  ok: boolean;
  message: string;
}

export const IDLE: ActionState = { ok: true, message: "" };
