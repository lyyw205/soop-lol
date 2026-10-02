import Link from "next/link";
import { kstDateString } from "@soop-lol/core/lib/time";

import { listScheduleForAdmin } from "@soop-lol/core/lib/db/schedule";
import {
  ENTRY_STATE_LABEL, SCHEDULE_GAME_LABEL, SCHEDULE_KIND_LABEL,
} from "@soop-lol/core/lib/metrics/schedule";

import { SetupNotice } from "@/components/admin/SetupNotice";
import { Card, EmptyState, Tag } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "편성표" };

/** 날짜가 지났지만 예정·진행중인 일정을 먼저 점검한다. */
export default async function AdminSchedulePage() {
  let rows;
  try {
    rows = await listScheduleForAdmin();
  } catch (e) {
    return <SetupNotice error={e} />;
  }
  const unconfirmed = rows.filter((r) => ((r.state === "upcoming" || r.state === "in_progress") && r.period !== null && r.period.to < kstDateString(new Date()))).length;
  return (
    <Card
      title={`일정 ${rows.length}개`}
      description={unconfirmed ? `날짜가 지났지만 상태가 갱신되지 않은 일정 ${unconfirmed}개 — 완료·취소·연기 여부를 확인해 주세요.` : "공지된 대회·CK·이벤트전을 손으로 넣습니다. 공개하려면 근거 공지가 필요합니다."}
      actions={<Link href="/admin/schedule/new" className="rounded-lg bg-accent-600 px-3 py-2 text-sm font-medium text-ink-950">새 일정</Link>}
    >
      {rows.length === 0 ? <EmptyState>아직 일정이 없습니다.</EmptyState> : (
        <ul className="divide-y divide-ink-800">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
              <span className="w-44 shrink-0 tabular-nums text-ink-400">
                {r.period ? (r.period.from === r.period.to ? r.period.from : `${r.period.from} ~ ${r.period.to.slice(5)}`) : "칸 없음"}
              </span>
              <Link href={`/admin/schedule/${r.id}`} className="font-medium hover:underline">{r.title}</Link>
              <Tag>{SCHEDULE_GAME_LABEL[r.game_code]}</Tag>
              <Tag>{SCHEDULE_KIND_LABEL[r.planned_kind]}</Tag>
              <Tag tone={((r.state === "upcoming" || r.state === "in_progress") && r.period !== null && r.period.to < kstDateString(new Date())) ? "warn" : r.state === "held" || r.state === "in_progress" ? "accent" : "neutral"}>{ENTRY_STATE_LABEL[r.state]}</Tag>
              {r.visibility === "hidden" && <Tag tone="warn">숨김</Tag>}
              {r.visibility === "public" && r.source_count === 0 && <Tag tone="warn">출처 없음 — 공개 안 됨</Tag>}
              {r.event_id && <Tag tone="accent">결과 연결</Tag>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
