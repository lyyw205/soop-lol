/**
 * FC 대회 모듈 화면. host 가 /fc/tournaments 와 /fc/tournaments/[slug] 에 띄운다.
 * core 의 FC 공개 조회를 계약으로 읽는다. 경기·스트리머 링크는 core 화면(/fc/m, /fc/s)이다.
 * 틀은 롤 대회 화면(tournaments 모듈)을 레퍼런스로 삼았다 — 배치·크기는 같고 강조색만 FC 것이다.
 */
import { notFound } from "next/navigation";
import { cache } from "react";
import {
  fcMatchHref, fcoMetadata, getEventBracket, getFcoEvent, listFcoClubBoard, listFcoEventGames, listFcoEvents, listFcoPeople,
  resolveBracket,
} from "@soop-lol/core/lib/contract";
import { bracketBoard } from "../../../ui/bracket/bracket-model.ts";
import { entrants } from "./model.ts";
import { DetailView } from "./detail-view.tsx";
import { IndexView } from "./index-view.tsx";
import "./fc-tournaments.css";

type Props = {
  params: Record<string, string>;
  searchParams: Record<string, string | string[] | undefined>;
};

const loadEvent = cache(getFcoEvent);
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : "");

/** 공통 대진(있으면). 경기 칸은 FC 경기 상세(/fc/m)로 잇는다 — 게임마다 다른 것은 이 주소뿐이다. */
async function loadBracket(eventId: string) {
  const bracket = await getEventBracket(eventId);
  if (!bracket) return null;
  return bracketBoard(bracket, resolveBracket(bracket.input), (matchId) =>
    bracket.providerIds[matchId] ? fcMatchHref(bracket.providerIds[matchId]) : null);
}

/** 얼굴 사진은 경기 참가자 칸에 없어 FC 인물 목록에서 붙인다. */
async function peopleInfo() {
  return new Map((await listFcoPeople()).map((p) => [p.id, { image: p.image, channel_id: p.channel_id }]));
}

export async function generateMetadata({ params }: Props) {
  if (!params.slug) return { title: "대회" };
  return { title: (await loadEvent(params.slug))?.name ?? "대회" };
}

export default async function FcTournaments({ params, searchParams }: Props) {
  return <div className="fc-tournament-page">
    {params.slug
      ? <Detail slug={params.slug} tab={one(searchParams.tab)} />
      : <Index q={one(searchParams.q)} year={one(searchParams.year) || "all"} />}
  </div>;
}

async function Index({ q, year }: { q: string; year: string }) {
  const [events, info] = await Promise.all([listFcoEvents(), peopleInfo()]);
  const entries = await Promise.all(events.map(async (event) => {
    const games = await listFcoEventGames(event.id);
    const bracket = await loadBracket(event.id);
    return { event, games, people: entrants(games, info), champion: bracket?.champion?.name ?? null };
  }));
  return <IndexView entries={entries} q={q} year={year} />;
}

async function Detail({ slug, tab }: { slug: string; tab: string }) {
  const event = await loadEvent(slug);
  if (!event) notFound();
  const [games, info, bracket] = await Promise.all([listFcoEventGames(event.id), peopleInfo(), loadBracket(event.id)]);
  const names = games.length ? (await fcoMetadata()).names : new Map<number, string>();
  // 참가자 탭의 구단 정보(현재 값). 대표 계정 = 공식 구단가치가 가장 큰 계정(구단가치 화면과 같은 기준)
  const clubs = tab === "players"
    ? new Map((await listFcoClubBoard()).map((row) => [row.id, row.account]))
    : new Map();
  return <DetailView event={event} games={games} people={info} names={names} tab={tab} bracket={bracket} clubs={clubs} />;
}
