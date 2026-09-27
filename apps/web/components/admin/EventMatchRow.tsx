import Link from "next/link";
import { ReviewCompletion } from "./ReviewCompletion";
import { ReviewProgressCells } from "./ReviewProgress";

type MatchRow = {
  match_id: string;
  review_version: number;
  review_completed_at: Date | string | null;
  position_count: number;
  linked_count: number;
  champion_count: number;
  kda_count: number;
  label: string;
  playedAt: string;
  winner: string;
  hidden: boolean;
};

export function EventMatchRow({ match, href }: { match: MatchRow; href: string }) {
  return <tr className="ck-event-match-row">
    <th scope="row" className="ck-progress-title">
      <Link href={href} className="ck-event-match-link">
        <span className="ck-event-match-main">
          <span className="text-ink-500">{match.label}</span>
          <span className="ck-event-match-date">{match.playedAt}</span>
          <span className="ck-event-match-winner">{match.winner === "승자 미정" ? match.winner : <><b>{match.winner}</b> 승리</>}</span>
        </span>
      </Link>
      <span className="ck-event-match-actions">
        {match.hidden && <span className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] text-amber-300">공개에서 뺌</span>}
      </span>
    </th>
    <td className="ck-progress-column">
      <ReviewCompletion statusButton matchId={match.match_id} version={match.review_version} completed={!!match.review_completed_at} />
    </td>
    <ReviewProgressCells href={href} matches={1} includeRegistration={false} includeReview={false} completed={match.review_completed_at ? 1 : 0}
      positions={match.position_count} linked={match.linked_count} champions={match.champion_count} kda={match.kda_count} />
  </tr>;
}
