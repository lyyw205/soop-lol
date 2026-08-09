import Link from "next/link";
import { notFound } from "next/navigation";

import {
  getStreamer,
  listCareerEvents,
  listStreamerAccounts,
} from "@soop-lol/core/lib/db/streamers";
import { formatRank } from "@soop-lol/core/lib/metrics/lp";

import {
  deleteCareerEventAction,
  setMainAccountAction,
  toggleAccountVisibilityAction,
  unlinkAccountAction,
} from "@/app/admin/actions";
import { AccountLinkForm } from "@/components/admin/AccountLinkForm";
import { CareerEventForm } from "@/components/admin/CareerEventForm";
import { SetupNotice } from "@/components/admin/SetupNotice";
import { StreamerEditForm } from "@/components/admin/StreamerForms";
import { Card, ConfidenceBadge, EmptyState, Tag } from "@/components/ui";
import { hasRiotKey } from "@/lib/riot";

export const dynamic = "force-dynamic";

export default async function StreamerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let streamer, accounts, career;
  try {
    streamer = await getStreamer(id);
    if (!streamer) notFound();
    [accounts, career] = await Promise.all([
      listStreamerAccounts(streamer.id),
      listCareerEvents(streamer.id),
    ]);
  } catch (e) {
    // notFound() 는 예외로 흐르므로 다시 던진다.
    if (e && typeof e === "object" && "digest" in e) throw e;
    return <SetupNotice error={e} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/streamers" className="text-xs text-ink-400 hover:text-ink-200">
          ← 목록
        </Link>
        <h1 className="text-xl font-semibold text-ink-200">{streamer.display_name}</h1>
        {streamer.visibility === "hidden" && <Tag tone="warn">숨김</Tag>}
      </div>

      <Card title="기본 정보">
        <StreamerEditForm streamer={streamer} />
      </Card>

      <Card
        title={`라이엇 계정 ${accounts.length}개`}
        description="근거 없는 매핑은 등록되지 않습니다. 부계정 노출은 실제 분쟁이 됩니다 — 확신이 없으면 신뢰도를 낮게 잡으세요."
      >
        {accounts.length === 0 ? (
          <EmptyState>연결된 계정이 없습니다. 아래에서 추가하세요.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-800">
            {accounts.map((a) => (
              <li key={a.puuid} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-ink-200">
                      {a.game_name ? `${a.game_name}#${a.tag_line ?? "?"}` : "(닉네임 미조회)"}
                    </span>
                    {a.is_main && <Tag tone="accent">대표</Tag>}
                    {a.label && <Tag>{a.label}</Tag>}
                    <ConfidenceBadge confidence={a.confidence} />
                    {a.visibility === "hidden" && <Tag tone="warn">숨김</Tag>}
                  </div>
                  <div className="tabular mt-1 text-xs text-ink-400">
                    {a.tier ? formatRank({ tier: a.tier, division: a.division, leaguePoints: a.league_points }) : "티어 미수집"}
                    {" · "}
                    <span className="font-mono">{a.puuid.slice(0, 16)}…</span>
                  </div>
                  {(a.evidence?.url || a.evidence?.note) && (
                    <div className="mt-1 text-[11px] text-ink-400">
                      근거:{" "}
                      {a.evidence.url ? (
                        <a href={a.evidence.url} className="text-accent-500 hover:underline" target="_blank" rel="noreferrer">
                          {a.evidence.url}
                        </a>
                      ) : null}
                      {a.evidence.url && a.evidence.note ? " · " : null}
                      {a.evidence.note}
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {!a.is_main && (
                    <form action={setMainAccountAction}>
                      <input type="hidden" name="streamer_id" value={streamer.id} />
                      <input type="hidden" name="puuid" value={a.puuid} />
                      <button className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-400 hover:text-ink-200">
                        대표로
                      </button>
                    </form>
                  )}
                  <form action={toggleAccountVisibilityAction}>
                    <input type="hidden" name="streamer_id" value={streamer.id} />
                    <input type="hidden" name="puuid" value={a.puuid} />
                    <input
                      type="hidden"
                      name="next_visibility"
                      value={a.visibility === "hidden" ? "public" : "hidden"}
                    />
                    <button className="rounded-md border border-ink-700 px-2 py-1 text-xs text-ink-400 hover:text-ink-200">
                      {a.visibility === "hidden" ? "공개" : "숨기기"}
                    </button>
                  </form>
                  <form action={unlinkAccountAction}>
                    <input type="hidden" name="streamer_id" value={streamer.id} />
                    <input type="hidden" name="puuid" value={a.puuid} />
                    <button className="rounded-md border border-lose/40 px-2 py-1 text-xs text-lose hover:bg-lose/10">
                      해제
                    </button>
                  </form>
                </div>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 border-t border-ink-800 pt-5">
          <AccountLinkForm streamerId={streamer.id} hasKey={hasRiotKey()} />
        </div>
      </Card>

      <Card
        title={`커리어 ${career.length}건`}
        description="대회 성적은 Riot API 에 없습니다. 전부 수기이고, 공개 화면에서도 '수기' 로 표시됩니다."
      >
        {career.length === 0 ? (
          <EmptyState>등록된 커리어가 없습니다.</EmptyState>
        ) : (
          <ul className="divide-y divide-ink-800">
            {career.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink-200">{c.title}</span>
                    {c.placement && <Tag tone="accent">{c.placement}</Tag>}
                    <Tag>수기</Tag>
                  </div>
                  <div className="mt-0.5 text-xs text-ink-400">
                    {[c.role, c.team_name, c.date_from].filter(Boolean).join(" · ") || "—"}
                  </div>
                </div>
                <form action={deleteCareerEventAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="streamer_id" value={streamer.id} />
                  <button className="rounded-md border border-lose/40 px-2 py-1 text-xs text-lose hover:bg-lose/10">
                    삭제
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-5 border-t border-ink-800 pt-5">
          <CareerEventForm streamerId={streamer.id} />
        </div>
      </Card>
    </div>
  );
}
