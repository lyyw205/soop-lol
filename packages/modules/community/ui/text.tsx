import { Fragment } from "react";

import { autolinkParts } from "./autolink.ts";

/** 일반 텍스트 본문. 줄바꿈은 CSS(white-space: pre-wrap)가, 주소만 링크로(autolink.ts). HTML 은 해석하지 않는다. */
export function PlainText({ text }: { text: string }) {
  return <>{autolinkParts(text).map((part, i) => part.kind === "link"
    ? <a key={i} href={part.href} target="_blank" rel="nofollow ugc noopener noreferrer">{part.value}</a>
    : <Fragment key={i}>{part.value}</Fragment>)}</>;
}

const KST = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
const KST_FULL = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });

/** 서버에서 글자로 만들어 내린다 — 클라이언트에서 다시 만들면 시간대·로케일 차이로 화면이 어긋날 수 있다. */
export const shortWhen = (d: Date) => KST.format(new Date(d));
export const fullWhen = (d: Date) => KST_FULL.format(new Date(d));

/** 작성자 표시: 작성자 없음 = 운영자, 이름 없음 = 탈퇴한 회원. */
export const authorLabel = (authorId: string | null, nickname: string | null) => (authorId === null ? "운영자" : nickname ?? "탈퇴한 회원");
