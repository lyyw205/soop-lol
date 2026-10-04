"use client";

/** 서버가 만든 경기 카드를 점진적으로 노출하고 기록실의 특정 경기 링크를 연다. */
import { Children, useEffect, useState, type ReactNode } from "react";

export function ShowMore({ step = 10, gameIds, children }: { step?: number; gameIds: string[]; children: ReactNode }) {
  const items = Children.toArray(children);
  const [shown, setShown] = useState(step);
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    const revealHash = (hash: string) => {
      const id = hash.slice(1);
      const index = gameIds.indexOf(id);
      if (index < 0) return;
      setShown((n) => Math.max(n, Math.ceil((index + 1) / step) * step));
      setTarget(id);
    };
    const reveal = () => revealHash(window.location.hash);
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (!anchor) return;
      const url = new URL(anchor.href);
      if (url.origin === location.origin && url.pathname === location.pathname && url.search === location.search) revealHash(url.hash);
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    document.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("hashchange", reveal);
      document.removeEventListener("click", onClick);
    };
  }, [gameIds, step]);

  useEffect(() => {
    if (!target) return;
    const card = document.getElementById(target);
    const details = card?.querySelector("details");
    if (!card || !details) return;
    details.open = true;
    card.scrollIntoView({ block: "start", behavior: "instant" });
    details.querySelector("summary")?.focus({ preventScroll: true });
    setTarget(null);
  }, [target, shown]);

  if (!items.length) return <p className="sc-empty">이 조건에 해당하는 경기가 아직 없습니다.</p>;

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
