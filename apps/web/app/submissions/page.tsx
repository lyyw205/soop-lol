import Link from "next/link";
import { redirect } from "next/navigation";

import { currentMember, readSessionToken } from "@soop-lol/core/lib/auth/request";
import { listMySubmissions, listStreamerChoices } from "@soop-lol/core/lib/db/submission";
import { HOLD_REASON_LABEL, submissionLines, SUBMISSION_STATE_LABEL } from "@soop-lol/core/lib/metrics/submission";
import { championById } from "@soop-lol/core/lib/riot/champions";
import { loginHref, mySubmissionsHref, submitMatchHref, submitScheduleHref } from "@soop-lol/core/lib/site-paths";
import { kstDateString } from "@soop-lol/core/lib/time";

import { PageShell, SiteHeader } from "@/components/public";

export const metadata = { title: "내 제보" };
export const dynamic = "force-dynamic";

/** 내 제보 — 보낸 것과 지금 상태. 본인만 본다. */
export default async function MySubmissionsPage() {
  const me = await currentMember();
  if (!me) redirect(loginHref(mySubmissionsHref()));
  const [rows, streamers] = await Promise.all([listMySubmissions(await readSessionToken()), listStreamerChoices()]);
  const name = new Map(streamers.map((s) => [s.id, s.display_name]));
  const names = { streamer: (id: string) => name.get(id) ?? "알 수 없는 스트리머", champion: (id: number) => championById(id)?.name ?? `챔피언 ${id}` };
  return <>
    <SiteHeader site="platform" />
    <PageShell>
      <section className="member-card arena-panel submission-page" aria-labelledby="mine-title">
        <h1 id="mine-title">내 제보</h1>
        <p className="member-lead">보낸 제보와 처리 상태입니다. 본인과 운영자만 볼 수 있습니다.</p>
        {!rows.length ? <p className="member-lead">아직 보낸 제보가 없습니다. 경기 기록의 세트 보기나 편성표의 일정에서 <strong>제보하기</strong>를 눌러 보내 주세요.</p>
          : <ul className="submission-open">
            {rows.map((r) => <li key={r.id}>
              <span className="submission-state">{kstDateString(new Date(r.created_at))} · {SUBMISSION_STATE_LABEL[r.state]}{r.supporters > 0 ? ` · 같은 내용 ${r.supporters}` : ""}</span>
              {r.state === "held" && r.hold_reason && <p className="member-lead">{HOLD_REASON_LABEL[r.hold_reason]}</p>}
              <ul>{submissionLines(r.kind, r.payload, names).map((l) => <li key={l}>{l}</li>)}</ul>
              {r.decision_note && <p className="member-lead">운영자: {r.decision_note}</p>}
              {r.match_id && <Link href={submitMatchHref(r.match_id)}>그 경기 →</Link>}
              {r.schedule_entry_id && <Link href={submitScheduleHref(r.schedule_entry_id)}>그 일정 →</Link>}
            </li>)}
          </ul>}
      </section>
    </PageShell>
  </>;
}
