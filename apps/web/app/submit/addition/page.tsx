import Link from "next/link";

import { currentMember } from "@soop-lol/core/lib/auth/request";
import { listAdditionEventChoices, listStreamerChoices } from "@soop-lol/core/lib/db/submission";
import { CHAMPIONS } from "@soop-lol/core/lib/riot/champions";
import { loginHref, meHref, mySubmissionsHref, submitAdditionHref, submitVodHintHref } from "@soop-lol/core/lib/site-paths";
import { kstDateString } from "@soop-lol/core/lib/time";

import { PageShell, SiteHeader } from "@/components/public";
import { AdditionForm } from "@/components/submission-forms";

export const metadata = { title: "빠진 경기 등록" };
export const dynamic = "force-dynamic";

/**
 * 빠진 경기 직접 입력 — 로그인 필수(docs/SUBMISSION-POLICY-PLAN.md §7 가). 바로 공개되고 "검증 전"으로 보이며 전적 합계에서 빠진다.
 * VOD 판독 대기열 맨 앞에 들어가고, 판독이 그 경기를 찾으면 판독 값으로 덮고 검증 — 합계에 들어간다.
 */
export default async function SubmitAdditionPage() {
  const me = await currentMember();
  const here = submitAdditionHref();
  const [events, streamers] = me?.nickname ? await Promise.all([listAdditionEventChoices(), listStreamerChoices()]) : [[], []];
  const champions = [...CHAMPIONS].sort((a, b) => a.name.localeCompare(b.name, "ko")).map((c) => ({ id: c.id, name: c.name }));
  return <>
    <SiteHeader site="lol" />
    <PageShell>
      <div className="member-stack submission-page">
        <section className="member-card arena-panel" aria-labelledby="submit-title">
          <h1 id="submit-title">빠진 경기 등록</h1>
          <p className="member-lead">기록에 없는 스트리머 내전을 직접 등록해 주세요. 이미 기록된 경기(같은 날 같은 편 사람)면 받지 않고 그 경기 고치기로 안내합니다.</p>
          <p className="member-lead">등록하면 바로 목록에 보이지만 <strong>검증 전</strong>이라 전적 합계에는 들어가지 않습니다. VOD 판독이 그 경기를 확인하면 합계에 들어갑니다.
            경기 자체만 알고 값을 모르면 <Link href={submitVodHintHref()}>VOD 단서 알리기</Link>가 낫습니다.</p>
          {!me ? <p><Link href={loginHref(here)}>로그인하고 등록하기 →</Link></p>
            : !me.nickname ? <p><Link href={meHref({ next: here })}>가입을 마치고 등록하기 →</Link></p> : null}
        </section>
        {me?.nickname && <section className="member-card arena-panel submission-form-card" aria-labelledby="form-title">
          <h2 id="form-title">경기</h2>
          <AdditionForm streamers={streamers} champions={champions}
            events={events.map((e) => ({ id: e.id, label: e.starts_at ? `${e.name} (${kstDateString(new Date(e.starts_at))})` : e.name }))} />
          <p className="member-lead"><Link href={mySubmissionsHref()}>내 제보 보기 →</Link></p>
        </section>}
      </div>
    </PageShell>
  </>;
}
