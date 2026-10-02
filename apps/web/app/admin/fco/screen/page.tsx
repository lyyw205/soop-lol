import Link from "next/link";

import { listScreenReviewVods } from "@soop-lol/core/lib/games/fconline/screen-review";

import { Card, EmptyState } from "@/components/ui";

export const metadata = { title: "FC 화면 경기 검수" };
export const dynamic = "force-dynamic";

/**
 * VOD 목록 (1층). 하나를 고르면 3칸 작업대(2층)로 들어간다 — 경기 검수와 같은 구조.
 * 화면 경기는 API 상세가 없고 숨김(visibility='hidden')이다. 여기서 보는 것·완료하는 것은 공개를 바꾸지 않는다.
 */

const kst = (iso: string) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

export default async function FcoScreenListPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view = "todo" } = await searchParams;
  const all = await listScreenReviewVods();
  const todo = all.filter((v) => v.completed < v.total);
  const rows = view === "all" ? all : todo;
  const TABS = [{ key: "todo", label: "미완료 VOD", n: todo.length }, { key: "all", label: "전체", n: all.length }] as const;
  const totals = all.reduce((a, v) => ({ total: a.total + v.total, completed: a.completed + v.completed, linked: a.linked + v.linked }), { total: 0, completed: 0, linked: 0 });

  return (
    <div className="grid gap-6">
      <Card
        title="FC 화면 경기 검수"
        description="VOD 결과 화면에서 읽은 경기입니다. 넥슨 API 에 없거나 아직 못 이은 경기를 근거 프레임과 대조해 값을 고치고, 같은 경기를 잇고, 완료합니다. 공개에는 나오지 않습니다."
      >
        <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
          {TABS.map((t) => (
            <Link key={t.key} href={`/admin/fco/screen?view=${t.key}`}
              className={`rounded-md border px-2 py-1 ${t.key === view || (t.key === "todo" && view !== "all") ? "border-accent-600/40 bg-accent-600/10 text-accent-400" : "border-ink-700 bg-ink-800 text-ink-400 hover:text-ink-200"}`}>
              {t.label} <b className="ml-0.5 font-semibold">{t.n}</b>
            </Link>
          ))}
          <span className="ml-auto text-ink-400">경기 {totals.total} · 완료 {totals.completed} · 연결 {totals.linked}</span>
          <Link href="/admin/fco" className="text-ink-400 hover:text-ink-200">← FC 맥락 검수</Link>
        </div>

        {rows.length === 0 ? <EmptyState>검수할 화면 경기가 없습니다. VOD 백필(npm run ck:backfill -- --game fconline)이 만듭니다.</EmptyState> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-ink-400"><tr className="border-b border-ink-800"><th className="py-2 pr-3">VOD</th><th className="pr-3">방송</th><th className="pr-3">경기 시각</th><th className="pr-3 text-right">경기</th><th className="pr-3 text-right">완료</th><th className="text-right">연결</th></tr></thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.vod} className="border-b border-ink-800/60 hover:bg-ink-800/40">
                    <td className="py-2 pr-3"><Link href={`/admin/fco/screen/${v.vod}`} className="text-accent-400 hover:underline">{v.title ?? `VOD ${v.vod}`}</Link><div className="font-mono text-[10px] text-ink-400">{v.vod}</div></td>
                    <td className="pr-3 text-ink-200">{v.streamer ?? v.channel_id ?? "—"}</td>
                    <td className="pr-3 text-ink-400">{kst(v.first_at)}{v.first_at !== v.last_at ? ` ~ ${kst(v.last_at)}` : ""}</td>
                    <td className="pr-3 text-right font-mono">{v.total}</td>
                    <td className={`pr-3 text-right font-mono ${v.completed === v.total ? "text-win" : "text-ink-200"}`}>{v.completed}/{v.total}</td>
                    <td className="text-right font-mono text-ink-400">{v.linked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
