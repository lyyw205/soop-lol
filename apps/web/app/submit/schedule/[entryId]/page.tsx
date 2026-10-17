import Link from "next/link";
import { notFound } from "next/navigation";

import { currentMember, readSessionToken } from "@soop-lol/core/lib/auth/request";
import { getPublicScheduleEntry } from "@soop-lol/core/lib/db/schedule-public";
import { listOpenSubmissions } from "@soop-lol/core/lib/db/submission";
import { kstClock } from "@soop-lol/core/lib/metrics/schedule";
import { scheduleReportLines, SUBMISSION_STATE_LABEL } from "@soop-lol/core/lib/metrics/submission";
import { loginHref, meHref, mySubmissionsHref, submitScheduleHref } from "@soop-lol/core/lib/site-paths";

import { PageShell, SiteHeader } from "@/components/public";
import { ScheduleReportForm, SupportButton, type ScheduleReportStart } from "@/components/submission-forms";

export const metadata = { title: "편성표 제보" };
export const dynamic = "force-dynamic";

/**
 * 편성표 제보 — 로그인 필수. 있는 일정 고치기(/submit/schedule/<번호>)와 빠진 일정 알리기(/submit/schedule/new).
 * 바로 반영하지 않는다 — 운영자가 확인한 뒤 편성표에 들어간다(사용자 결정 2026-10-17, docs/USER-SUBMISSION-PLAN.md §12).
 */
export default async function SubmitSchedulePage({ params }: { params: Promise<{ entryId: string }> }) {
  const raw = decodeURIComponent((await params).entryId);
  const isNew = raw === "new";
  // 고칠 일정은 공개 일정 읽기 하나로(숨긴·없는 일정은 404).
  const target = isNew ? null : await getPublicScheduleEntry(raw);
  if (!isNew && !target) notFound();
  const me = await currentMember();
  const here = submitScheduleHref(isNew ? null : raw);
  const open = me?.nickname && target ? await listOpenSubmissions(await readSessionToken(), "schedule_report", target.schedule_id) : [];
  const first = target?.slots[0];
  const start: ScheduleReportStart = target ? {
    game_code: target.game_code, title: target.title, status: target.status,
    on_date: first?.on_date ?? "", start: first?.starts_at ? kstClock(new Date(first.starts_at)) : "",
    participants: [...new Set(target.participants.map((p) => p.display_name))].join(", "),
  } : { game_code: "lol", title: "", status: "scheduled", on_date: "", start: "", participants: "" };
  return <>
    <SiteHeader site="platform" />
    <PageShell>
      <div className="member-stack submission-page">
        <section className="member-card arena-panel" aria-labelledby="submit-title">
          <h1 id="submit-title">{isNew ? "빠진 일정 알리기" : "편성표 제보"}</h1>
          {target && <p className="member-lead">{target.title}{first ? ` · ${first.on_date}` : ""}{target.slots.length > 1 ? ` 외 ${target.slots.length - 1}회` : ""}</p>}
          <p className="member-lead">{isNew ? "편성표에 없는 방송 일정을 알려 주세요. 근거 링크(방송 공지·SNS 주소)가 필요합니다."
            : "취소·연기, 바뀐 시간이나 참가자를 알려 주세요."} 운영자가 확인한 뒤 편성표에 반영되며, 보낸 내용은 본인과 운영자만 봅니다.</p>
          {!me ? <p><Link href={loginHref(here)}>로그인하고 제보하기 →</Link></p>
            : !me.nickname ? <p><Link href={meHref({ next: here })}>가입을 마치고 제보하기 →</Link></p> : null}
        </section>
        {me?.nickname && open.length > 0 && <section className="member-card arena-panel" aria-labelledby="open-title">
          <h2 id="open-title">이 일정에 이미 접수된 제보 {open.length}건</h2>
          <ul className="submission-open">
            {open.map((o) => <li key={o.id}>
              <span className="submission-state">{SUBMISSION_STATE_LABEL[o.state]}{o.supporters > 0 ? ` · 같은 내용 ${o.supporters}` : ""}</span>
              <ul>{scheduleReportLines(o.payload).map((l) => <li key={l}>{l}</li>)}</ul>
              {!o.mine && <SupportButton id={o.id} entryId={target!.schedule_id} />}
            </li>)}
          </ul>
        </section>}
        {me?.nickname && <section className="member-card arena-panel submission-form-card" aria-labelledby="form-title">
          <h2 id="form-title">{isNew ? "일정" : "고칠 내용"}</h2>
          <ScheduleReportForm entryId={target?.schedule_id ?? null} start={start} />
          <p className="member-lead"><Link href={mySubmissionsHref()}>내 제보 보기 →</Link></p>
        </section>}
      </div>
    </PageShell>
  </>;
}
