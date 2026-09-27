import Link from "next/link";
import { notFound } from "next/navigation";
import { FCO_MODE_LABEL, getFcoGame, listFcoPeople } from "@soop-lol/core/lib/db/fconline";
import { fcDate } from "../../../../../../packages/ui/fc/fco-records";
import { fcTournamentHref } from "@/lib/module-links";
import { FcoPasses } from "@/components/fco-passes";
import { FcoCompare } from "@/components/fco-compare";
import { FcoFlow } from "@/components/fco-flow";
import { FcoScoreboard } from "@/components/fco-scoreboard";
import { FcoSquad } from "@/components/fco-squad";
import { FcoDetailTabs } from "@/components/fco-detail-tabs";
import { FcoShots } from "@/components/fco-shots";
import { fcoSideView } from "@/lib/fco-match-view";
import { fcoMetadata } from "@soop-lol/core/lib/games/fconline/meta";

export const dynamic = "force-dynamic";

export default async function FcMatchDetail({ params }: { params: Promise<{ matchId: string }> }) {
  const { matchId } = await params;
  const game = await getFcoGame(matchId);
  if (!game) notFound();

  const [meta, people] = await Promise.all([fcoMetadata(), listFcoPeople()]);
  const personById = new Map(people.map((person) => [person.id, person]));
  // 화면 전체가 같은 뷰 모델을 본다. jsonb 를 카드마다 다시 파헤치지 않는다.
  const sides = game.participants.map((participant) => fcoSideView(participant, meta, game.mode_key,
    participant.streamer_id ? personById.get(participant.streamer_id) : null));
  const [a, b] = sides;
  const headline = `${a?.name ?? "미확인"} ${a?.score ?? "?"} : ${b?.score ?? "?"} ${b?.name ?? "미확인"}`;
  const modeLabel = FCO_MODE_LABEL[game.mode_key ?? ""] ?? `모드 ${game.mode_key ?? "미상"}`;

  return <>
    <p className="fc-eyebrow">MATCH DETAIL</p>
    {/* 스코어보드가 같은 내용을 크게 보여주므로 제목은 화면에서 감추고 문서 구조로만 남긴다. */}
    <h1 className="sr-only">{headline}</h1>

    <FcoScoreboard sides={sides} date={fcDate(game.played_at)} mode={modeLabel} event={game.event_name} />

    {game.event_slug && fcTournamentHref(game.event_slug) && <p className="fc-match-event-link">
      <Link className="fc-card-link" href={fcTournamentHref(game.event_slug)!}>대회 기록으로 이동 →</Link>
    </p>}

    <section className="fc-section">
      <h2>경기 흐름</h2>
      <div className="fc-card"><FcoFlow sides={sides} /></div>
    </section>

    {/* 여기부터는 탭 — 한 번에 한 카드만 보여 스크롤을 줄인다 */}
    <FcoDetailTabs tabs={[
      { key: "stats", label: "지표 비교", content: <FcoCompare sides={sides} /> },
      { key: "shots", label: "슛", content: <FcoShots sides={sides} /> },
      { key: "passes", label: "패스", content: <FcoPasses sides={sides} /> },
      { key: "squad", label: "스쿼드", content: <FcoSquad sides={sides} /> },
    ]} />
  </>;
}
