import Link from "next/link";

import { countStreamers, listStreamers } from "@soop-lol/core/lib/db/streamers";
import { profileHref } from "@soop-lol/core/lib/site-paths";

import { SetupNotice } from "@/components/admin/SetupNotice";
import { StreamerCreateForm } from "@/components/admin/StreamerForms";
import { Card, EmptyState, Tag } from "@/components/ui";

import { AdminPagination } from "@/components/admin/AdminPagination";
import { adminHref, adminPage } from "@/lib/admin-navigation";

export const dynamic = "force-dynamic";
export const metadata = { title: "스트리머" };

export default async function StreamersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; visibility?: string; unlinked?: string }>;
}) {
  const query = await searchParams;
  const { q } = query;
  const page = adminPage(query.page), size = 50;
  const opts = { q, visibility: ["hidden", "public"].includes(query.visibility ?? "") ? query.visibility : undefined, unlinked: query.unlinked === "1" };
  const href = adminHref("/admin/streamers", { ...query, page });
  let total = 0;

  let streamers;
  try {
    [streamers, total] = await Promise.all([listStreamers({ ...opts, limit: size, offset: (page - 1) * size }), countStreamers(opts)]);
  } catch (e) {
    return <SetupNotice error={e} />;
  }

  return (
    <div className="space-y-6">
      <details className="rounded-lg border border-ink-800 p-4"><summary className="cursor-pointer text-sm text-accent-400">스트리머 등록</summary>
        <div className="mt-4"><StreamerCreateForm /></div>
      </details>

      <Card
        title={`스트리머 ${total}명`}
        actions={
          <form className="flex flex-wrap gap-2">
            <input
              name="q"
              defaultValue={q ?? ""}
              placeholder="이름·아이디 검색"
              className="rounded-lg border border-ink-700 bg-ink-950 px-3 py-1.5 text-sm outline-none focus:border-accent-600"
            />
            <select name="visibility" aria-label="공개 상태" defaultValue={query.visibility ?? ""} className="rounded border border-ink-700 bg-ink-950 px-2 text-xs"><option value="">공개 상태 전체</option><option value="public">공개</option><option value="hidden">숨김</option></select>
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" name="unlinked" value="1" defaultChecked={opts.unlinked} />계정 미연결</label>
            <button className="rounded border border-ink-700 px-3 text-xs">검색</button>
            {(q || query.visibility || opts.unlinked) && <Link href="/admin/streamers" className="self-center text-xs text-ink-400">초기화</Link>}
          </form>
        }
      >
        <AdminPagination href={href} page={page} total={total} size={size} />
        {streamers.length === 0 ? (
          <EmptyState>
            {q ? `"${q}" 에 해당하는 스트리머가 없습니다.` : "아직 등록된 스트리머가 없습니다. 위에서 추가하세요."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-ink-800">
            {streamers.map((s) => (
              <li key={s.id}>
                <Link
                  href={adminHref(`/admin/streamers/${s.id}`, { from: href })}
                  className="flex items-center justify-between gap-4 py-3 hover:bg-ink-800/40"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink-200">{s.display_name}</span>
                      {s.is_pro && <Tag tone="accent">프로 출신</Tag>}
                      {s.visibility === "hidden" && <Tag tone="warn">숨김</Tag>}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-ink-400">
                      {profileHref("lol", s.slug)}
                      {s.channel_id && ` · ${s.platform ?? "soop"} ${s.channel_id}`}
                      {s.channel_count > 1 && ` (+${s.channel_count - 1})`}
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
        <AdminPagination href={href} page={page} total={total} size={size} />
      </Card>
    </div>
  );
}
