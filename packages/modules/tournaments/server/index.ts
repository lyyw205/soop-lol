/**
 * 대회 모듈. core 의 공개 대회 사실(계약)을 읽어 목록·상세를 조립한다.
 * 자기 테이블은 아직 없다 — 전부 요청 때 계산한다. 그래서 잡도 마이그레이션도 없다.
 */
import {
  getPublicTournamentFacts, kstDateString, listMatchRosters, listPublicTournamentEvents,
} from "@soop-lol/core/lib/contract";
import {
  tournamentCategory, tournamentSeries,
  type TournamentDetail, type TournamentSummary, type TournamentTeam,
} from "./tournament.ts";

export * from "./tournament.ts";

export async function listTournaments(): Promise<TournamentSummary[]> {
  const rows = await listPublicTournamentEvents();
  return rows.map((r) => ({
    id: r.event_id,
    slug: r.slug,
    name: r.name,
    kind: r.kind,
    category: tournamentCategory(r.slug, r.kind),
    start: r.starts_at || r.first_match ? kstDateString(r.starts_at ?? r.first_match!) : null,
    end: r.ends_at || r.last_match ? kstDateString(r.ends_at ?? r.last_match!) : null,
    dateFromMatches: r.starts_at == null,
    organizer: r.organizer,
    sourceUrl: r.source_url,
    teamCount: r.team_count,
    seriesCount: r.series_count,
    setCount: r.set_count,
    winner: r.winner,
    searchNames: r.search_names,
  }));
}

export async function getTournament(slug: string): Promise<TournamentDetail | null> {
  const event = (await listTournaments()).find((e) => e.slug === slug);
  if (!event) return null;
  const { teams: teamRows, members, matches, links, facts } = await getPublicTournamentFacts(event.id);
  const roster = await listMatchRosters(matches.map((m) => m.match_id));
  const teams: TournamentTeam[] = teamRows.map((t) => ({
    id: t.event_team_id,
    name: t.name,
    placement: t.placement,
    rank: t.placement_rank,
    prize: t.prize,
    voteRank: t.vote_rank,
    members: members
      .filter((m) => m.event_team_id === t.event_team_id)
      .map((m) => ({
        id: m.streamer_id,
        slug: m.slug,
        name: m.display_name,
        imageUrl: m.profile_image_url,
        channelId: m.channel_id,
        position: m.position,
        isCaptain: m.is_captain === true,
        rating: m.rating_label ? { label: m.rating_label, points: m.rating_points } : null,
        award: m.award,
      })),
  }));
  return { event, teams, series: tournamentSeries(matches, roster), links, facts };
}
