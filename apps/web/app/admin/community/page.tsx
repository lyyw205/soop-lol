import Link from "next/link";

import {
  getMemberForAdmin, listRecentModeration, listReportQueue, listReviewQueue, type ReportQueueItem,
} from "@soop-lol/core/lib/db/community-admin";
import {
  isUuid, MODERATION_ACTION_LABEL, REPORT_REASON_LABEL, REVIEW_AFTER_DAYS, type ContentStatus, type ModerationAction,
} from "@soop-lol/core/lib/metrics/community";

import { LiftSanctionForm, ModerateForm, NoticeForm, SanctionForm } from "@/components/admin/CommunityForms";
import { SetupNotice } from "@/components/admin/SetupNotice";
import { Card, EmptyState, Tag } from "@/components/ui";
import { roleHref } from "@/lib/module-links";

export const dynamic = "force-dynamic";
export const metadata = { title: "커뮤니티" };

const STATUS_LABEL: Record<ContentStatus, string> = { published: "공개", hidden: "숨김", deleted: "삭제" };
/** 지금 상태에서 고를 수 있는 처리. 전이 규칙의 정본은 core 의 moderationTransition — 여기서는 고를 수 없는 것을 숨기기만 한다. */
const ACTIONS: Record<ContentStatus, ModerationAction[]> = {
  published: ["keep", "hide", "blind", "delete"],
  hidden: ["keep", "blind", "delete", "restore"],
  deleted: ["keep"],
};
const when = (d: Date) => new Date(d).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" });
const excerpt = (s: string | null, n = 400) => (s && s.length > n ? `${s.slice(0, n)}…` : s);

function Author({ id, nickname }: { id: string | null; nickname: string | null }) {
  if (!id) return <span className="text-ink-400">운영자</span>;
  return <Link href={`/admin/community?member=${id}`} className="hover:underline">{nickname ?? "탈퇴한 회원"}</Link>;
}

function QueueItem({ item }: { item: ReportQueueItem }) {
  const publicHref = item.status === "published" ? roleHref("community", { id: String(item.post_id) }) : null;
  return <li className="py-4">
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Tag>{item.kind === "post" ? "글" : "댓글"} #{item.target_id}</Tag>
      <Tag tone={item.status === "published" ? "neutral" : "accent"}>{STATUS_LABEL[item.status]}</Tag>
      {item.urgent && <Tag tone="warn">개인정보·명예훼손</Tag>}
      {item.edited_after_report && <Tag tone="warn">신고 뒤 수정됨</Tag>}
      <span className="text-ink-400">신고 {item.reports.length}건 · 작성자 <Author id={item.author_id} nickname={item.author_nickname} /></span>
      {publicHref && <Link href={publicHref} target="_blank" className="text-xs text-accent-400 hover:underline">공개 화면 ↗</Link>}
    </div>
    <div className="mt-2 rounded-lg border border-ink-800 bg-ink-950/60 p-3 text-sm">
      <p className="mb-1 text-[11px] text-ink-400">지금 내용</p>
      {item.title && <p className="font-medium text-ink-200">{item.title}</p>}
      <p className="whitespace-pre-wrap break-words text-ink-300">{excerpt(item.body) ?? "(파기됨)"}</p>
    </div>
    <ul className="mt-2 space-y-1.5 text-xs">
      {item.reports.map((r) => <li key={r.report_id} className="text-ink-300">
        <span className="text-ink-400">{when(r.created_at)}</span> · <b>{REPORT_REASON_LABEL[r.reason]}</b>{r.detail && <> — {r.detail}</>}
        {(r.snapshot_title !== item.title || r.snapshot_body !== item.body) && <details className="mt-1 rounded-md border border-ink-800 p-2">
          <summary className="cursor-pointer text-ink-400">신고 당시 내용(지금과 다름)</summary>
          {r.snapshot_title && <p className="mt-1 font-medium text-ink-200">{r.snapshot_title}</p>}
          <p className="whitespace-pre-wrap break-words">{excerpt(r.snapshot_body) ?? "(비워짐)"}</p>
        </details>}
      </li>)}
    </ul>
    <ModerateForm kind={item.kind} targetId={item.target_id} actions={ACTIONS[item.status]} />
  </li>;
}

