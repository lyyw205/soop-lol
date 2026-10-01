import Link from "next/link";
import { profileHref, streamersHref } from "@soop-lol/core/lib/site-paths";
import type { ReactNode } from "react";
import { Avatar } from "@/components/avatar";

import { listStreamerCards } from "@soop-lol/core/lib/db/public";
import {
  isSortDirection, isStreamerSort, nextSortState, sortStreamerCards,
  type SortDirection, type StreamerSort,
} from "@soop-lol/core/lib/metrics/streamer-sort";

import { EmptyLine, PageShell, RankChip } from "@/components/public";

export const metadata = { title: "스트리머" };
export const dynamic = "force-dynamic";

/**
 * 우승 훈장. 챔피언스리그 별처럼 **횟수만큼 트로피를 세운다.**
 *
 * ★ 5회까지는 그 수만큼 세우고, **6회부터는 하나 + `×N`** 이다. 계속 늘어놓으면
 *   한 칸이 줄 전체를 밀어낸다(실측: 9개에서 칸을 넘었다).
 * ⚠ ★·🏆 같은 글리프는 Pretendard 서브셋에 없어 빈 네모가 된다 — SVG 로 그린다.
 */
function Titles({ count }: { count: number }) {
  if (count <= 0) return <span className="record-dash">—</span>;
  const shown = count <= 5 ? count : 1;
  return (
    <span className="streamer-titles" title={`대회 우승 ${count}회`}>
      {Array.from({ length: shown }, (_, i) => (
        <svg key={i} viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="currentColor">
          <path d="M4 2h8v1.2h2.3a.7.7 0 0 1 .7.7c0 2.1-1.3 3.7-3.2 4.1A4.3 4.3 0 0 1 8.7 10v2.3h2a.7.7 0 0 1 0 1.4H5.3a.7.7 0 0 1 0-1.4h2V10a4.3 4.3 0 0 1-3.1-1.9C2.3 7.6 1 6 1 3.9a.7.7 0 0 1 .7-.7H4V2Zm0 2.6H2.5C2.7 5.8 3.3 6.6 4.2 7A6 6 0 0 1 4 5.6V4.6Zm8 0v1c0 .5 0 1-.2 1.4.9-.4 1.5-1.2 1.7-2.4H12Z" />
        </svg>
      ))}
      {count > shown && <b>×{count}</b>}
      <span className="sr-only">우승 {count}회</span>
    </span>
  );
}

