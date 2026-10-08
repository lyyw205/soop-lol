import Link from "next/link";

import type { SiteGame } from "@soop-lol/core/lib/site-paths";

import { roleHref } from "@/lib/module-links";

import { UpcomingSchedule } from "./upcoming-schedule";

/**
 * 프로필 오른쪽 칸 — "다가오는 일정"(편성표) + "이 스트리머 이야기"(커뮤니티). 롤·FC 프로필이 같이 쓴다.
 *
 * ★ 둘 다 모듈이 채우는 자리라 역할로 묻는다 — 모듈이 없으면 그 패널이 저절로 빠진다(core 는 모듈 이름을 모른다).
 * ★ 커뮤니티 링크는 게임 문맥을 같이 넘긴다 — 롤 프로필에서 들어가면 글쓰기의 게임 기본값이 롤이다(docs/COMMUNITY-PLAN.md §5).
 *   글 수는 세지 않는다 — 비었으면 목록이 "첫 글 쓰기" 를 보여 준다.
 * ★ 둘 다 없으면 빈 칸으로 둔다(본문 폭과 시선 축은 유지된다).
 */
export async function ProfileSidebar({ slug, game }: { slug: string; game: SiteGame }) {
  const schedule = await UpcomingSchedule({ slug });
  const talk = roleHref("community", {}, { game, s: slug });
  if (!schedule && !talk) return <aside className="record-sidebar record-sidebar-empty" aria-label="추가 스트리머 정보" />;
  return (
    <aside className="record-sidebar" aria-label="추가 스트리머 정보">
      {schedule}
      {talk && <section className="arena-panel profile-talk" aria-label="커뮤니티">
        <h2>커뮤니티</h2>
        <p>이 스트리머에 관한 글을 모아 봅니다.</p>
        <Link className="arena-panel-link" href={talk}>이 스트리머 이야기　→</Link>
      </section>}
    </aside>
  );
}
