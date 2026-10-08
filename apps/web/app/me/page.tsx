import Link from "next/link";
import { redirect } from "next/navigation";

import { safeNextPath } from "@soop-lol/core/lib/auth/oauth";
import { currentMember } from "@soop-lol/core/lib/auth/request";
import { loginHref, meHref } from "@soop-lol/core/lib/site-paths";

import { NicknameForm, SignupForm, WithdrawForm } from "@/components/member-forms";
import { PageShell, SiteHeader } from "@/components/public";
import { roleHref } from "@/lib/module-links";

import { logoutAction } from "./actions";

export const metadata = { title: "내 정보" };
export const dynamic = "force-dynamic";

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/**
 * 내 정보 — 처음 로그인하면 가입 마무리(닉네임 + 동의), 그 뒤로는 닉네임·로그아웃·탈퇴. docs/COMMUNITY-PLAN.md §2
 * ★ "내 글" 은 커뮤니티 모듈의 작성자 필터로 간다 — core 는 모듈 이름을 모르고 역할로 묻는다(모듈이 없으면 링크가 없다).
 */
export default async function MePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const me = await currentMember();
  if (!me) redirect(loginHref(meHref()));
  const next = safeNextPath(one(sp.next));
  const myPosts = roleHref("community", {}, { author: me.member_id });
  return <>
    <SiteHeader site="platform" />
    <PageShell>
      {me.nickname === null
        ? <section className="member-card arena-panel" aria-labelledby="signup-title">
          <h1 id="signup-title">가입 마무리</h1>
          <p className="member-lead">커뮤니티에서 쓸 닉네임을 정해 주세요. 닉네임은 나중에 바꿀 수 있습니다.</p>
          <SignupForm next={next} />
        </section>
        : <div className="member-stack">
          <section className="member-card arena-panel" aria-labelledby="me-title">
            <h1 id="me-title">내 정보</h1>
            <p className="member-lead"><b>{me.nickname}</b>{myPosts && <> · <Link href={myPosts}>내 글 보기</Link></>}</p>
            <NicknameForm current={me.nickname} />
            <form action={logoutAction} className="member-form"><button type="submit" className="member-secondary">로그아웃</button></form>
          </section>
          <section className="member-card arena-panel" aria-labelledby="withdraw-title">
            <h2 id="withdraw-title">탈퇴</h2>
            <WithdrawForm />
          </section>
        </div>}
    </PageShell>
  </>;
}
