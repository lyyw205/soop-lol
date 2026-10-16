import Link from "next/link";
import { notFound } from "next/navigation";

import { currentMember, readSessionToken } from "@soop-lol/core/lib/auth/request";
import { getCorrectionTarget, listOpenOnMatch, listStreamerChoices } from "@soop-lol/core/lib/db/submission";
import { correctionLines, SUBMISSION_STATE_LABEL } from "@soop-lol/core/lib/metrics/submission";
import { CHAMPIONS, championById } from "@soop-lol/core/lib/riot/champions";
import { loginHref, meHref, mySubmissionsHref, submitMatchHref } from "@soop-lol/core/lib/site-paths";
import { kstPlayedAt } from "@soop-lol/core/lib/time";

import { PageShell, SiteHeader } from "@/components/public";
import { CorrectionForm, SupportButton } from "@/components/submission-forms";

export const metadata = { title: "경기 제보" };
export const dynamic = "force-dynamic";

/**
 * 경기 고치기 제보 — 로그인 필수. 먼저 이 판의 열린 제보를 보여 주고(같은 내용이면 +1), 그다음 폼.
 * 제보는 바로 반영되고 "확인 전"으로 보인다(보류 사유가 있으면 운영자 확인 뒤). docs/USER-SUBMISSION-PLAN.md
 */
export default async function SubmitMatchPage({ params }: { params: Promise<{ matchId: string }> }) {
  const matchId = decodeURIComponent((await params).matchId);
  const target = await getCorrectionTarget(matchId);
  if (!target) notFound();
  const me = await currentMember();
  const here = submitMatchHref(matchId);
  const [open, streamers] = me?.nickname ? await Promise.all([listOpenOnMatch(await readSessionToken(), matchId), listStreamerChoices()]) : [[], []];
  const name = new Map(streamers.map((s) => [s.id, s.display_name]));
  const names = { streamer: (id: string) => name.get(id) ?? "알 수 없는 스트리머", champion: (id: number) => championById(id)?.name ?? `챔피언 ${id}` };
  const champions = [...CHAMPIONS].sort((a, b) => a.name.localeCompare(b.name, "ko")).map((c) => ({ id: c.id, name: c.name }));
  return <>
    <SiteHeader site="lol" />
    <PageShell>
      <div className="member-stack submission-page">
        <section className="member-card arena-panel" aria-labelledby="submit-title">
          <h1 id="submit-title">경기 제보</h1>
          <p className="member-lead">{target.event_name} · {kstPlayedAt(new Date(target.played_at), "datetime")}</p>
          <p className="member-lead">틀렸거나 빠진 값을 고쳐 주세요. 바로 반영되고, 운영자가 확인할 때까지 <strong>확인 전</strong>으로 보이며 전적 합계에는 확인 뒤에 들어갑니다.
            보낸 내용은 본인과 운영자만 봅니다.</p>
          {!me ? <p><Link href={loginHref(here)}>로그인하고 제보하기 →</Link></p>
            : !me.nickname ? <p><Link href={meHref({ next: here })}>가입을 마치고 제보하기 →</Link></p> : null}
        </section>
        {me?.nickname && open.length > 0 && <section className="member-card arena-panel" aria-labelledby="open-title">
          <h2 id="open-title">이 경기에 이미 접수된 제보 {open.length}건</h2>
          <ul className="submission-open">
            {open.map((o) => <li key={o.id}>
              <span className="submission-state">{SUBMISSION_STATE_LABEL[o.state]}{o.supporters > 0 ? ` · 같은 내용 ${o.supporters}` : ""}</span>
              <ul>{correctionLines(o.payload, names).map((l) => <li key={l}>{l}</li>)}</ul>
              {!o.mine && <SupportButton id={o.id} matchId={matchId} />}
            </li>)}
          </ul>
        </section>}
        {me?.nickname && <section className="member-card arena-panel submission-form-card" aria-labelledby="form-title">
          <h2 id="form-title">고칠 값</h2>
          <CorrectionForm target={JSON.parse(JSON.stringify(target))} streamers={streamers} champions={champions} />
          <p className="member-lead"><Link href={mySubmissionsHref()}>내 제보 보기 →</Link></p>
        </section>}
      </div>
    </PageShell>
  </>;
}
