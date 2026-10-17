import Link from "next/link";

import { listStreamerChoices, listSubmissionQueue, type QueueItem } from "@soop-lol/core/lib/db/submission";
import { listVodRequestsForAdmin, type AdminVodRequest } from "@soop-lol/core/lib/db/vod-request";
import { VOD_REQUEST_STATE_LABEL } from "@soop-lol/core/lib/metrics/vod-request";
import { HOLD_REASON_LABEL, submissionLines, submissionStateLabel } from "@soop-lol/core/lib/metrics/submission";
import { championById } from "@soop-lol/core/lib/riot/champions";
import { kstPlayedAt } from "@soop-lol/core/lib/time";

import { SetupNotice } from "@/components/admin/SetupNotice";
import { CancelVodRequestForm, RequestVodForm } from "@/components/admin/SubmissionForms";
import { Card, EmptyState, Tag } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "제보" };

/** 열린 제보 — 경기별로 묶어 보인다(+1 많은 것·오래된 것 먼저). 처리는 상세에서. */
export default async function SubmissionQueuePage() {
  try {
    const [rows, streamers, requests] = await Promise.all([listSubmissionQueue(), listStreamerChoices(), listVodRequestsForAdmin()]);
    const name = new Map(streamers.map((s) => [s.id, s.display_name]));
    const names = { streamer: (id: string) => name.get(id) ?? id.slice(0, 8), champion: (id: number) => championById(id)?.name ?? `#${id}` };
    // 대상별로 묶는다 — 경기 제보는 판, 편성표 제보는 일정(새 일정 알리기는 제보마다 따로).
    const key = (r: QueueItem) => r.kind === "schedule_report" ? `schedule:${r.schedule_entry_id ?? r.id}`
      : r.kind === "vod_hint" ? `vod:${r.payload.vod}` : r.kind === "match_addition" ? `addition:${r.id}` : r.match_id ?? "(지워진 경기)";
    const byMatch = new Map<string, QueueItem[]>();
    for (const r of rows) byMatch.set(key(r), [...(byMatch.get(key(r)) ?? []), r]);
    return <div className="grid gap-5"><Card title={`제보 ${rows.length}건`} description="반영됨(검증 전)은 공개 화면에 '검증 전'으로 보이고 집계에서 빠져 있습니다 — 직접 입력은 VOD 판독이 검증합니다. 보류는 공개 화면에 아직 반영되지 않았습니다.">
      {!rows.length ? <EmptyState>열린 제보가 없습니다.</EmptyState> : <ul className="divide-y divide-ink-800">
        {[...byMatch].map(([matchId, items]) => <li key={matchId} className="py-4">
          {items[0].kind === "match_addition" ? <div className="flex flex-wrap items-center gap-2 text-sm">
            <Tag>빠진 경기 등록</Tag><strong>{items[0].payload.on_date} {items[0].payload.start}</strong>
            <span className="text-ink-400">{items[0].payload.sets.length}세트</span>
          </div> : items[0].kind === "vod_hint" ? <div className="flex flex-wrap items-center gap-2 text-sm">
            <Tag>VOD 단서</Tag>
            <a href={`https://vod.sooplive.com/player/${items[0].payload.vod}`} target="_blank" rel="noreferrer noopener" className="text-accent-400 hover:underline">vod:{items[0].payload.vod}</a>
          </div> : items[0].kind === "schedule_report" ? <div className="flex flex-wrap items-center gap-2 text-sm">
            <Tag>편성표</Tag><strong>{items[0].schedule_title ?? "편성표에 없는 일정"}</strong>
            {items[0].schedule_entry_id && <Link href={`/admin/schedule/${items[0].schedule_entry_id}`} className="text-accent-400 hover:underline">일정 화면 →</Link>}
          </div> : <div className="flex flex-wrap items-center gap-2 text-sm">
            <strong>{items[0].event_name ?? "행사 없음"}</strong>
            <span className="text-ink-400">{items[0].played_at ? kstPlayedAt(new Date(items[0].played_at), "datetime") : ""} · {matchId}</span>
            {items[0].match_id && <Link href={`/admin/ck/match/${encodeURIComponent(items[0].match_id)}`} className="text-accent-400 hover:underline">검수 화면 →</Link>}
          </div>}
          <ul className="mt-2 grid gap-2">
            {items.map((s) => <li key={s.id} className="rounded border border-ink-800 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Tag tone={s.state === "applied" ? "warn" : "neutral"}>{submissionStateLabel(s)}</Tag>
                {s.hold_reason && <Tag>{HOLD_REASON_LABEL[s.hold_reason]}</Tag>}
                {s.supporters > 0 && <Tag tone="accent">같은 내용 {s.supporters}</Tag>}
                <span className="text-ink-400">{s.author ?? "탈퇴한 회원"} · {kstPlayedAt(new Date(s.created_at), "datetime")}</span>
                <Link href={`/admin/submissions/${s.id}`} className="ml-auto text-accent-400 hover:underline">처리 →</Link>
              </div>
              <ul className="mt-2 list-disc pl-5 text-ink-300">{submissionLines(s, names).map((l) => <li key={l}>{l}</li>)}</ul>
            </li>)}
          </ul>
        </li>)}
      </ul>}
    </Card>
    <VodRequests requests={requests} /></div>;
  } catch (error) { return <SetupNotice error={error} />; }
}

/**
 * VOD 판독 요청(0097) — 이 PC 의 ck-auto 가 매시간 읽어 대기열 맨 앞에 넣는다(감시 목록 밖·이미 끝난 VOD 도 다시 연다).
 * 회원 제보의 요청은 제보 판정이 쓰고 거둔다 — 여기서 거둘 수 있는 것은 운영자 요청뿐.
 */
function VodRequests({ requests }: { requests: AdminVodRequest[] }) {
  const open = requests.filter((r) => r.state === "queued" || r.state === "claimed").length;
  return <Card title={`VOD 판독 요청 ${open}건`} description="이 PC 의 자동 판독(ck-auto)이 다음 시간별 조회 때 대기열 맨 앞에 넣습니다. 감시 목록 밖 채널·이미 끝난 VOD 도 다시 엽니다.">
    <RequestVodForm />
    {requests.length > 0 && <ul className="mt-3 divide-y divide-ink-800 text-sm">
      {requests.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2 py-2">
        <Tag tone={r.state === "queued" || r.state === "claimed" ? "accent" : "neutral"}>{VOD_REQUEST_STATE_LABEL[r.state]}</Tag>
        <a href={`https://vod.sooplive.com/player/${r.title_no}`} target="_blank" rel="noreferrer noopener" className="text-accent-400 hover:underline">vod:{r.title_no}</a>
        <span className="text-ink-400">{r.reason === "submission" ? "회원 제보" : "운영자"} · {kstPlayedAt(new Date(r.requested_at), "datetime")}{r.channel_id ? ` · ${r.channel_id}` : ""}</span>
        {r.submission_id && <Link href={`/admin/submissions/${r.submission_id}`} className="text-accent-400 hover:underline">제보 →</Link>}
        {r.note && <span className="text-ink-300">{r.note}</span>}
        {r.outcome_note && <span className="text-ink-400">({r.outcome_note})</span>}
        {r.reason === "admin" && (r.state === "queued" || r.state === "claimed") && <CancelVodRequestForm id={r.id} />}
      </li>)}
    </ul>}
  </Card>;
}
