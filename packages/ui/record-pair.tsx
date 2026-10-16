import type { Tally } from "@soop-lol/core/lib/contract/client";
import { recordParts } from "./record-pair-model.ts";
import "./record-pair.css";

/**
 * 기록 부품 — **세트와 시리즈를 늘 나란히** 보인다(docs/CLASSIFICATION-REDESIGN-PLAN.md §5.3).
 *
 * ★ 입력은 `tally` 결과 통째다. 화면이 숫자 하나(세트 승수 등)만 꺼내 쓰지 못하게 — 예전엔 화면마다 세트만,
 *   매치만, 랜드는 판 수로 골라 써서 같은 사람의 같은 상대 전적이 화면마다 달랐다.
 * ★ 승·무·패·미상을 숨기지 않는다(record-pair-model). 미상은 패가 아니다.
 * 표본 표기·수기 뱃지는 다음 문서(화면 노출 정리)에서 이 부품에 붙인다.
 *
 * @param subject 숫자가 누구 기준인가(상대전적의 왼쪽 사람). 없으면 생략.
 */
export function RecordPair({ tally, subject, compact = false, className = "" }: {
  tally: Tally; subject?: string; compact?: boolean; className?: string;
}) {
  const rows = [["세트", tally.sets, "세트"], ["시리즈", tally.series, "시리즈"]] as const;
  return <dl className={`record-pair ${className}`} data-compact={compact || undefined}
    aria-label={subject ? `${subject} 기준 전적` : "전적"}>
    {rows.map(([label, counts, unit]) => {
      const parts = recordParts(counts);
      const n = parts.reduce((sum, p) => sum + p.n, 0);
      return <div key={label} className="record-pair-row">
        <dt>{label}</dt>
        <dd>
          {parts.map((p) => <span key={p.key} className="record-pair-part" data-part={p.key}><b>{p.n}</b>{p.label}</span>)}
          <small className="record-pair-total">{n}{unit}</small>
        </dd>
      </div>;
    })}
  </dl>;
}
