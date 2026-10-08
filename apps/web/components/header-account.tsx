import Link from "next/link";

import { enabledProviders } from "@soop-lol/core/lib/auth/oauth";
import { currentMember } from "@soop-lol/core/lib/auth/request";
import { meHref } from "@soop-lol/core/lib/site-paths";

import { HeaderLoginLink } from "./header-login-link";

/**
 * 머리말 오른쪽의 회원 자리 — 로그인했으면 닉네임(내 정보), 아니면 로그인 링크.
 *
 * ★ 쿠키를 **먼저** 읽는다. 제공자 설정을 먼저 보고 빠져나가면, 빌드 때 설정이 없던 화면이 정적으로 굳어
 *   운영에서 설정을 넣어도 로그인 자리가 영영 안 나온다(빌드 출력에서 약관 화면이 ○ 로 나온 것으로 확인).
 *   쿠키가 없으면 DB 를 읽지 않으므로 비로그인 방문의 비용은 그대로다.
 * ★ 로그인할 제공자가 하나도 없으면 로그인 링크를 그리지 않는다(누를 수 없는 버튼을 두지 않는다).
 */
export async function HeaderAccount() {
  const me = await currentMember();
  if (me) return <Link href={meHref(me.nickname ? undefined : { setup: 1 })} className="header-account">{me.nickname ?? "가입 마무리"}</Link>;
  if (enabledProviders().length === 0) return null;
  return <HeaderLoginLink />;
}
