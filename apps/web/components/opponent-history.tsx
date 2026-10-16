import { OpponentHistoryDetail } from "./opponent-history-detail";
import Link from "next/link";
import { Avatar } from "./avatar";
import { headToHead, rawWinRate } from "@soop-lol/core/lib/metrics/affinity";
import type { OpponentSummary } from "@soop-lol/core/lib/metrics/opponent-history";
import type { RecordPeriod } from "@soop-lol/core/lib/metrics/record-period";
import type { FormatFilter, MapTab } from "@soop-lol/core/lib/metrics/record-scope";
import { total } from "@soop-lol/core/lib/metrics/tally";
import type { PublicStreamer } from "@soop-lol/core/lib/contract";
import { roleHref } from "@/lib/module-links";
import { RecordPair } from "../../../packages/ui/record-pair";

/**
 * 프로필 상대 전적 — 상대 한 사람이 한 줄. 숫자는 **세트·시리즈 둘 다**(RecordPair), 승률은 시리즈 기준(무·미상 제외).
 * ★ 상대전적 상세 화면·사이드바와 같은 고르기(맵·진행 방식·기간·맞라인)와 같은 세기(pairResult + tally)다.
 */
export function OpponentHistoryList({ rows, people, slug, streamerName, map, format, period, laneOnly }: {
  rows: OpponentSummary[]; people: PublicStreamer[]; slug: string; streamerName: string;
  map: MapTab; format: FormatFilter; period: RecordPeriod; laneOnly: boolean;
}) {
  const byId = new Map(people.map((p)=>[p.streamer_id,p]));
  if (!rows.length) return <p className="personal-history-empty">선택한 조건에 맞는 {laneOnly ? "맞라인" : "상대"} 기록이 없습니다.</p>;
  return <div className="opponent-history-list">
    {rows.map((r)=>{
      const person = byId.get(r.other_id);
      if (!person) return null;
      const series = r.record.series;
      const rate = rawWinRate(headToHead(series));
      // 상대전적 상세로 같은 필터를 넘긴다 — 열어 본 숫자가 이 줄과 같아야 한다.
      const detailHref = roleHref("versus", {}, {
        a: slug, b: person.slug, map: map === "rift" ? undefined : map, format: format === "all" ? undefined : format,
        from: period.from, to: period.to, relation: laneOnly ? "lane" : undefined,
      });
      return <div key={r.other_id} className="personal-timeline-row opponent-history-row" data-result={series.win===series.loss?"draw":series.win>series.loss?"win":"loss"}>
        <OpponentHistoryDetail key={`${r.other_id}:${map}:${format}:${period.from}:${period.to}:${laneOnly}`} slug={slug} otherId={r.other_id} map={map} format={format} from={period.from} to={period.to} laneOnly={laneOnly}
          summary={
          <summary className="arena-match-toggle personal-match-toggle opponent-history-toggle">
            <span className="opponent-history-person"><Avatar name={person.display_name} src={person.profile_image_url} channelId={person.channel_id ?? undefined} /><strong>{person.display_name}</strong></span>
            <RecordPair tally={r.record} subject={streamerName} compact />
            <span className="opponent-history-rate">{rate===null?"—":`${Math.round(rate*100)}%`}<small>{total(series)}시리즈 · {total(r.record.sets)}세트</small></span>
            <span className="personal-match-expand" aria-hidden="true" />
          </summary>} heading={
            <div className="opponent-history-expanded-heading"><span>{streamerName} vs {person.display_name}</span>{detailHref && <Link href={detailHref}>상대전적 페이지 →</Link>}</div>
          } />
      </div>;
    })}
  </div>;
}
