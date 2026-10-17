import Link from "next/link";

import { currentMember } from "@soop-lol/core/lib/auth/request";
import { loginHref, meHref, mySubmissionsHref, submitVodHintHref } from "@soop-lol/core/lib/site-paths";

import { PageShell, SiteHeader } from "@/components/public";
import { VodHintForm } from "@/components/submission-forms";

export const metadata = { title: "VOD 단서 알리기" };
export const dynamic = "force-dynamic";

/**
 * VOD 단서 — 로그인 필수. "이 VOD 에 내전이 있다"를 알린다(docs/SUBMISSION-POLICY-PLAN.md §7 나).
 * 공개하지 않는다 — VOD 판독 대기열 맨 앞에 들어가고, 판독이 경기를 기록하면 그 경기가 전적에 들어간다.
 */
export default async function SubmitVodHintPage() {
  const me = await currentMember();
  const here = submitVodHintHref();
  return <>
    <SiteHeader site="platform" />
    <PageShell>
      <div className="member-stack submission-page">
        <section className="member-card arena-panel" aria-labelledby="submit-title">
          <h1 id="submit-title">VOD 단서 알리기</h1>
          <p className="member-lead">아직 기록에 없는 내전이 있는 SOOP 다시보기를 알려 주세요. 대략의 시점과 나온 사람을 적어 주면 더 빨리 찾습니다.</p>
          <p className="member-lead">바로 공개되지 않습니다. VOD 판독 대기열 맨 앞에 들어가고, 판독이 경기를 찾으면 그 경기가 전적에 들어갑니다. 보낸 내용은 본인과 운영자만 봅니다.</p>
          {!me ? <p><Link href={loginHref(here)}>로그인하고 알리기 →</Link></p>
            : !me.nickname ? <p><Link href={meHref({ next: here })}>가입을 마치고 알리기 →</Link></p> : null}
        </section>
        {me?.nickname && <section className="member-card arena-panel submission-form-card" aria-labelledby="form-title">
          <h2 id="form-title">단서</h2>
          <VodHintForm />
          <p className="member-lead"><Link href={mySubmissionsHref()}>내 제보 보기 →</Link></p>
        </section>}
      </div>
    </PageShell>
  </>;
}