/**
 * 커뮤니티 운영 — 신고 대기 · 다시 볼 것 · 회원 제재 · 공지 · 최근 처리. docs/COMMUNITY-PLAN.md §3 "신고·운영"
 * ★ 신고만으로 글이 내려가지 않는다(자동 내림 없음). 목록은 개인정보 노출·명예훼손이 먼저다.
 */
export default async function AdminCommunityPage({ searchParams }: { searchParams: Promise<{ member?: string }> }) {
  const { member: memberParam } = await searchParams;
  let queue, review, recent, member;
  try {
    queue = await listReportQueue();
    review = await listReviewQueue();
    recent = await listRecentModeration();
    member = isUuid(memberParam) ? await getMemberForAdmin(memberParam) : null;
  } catch (e) {
    return <SetupNotice error={e} />;
  }
  const now = Date.now();
  return <div className="space-y-6">
    {member && <Card title={`회원 — ${member.nickname ?? "탈퇴한 회원"}`} description={`가입 ${when(member.created_at)}${member.status === "withdrawn" ? " · 탈퇴" : ""}`}
      actions={<Link href="/admin/community" className="text-xs text-ink-400 hover:underline">닫기</Link>}>
      {member.sanctions.length === 0 ? <p className="text-sm text-ink-400">제재 기록이 없습니다.</p> : <ul className="divide-y divide-ink-800 text-sm">
        {member.sanctions.map((s) => {
          const active = !s.lifted_at && (s.ends_at === null || new Date(s.ends_at).getTime() > now);
          return <li key={s.id} className="flex flex-wrap items-center gap-2 py-2">
            <Tag tone={active ? "warn" : "neutral"}>{active ? "제한 중" : s.lifted_at ? "풀림" : "끝남"}</Tag>
            <span>{when(s.created_at)} ~ {s.ends_at ? when(s.ends_at) : "영구"}</span>
            <span className="text-ink-400">{s.reason}</span>
            {active && <LiftSanctionForm sanctionId={s.id} />}
          </li>;
        })}
      </ul>}
      {member.status === "active" && <SanctionForm memberId={member.member_id} />}
    </Card>}

    <Card title={`신고 대기 ${queue.length}건`} description="개인정보 노출·명예훼손이 먼저, 그다음 신고 수 순입니다. 신고만으로 글이 내려가지 않습니다.">
      {queue.length === 0 ? <EmptyState>처리할 신고가 없습니다.</EmptyState>
        : <ul className="divide-y divide-ink-800">{queue.map((item) => <QueueItem key={`${item.kind}:${item.target_id}`} item={item} />)}</ul>}
    </Card>

    <Card title={`다시 볼 것 ${review.length}건`} description={`숨김·임시조치가 ${REVIEW_AFTER_DAYS}일 넘게 그대로인 글입니다. 자동으로 되살리지 않습니다 — 삭제하거나 해제하세요.`}>
      {review.length === 0 ? <EmptyState>다시 볼 글이 없습니다.</EmptyState> : <ul className="divide-y divide-ink-800">
        {review.map((r) => <li key={`${r.kind}:${r.target_id}`} className="py-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Tag>{r.kind === "post" ? "글" : "댓글"} #{r.target_id}</Tag>
            <Tag tone="accent">{MODERATION_ACTION_LABEL[r.action]}</Tag>
            <span className="text-ink-400">{when(r.since)}부터 · {r.reason}</span>
            {r.title && <span className="font-medium">{r.title}</span>}
          </div>
          <ModerateForm kind={r.kind} targetId={r.target_id} actions={["delete", "restore", "blind"]} />
        </li>)}
      </ul>}
    </Card>

    <Card title="공지 쓰기" description="작성자는 '운영자' 로 보입니다. 목록 위 띠에 최근 2개가 걸립니다.">
      <NoticeForm />
    </Card>

    <Card title="최근 처리">
      {recent.length === 0 ? <EmptyState>처리 기록이 없습니다.</EmptyState> : <ul className="divide-y divide-ink-800 text-xs">
        {recent.map((r, i) => <li key={i} className="flex flex-wrap gap-2 py-2">
          <span className="text-ink-400">{when(r.created_at)}</span>
          <span>{r.kind === "post" ? "글" : "댓글"} #{r.target_id}</span>
          <b>{MODERATION_ACTION_LABEL[r.action]}</b>
          <span className="text-ink-300">{r.reason}</span>
          <span className="text-ink-400">· {r.actor}</span>
        </li>)}
      </ul>}
    </Card>
  </div>;
}
