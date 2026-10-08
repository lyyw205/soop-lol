/**
 * 회원 세션 토큰 — 쿠키에는 무작위 토큰, DB(member_session)에는 그 sha256 만 둔다.
 * Next 를 모른다(워커·검증도 쓴다). 쿠키를 읽고 쓰는 곳은 request.ts 하나다.
 */

import { createHash, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "soop_session";
/** 로그인부터 30일. 연장하지 않는다 — 렌더 중에 DB·쿠키를 쓰지 않으려고. */
export const SESSION_DAYS = 30;

export const newSessionToken = (): string => randomBytes(32).toString("base64url");
export const hashSessionToken = (token: string): Buffer => createHash("sha256").update(token, "utf8").digest();
