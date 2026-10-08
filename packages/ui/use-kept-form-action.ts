"use client";

/**
 * 거부돼도 입력값을 지키는 서버 액션 폼.
 *
 * ★ React 19 는 `<form action={fn}>` 으로 제출한 폼을 액션이 끝나면 **비운다** — 액션이 거부 결과(한도·검증 문구)를
 *   돌려줘도 "성공" 으로 친다. 그래서 "1분에 1개" 문구가 뜨는 순간 제목·말머리·닉네임이 지워졌다(브라우저 검증에서 확인).
 *   제출을 직접 보내면(onSubmit 에서 기본 동작을 막고 dispatch) 비우지 않는다. 자바스크립트가 없을 때는 action 이 그대로 제출한다.
 * ★ 성공했을 때 비울 폼(댓글)은 부르는 쪽이 결과를 보고 직접 비운다.
 * 표시만 하는 공용 UI 규칙을 지킨다 — DB·서버를 모른다.
 */

import { startTransition, useActionState, type FormEvent } from "react";

export function useKeptFormAction<S>(
  action: (state: Awaited<S>, form: FormData) => S | Promise<S>,
  initial: Awaited<S>,
  opts: { confirm?: string } = {},
) {
  const [state, dispatch, pending] = useActionState(action, initial);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (opts.confirm && !window.confirm(opts.confirm)) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const data = new FormData(event.currentTarget, submitter);
    startTransition(() => dispatch(data));
  };
  return { state, dispatch, pending, onSubmit };
}
