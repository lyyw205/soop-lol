import Link from "next/link";
import { redirect } from "next/navigation";

import { enabledProviders, PROVIDER_LABEL, safeNextPath, type Provider } from "@soop-lol/core/lib/auth/oauth";
import { currentMember } from "@soop-lol/core/lib/auth/request";
import { loginStartHref, meHref, policyHref, privacyHref, termsHref } from "@soop-lol/core/lib/site-paths";

import { PageShell, SiteHeader } from "@/components/public";

export const metadata = { title: "로그인" };
export const dynamic = "force-dynamic";

const ERROR: Record<string, string> = {
  cancel: "로그인을 취소했습니다.",
  provider: "지원하지 않는 로그인입니다.",
  start: "로그인을 시작하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
  failed: "로그인하지 못했습니다. 잠시 뒤 다시 시도해 주세요.",
};
/** 제공자마다 정해진 버튼 문구(각 제공자 디자인 가이드의 기본 문구). */
const BUTTON: Record<Provider, string> = { kakao: "카카오 로그인", google: "Google 계정으로 로그인" };

const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/**
 * 로그인 — docs/COMMUNITY-PLAN.md §2. 소셜 로그인만 받는다(비밀번호를 저장하지 않는다).
 * 버튼은 라우트 핸들러(/auth/[provider])로 가는 일반 링크다 — 미리 불러오면(prefetch) 안 된다.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const next = safeNextPath(one(sp.next));
  const me = await currentMember();
  if (me) redirect(me.nickname ? next : meHref({ setup: 1, next }));
  const providers = enabledProviders();
  const blocked = one(sp.blocked);
  const error = one(sp.error);
  return <>
    <SiteHeader site="platform" />
    <PageShell>
      <section className="member-card arena-panel" aria-labelledby="login-title">
        <h1 id="login-title">로그인</h1>
        <p className="member-lead">글과 댓글을 쓰려면 로그인하세요. 읽기는 로그인 없이 할 수 있습니다.</p>
        {blocked && <p className="member-alert" role="alert">탈퇴한 계정입니다. {blocked}부터 같은 계정으로 다시 가입할 수 있습니다.</p>}
        {error && <p className="member-alert" role="alert">{ERROR[error] ?? ERROR.failed}</p>}
        {providers.length === 0
          ? <p className="member-muted">로그인을 준비하고 있습니다.</p>
          : <div className="member-providers">
            {providers.map((p) => <a key={p} className={`member-provider member-provider-${p}`} href={loginStartHref(p, next)}
              aria-label={`${PROVIDER_LABEL[p]}로 로그인`}>{BUTTON[p]}</a>)}
          </div>}
        <p className="member-fine">
          이메일·실명·프로필 사진은 받지 않습니다. 로그인 제공자가 주는 고유 식별값과 직접 정한 닉네임만 씁니다.<br />
          <Link href={termsHref()}>이용약관</Link> · <Link href={privacyHref()}>개인정보처리방침</Link> · <Link href={policyHref()}>운영정책</Link>
        </p>
      </section>
    </PageShell>
  </>;
}
