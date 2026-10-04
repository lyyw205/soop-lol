/**
 * 최종 순위 목록. 순위마다 출처(공식 발표 / 대진 규칙으로 계산)와 불확실성(일부 경기 결과 추론)을 함께 단다 —
 * 계산한 순위가 공식처럼 보이지 않게. 롤·FC 공통. profileHref 는 호출부가 넘긴다(게임마다 다르다).
 */
import Link from "next/link";
import { Avatar } from "../avatar.tsx";
import { placementNote, type BoardPlacement } from "./bracket-model.ts";
import "./bracket.css";

export function BracketPlacements({ placements, profileHref }: { placements: BoardPlacement[]; profileHref: (slug: string) => string }) {
  return <ol className="bk-places">
    {placements.map((p) => {
      const name = p.entrant.slug ? <Link href={profileHref(p.entrant.slug)}>{p.entrant.name}</Link> : p.entrant.name;
      const note = placementNote(p);
      return <li key={p.entrant.id} className={p.min === 1 ? "bk-place-top" : undefined}>
        <span className="bk-place-rank">{p.rank ?? "—"}</span>
        <span className="bk-face"><Avatar name={p.entrant.name} src={p.entrant.image} channelId={p.entrant.channelId} /></span>
        <span className="bk-place-name">
          <strong>{name}</strong>
          <small data-from={p.from ?? "none"} data-certainty={p.certainty} title={p.evidence ?? undefined}>{note}</small>
        </span>
      </li>;
    })}
  </ol>;
}
