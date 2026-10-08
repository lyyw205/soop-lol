/**
 * FC 상대전적 모듈 화면. host 가 /fc/versus 에 띄운다(FC 머리말·본문 폭은 host 의 것).
 * core 의 FC 공개 조회를 계약으로 읽는다.
 */
import {
  fcoMetadata, getFeaturedFcoPair, listFcoPeople, listFcoTopPairs, listFcoVersus,
} from "@soop-lol/core/lib/contract";
import { FcoStatsTable, FcoTournamentPlayers } from "../../../ui/fc/fco-records.tsx";
import { FcRecordSearch } from "../../../ui/fc/fco-record-search.tsx";
import { RecordLayout } from "../../../ui/record-layout.tsx";
import { FcoVersusDetail } from "./fco-versus-detail.tsx";
import { FcoVersusSidebar } from "./fco-versus-sidebar.tsx";
import { versusHref } from "./paths.ts";

type Props = {
  searchParams: Record<string, string | string[] | undefined>;
  /** host 가 역할로 풀어 주는 다른 모듈 링크. 그 모듈이 없으면 null. */
  roleHref: (role: string, params?: Record<string, string>) => string | null;
};

const TABS = ["games", "metrics", "players"] as const;
type VersusTab = typeof TABS[number];

export function generateMetadata() {
  return { title: "상대전적" };
}

export default async function FcVersus({ searchParams: sp, roleHref }: Props) {
  const pick = (key: string) => (typeof sp[key] === "string" ? sp[key] as string : undefined);
  const people = await listFcoPeople();
  const pair = !pick("a") && !pick("b") ? await getFeaturedFcoPair() : null;
  const a = people.find((person) => person.slug === pick("a") || person.id === pair?.aId);
  const b = people.find((person) => (person.slug === pick("b") || person.id === pair?.bId) && person.id !== a?.id);
  const tab: VersusTab = TABS.includes(pick("tab") as VersusTab) ? pick("tab") as VersusTab : "games";
  if (!a || !b) {
    return <RecordLayout sidebar={<aside className="arena-rail record-sidebar" aria-label="스트리머 정보">
      <section className="arena-panel"><h2>스트리머 정보</h2><p className="text-xs text-ink-400">두 스트리머를 선택하면 프로필과 맞대결 기록을 볼 수 있습니다.</p></section>
    </aside>}><FcRecordSearch people={people} a={a?.slug} b={b?.slug} mode="versus" versusPath={versusHref()} /></RecordLayout>;
  }
  const [games, topPairs] = await Promise.all([listFcoVersus(a.id, b.id), listFcoTopPairs(4, a.id)]);
  const names = tab === "players" && games.length ? (await fcoMetadata()).names : new Map<number, string>();
  // 필터·정렬용 클라이언트에는 경기 상세 원본(선수/슛 JSON)을 보내지 않는다.
  // 전체 지표와 선수 표는 서버에서 원본 games로 계산한다.
  const timelineGames = games.map((game) => ({ ...game,
    participants: game.participants.map((participant) => ({ ...participant, match_info: {} })),
  }));
  const eventHrefs = new Map(games.flatMap((game) => game.event_slug ? [[game.event_slug, roleHref("fc-tournaments", { slug: game.event_slug })] as const] : []));
  return <RecordLayout sidebar={<FcoVersusSidebar person={a} games={games} people={people} topPairs={topPairs} opponentId={b.id}
    eventHref={(slug) => eventHrefs.get(slug) ?? null} />}>
    <FcoVersusDetail key={`${a.id}:${b.id}:${tab}`} a={a} b={b} people={people} games={timelineGames} initialTab={tab}
      metrics={<FcoStatsTable games={games} emptyMessage="맞대결 경기 지표가 없습니다." />}
      players={<FcoTournamentPlayers games={games} names={names} emptyMessage="맞대결에서 사용한 선수 기록이 없습니다." />} />
  </RecordLayout>;
}
