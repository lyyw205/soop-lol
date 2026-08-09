import Link from "next/link";

import { listStreamers } from "@soop-lol/core/lib/db/streamers";

import { SetupNotice } from "@/components/admin/SetupNotice";
import { StreamerCreateForm } from "@/components/admin/StreamerForms";
import { Card, EmptyState, Tag } from "@/components/ui";

export const dynamic = "force-dynamic";
export const metadata = { title: "스트리머" };

export default async function StreamersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const { q } = await searchParams;

  let streamers;
  try {
    streamers = await listStreamers({ q });
  } catch (e) {
    return <SetupNotice error={e} />;
  }

  return (
    <div className="space-y-6">
      <Card
        title="스트리머 등록"
        description="이름과 SOOP 아이디만 있으면 됩니다. 라이엇 계정은 등록 후 상세 화면에서 근거와 함께 붙입니다."
      >
        <StreamerCreateForm />
      </Card>

      <Card
        title={`스트리머 ${streamers.length}명`}
        actions={
          <form className="flex gap-2">
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="이름·아이디 검색"
              className="rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-sm outline-none focus:border-accent-600"
            />
          </form>
        }
      >
        {streamers.length === 0 ? (
          <EmptyState>
            {q ? `"${q}" 에 해당하는 스트리머가 없습니다.` : "아직 등록된 스트리머가 없습니다. 위에서 추가하세요."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-ink-800">
            {streamers.map((s) => (
              <li key={s.id}>
                <Link
                  href={`/admin/streamers/${s.id}`}
                  className="flex items-center justify-between gap-4 py-3 hover:bg-ink-800/40"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink-200">{s.display_name}</span>
                      {s.is_pro && <Tag tone="accent">프로 출신</Tag>}
                      {s.visibility === "hidden" && <Tag tone="warn">숨김</Tag>}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-ink-400">
                      /s/{s.slug}
                      {s.platform_user_id && ` · SOOP ${s.platform_user_id}`}
                    </div>
                  </div>
                  <div className="tabular shrink-0 text-right text-xs text-ink-400">
                    <div>
                      계정 {s.account_count}
                      {s.verified_count > 0 && <span className="text-win"> (확인 {s.verified_count})</span>}
                    </div>
                    <div>경기 {s.match_count.toLocaleString("ko-KR")}</div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
