"use client";

/**
 * 판 목록을 10개씩 보여 준다. 판 카드는 서버에서 그려 자식으로 넘긴다 — 여기는 몇 개를 보일지만 안다
 * (계약을 클라이언트 번들로 끌어오지 않게).
 */
import { Children, useState, type ReactNode } from "react";

export function ShowMore({ step = 10, children }: { step?: number; children: ReactNode }) {
  const items = Children.toArray(children);
  const [shown, setShown] = useState(step);
  return (
    <>
      <ol className="sc-games">{items.slice(0, shown)}</ol>
      {shown < items.length && (
        <button type="button" className="sc-more-btn" onClick={() => setShown((n) => n + step)}>
          {Math.min(step, items.length - shown)}개 더보기 <span className="sc-faint">({shown}/{items.length})</span>
        </button>
      )}
    </>
  );
}
