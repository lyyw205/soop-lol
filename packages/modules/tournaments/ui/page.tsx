/**
 * 대회 모듈 화면. host 가 등록부의 경로(/tournaments, /tournaments/[slug])를 보고 여기를 띄운다.
 * 틀(nav·본문 폭)은 host 가 씌운다 — 여기는 내용만 그린다.
 */
import { cache } from "react";
import { notFound } from "next/navigation";
import { getTournament, listTournaments } from "../server/index.ts";
import { TournamentIndex } from "./tournament-index.tsx";
import { TournamentDetailView } from "./tournament-detail.tsx";
import "./tournaments.css";

type Props = {
  params?: Record<string, string>;
  searchParams: Record<string, string | string[] | undefined>;
};

// 제목과 본문이 같은 요청에서 두 번 읽지 않게 한다.
const load = cache(getTournament);

export async function generateMetadata({ params }: Props) {
  if (!params?.slug) return { title: "대회" };
  return { title: (await load(params.slug))?.event.name ?? "대회 기록" };
}

export default async function TournamentsPage({ params, searchParams }: Props) {
  if (!params?.slug) {
    return <div className="tournament-page"><TournamentIndex events={await listTournaments()} /></div>;
  }
  const data = await load(params.slug);
  if (!data) notFound();
  const tab = typeof searchParams.tab === "string" ? searchParams.tab : "overview";
  return (
    <div className="tournament-page">
      <TournamentDetailView data={data} tab={tab === "matches" ? "bracket" : tab} />
    </div>
  );
}