export default async function StreamersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; dir?: string }>;
}) {
  const sp = await searchParams;
  const q = sp.q;
  const sort = isStreamerSort(sp.sort) ? sp.sort : "tier";
  const dir: SortDirection = isSortDirection(sp.dir) ? sp.dir : "desc";
  const cards = sortStreamerCards(await listStreamerCards({ q }), sort, dir);

  /**
   * 머리글 링크. 누를 때마다 **내림차순 → 오름차순 → 해제** 로 돈다.
   * 주소에 남기므로 서버 렌더만으로 되고, 정렬한 화면을 그대로 공유할 수 있다.
   */
  function sortHref(column: StreamerSort): string {
    const next = nextSortState({ sort, dir: sort ? dir : undefined }, column);
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    if (next.sort) { params.set("sort", next.sort); params.set("dir", next.dir!); }
    return streamersHref(params);
  }
  function SortHeader({ column, children, className }: { column: StreamerSort; children: ReactNode; className?: string }) {
    const on = sort === column;
    return (
      <th scope="col" className={className} aria-sort={on ? (dir === "asc" ? "ascending" : "descending") : "none"}>
        <Link className="record-sort" href={sortHref(column)} scroll={false}
          aria-label={`${typeof children === "string" ? children : column} 정렬 — ${on ? (dir === "desc" ? "오름차순으로" : "해제") : "내림차순으로"}`}>
          {children}
          {/* ▲▼ 는 Pretendard 서브셋에 없다 — 화살표는 인라인 SVG 로 그린다. */}
          <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true" data-on={on || undefined}
            fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            {on && dir === "asc" ? <path d="M6 9.5V3M3.2 5.8 6 3l2.8 2.8" /> : <path d="M6 2.5V9m-2.8-2.8L6 9l2.8-2.8" />}
          </svg>
        </Link>
      </th>
    );
  }

  return (
    <>
      <PageShell>
        {/* 개인 기록과 같은 2단 틀. 오른쪽은 다음 모듈 자리로 비워 둔다 — 지금 비어 있어도
            본문 폭이 개인 기록·상대전적과 같아야 페이지를 옮겨도 시선 축이 안 흔들린다. */}
        <div className="arena-workspace record-workspace">
        <div className="record-main">
        {/* 전적 검색·대회와 같은 머리글 틀 — .arena-title/.arena-eyebrow. */}
        <div className="arena-title">
          <div>
            <span className="arena-eyebrow">STREAMER ROSTER</span>
            <h1>스트리머</h1>
            {/* ⚠ "티어 높은 순" 이라고 단정하지 않는다. 랭크 기록이 없으면 이름순으로
                떨어지는데, 실제로 지금이 그 상태다 — 화면이 사실이 아닌 말을 하면 안 된다. */}
            <p>
              {cards.length}명 · 머리글을 눌러 정렬합니다. 계정이 여러 개면 가장 높은 계정으로 표시합니다.
            </p>
          </div>

          {/* 검색은 서버 렌더로 충분하다 — 40명 규모에 클라이언트 상태를 둘 이유가 없다. */}
          <form className="flex gap-2" action={streamersHref()}>
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="이름 · 별명 · 채널 아이디"
              aria-label="스트리머 검색"
              className="w-56 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-ink-200 placeholder:text-ink-400 focus:border-accent-600 focus:outline-none"
            />
            <button className="rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-sm text-ink-200 hover:border-ink-600">
              검색
            </button>
          </form>
        </div>

        {cards.length === 0 ? (
          <div className="mt-8">
            <EmptyLine>
              {q ? `"${q}" 에 해당하는 스트리머가 없습니다.` : "아직 등록된 스트리머가 없습니다."}
            </EmptyLine>
          </div>
        ) : (
          /*
           * 카드 격자에서 표로 바꿨다. 한 줄에 셋씩 놓으면 같은 값(티어·경기 수)이 좌우로
           * 어긋나서 세로로 비교가 안 된다 — 이 목록은 "누가 더 높나" 를 보는 자리다.
           * 껍데기는 모스트 챔피언 표와 공유한다(.record-table).
           */
          <div className="record-table-wrap">
            <table className="record-table streamer-table">
              <thead>
                <tr>
                  <th scope="col" className="record-col-rank"><span className="sr-only">순위</span>#</th>
                  <SortHeader column="name" className="record-col-name">스트리머</SortHeader>
                  <th scope="col">방송 채널</th>
                  <SortHeader column="tier">티어</SortHeader>
                  <th scope="col">게임 계정</th>
                  <th scope="col">우승</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((c, index) => {
                  const url = c.channel_url ?? (c.platform === "soop" && c.channel_id
                    ? `https://ch.sooplive.co.kr/${encodeURIComponent(c.channel_id)}` : null);
                  const linkable = url && /^https?:\/\//i.test(url) ? url : null;
                  return (
                    <tr key={c.streamer_id}>
                      <td className="record-col-rank">{index + 1}</td>
                      {/* ⚠ <a> 가 <tr> 을 감쌀 수 없다. 줄 전체를 링크로 만드는 대신
                          이름 칸에 링크를 두고 줄은 hover 로만 반응한다. */}
                      <th scope="row" className="record-col-name">
                        <span className="record-cell-name">
                          <Avatar name={c.display_name} src={c.profile_image_url}
                            channelId={c.platform === "soop" ? c.channel_id : null} />
                          <Link href={profileHref("lol", c.slug)} title={c.display_name}>{c.display_name}</Link>
                          {c.is_pro && <em className="streamer-pro">前프로</em>}
                        </span>
                      </th>
                      <td>
                        {c.channel_id ? (
                          <span className="streamer-channel">
                            <i className="personal-profile-platform" data-platform={c.platform ?? "soop"} aria-hidden="true">
                              {c.platform === "youtube" ? "▶" : c.platform === "soop" ? "S" : "↗"}
                            </i>
                            {linkable
                              ? <a href={linkable} target="_blank" rel="noreferrer noopener" title={linkable}>{c.channel_id}</a>
                              : <span title={c.channel_id}>{c.channel_id}</span>}
                          </span>
                        ) : <span className="record-dash">미등록</span>}
                      </td>
                      <td><RankChip tier={c.tier} division={c.division} leaguePoints={c.league_points} /></td>
                      {/* 대표 계정 하나만 쓴다. 부계정까지 늘어놓으면 이름 칸보다 길어진다. */}
                      <td className="streamer-account">
                        {c.account_name ? (
                          <span title={`${c.account_name}${c.account_tag ? `#${c.account_tag}` : ""}${c.account_count > 1 ? ` 외 ${c.account_count - 1}개` : ""}`}>
                            <b>{c.account_name}</b>
                            {c.account_count > 1 && <small>외 {c.account_count - 1}</small>}
                          </span>
                        ) : <span className="record-dash">미확인</span>}
                      </td>
                      <td><Titles count={c.titles} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        </div>
        <aside className="record-sidebar record-sidebar-empty" aria-label="추가 정보" />
        </div>
      </PageShell>
    </>
  );
}
