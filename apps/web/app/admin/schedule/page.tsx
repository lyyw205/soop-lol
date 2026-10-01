import Link from "next/link";

import { listScheduleForAdmin } from "@soop-lol/core/lib/db/schedule";
import {
  ENTRY_STATE_LABEL, SCHEDULE_GAME_LABEL, SCHEDULE_KIND_LABEL, SCHEDULE_SCALE_LABEL,
} from "@soop-lol/core/lib/metrics/schedule";

import { SetupNotice } from "@/components/admin/SetupNotice";
import { Card, EmptyState, Tag } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "편성표" };

/** 편성표 관리. 지난 일정 중 개최 미확인인 것이 맨 위다 — 그걸 '개최 확인'·'무산' 으로 정리하는 게 일상 작업이다. */
export default async function AdminSchedulePage() {
  let rows;
  try {
    rows = await listScheduleForAdmin();
  } catch (e) {
    return <SetupNotice error={e} />;
  }
  const unconfirmed = rows.filter((r) => r.state === "past_unconfirmed").length;
  return (
    <Card
      title={`일정 ${rows.length}개`}
      description={unconfirmed ? `지난 일정 중 개최 확인이 안 된 것 ${unconfirmed}개 — 개최 확인·무산으로 정리해 주세요.` : "공지된 대회·CK·이벤트전을 손으로 넣습니다. 공개하려면 근거 공지가 필요합니다."}
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
              <Tag>{SCHEDULE_SCALE_LABEL[r.scale]} · {SCHEDULE_KIND_LABEL[r.planned_kind]}</Tag>
              <Tag tone={r.state === "past_unconfirmed" ? "warn" : r.state === "held" || r.state === "in_window" ? "accent" : "neutral"}>{ENTRY_STATE_LABEL[r.state]}</Tag>
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
