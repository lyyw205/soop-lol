"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Decorative motion only; the server-rendered links also work without JavaScript. */
export function EntranceMotion({ children, className }: { children: ReactNode; className: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const games = [...(ref.current?.querySelectorAll<HTMLElement>("[data-entrance-game]") ?? [])];
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const pointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const controller = new AbortController();
    let pending = 0;

    const reset = () => {
      cancelAnimationFrame(pending);
      games.forEach((game) => {
        for (const property of ["--dx", "--dy", "--x", "--y"]) game.style.removeProperty(property);
      });
    };
    for (const game of games) {
      game.addEventListener("pointermove", (event) => {
        if (reduced.matches || !pointer.matches) return;
        cancelAnimationFrame(pending);
        pending = requestAnimationFrame(() => {
          const rect = game.getBoundingClientRect();
          const x = (event.clientX - rect.left) / rect.width;
          const y = (event.clientY - rect.top) / rect.height;
          game.style.setProperty("--x", `${x * 100}%`);
          game.style.setProperty("--y", `${y * 100}%`);
          game.style.setProperty("--dx", `${(x - .5) * 12}px`);
          game.style.setProperty("--dy", `${(y - .5) * 10}px`);
        });
      }, { signal: controller.signal });
      game.addEventListener("pointerleave", reset, { signal: controller.signal });
    }
    reduced.addEventListener("change", reset, { signal: controller.signal });
    pointer.addEventListener("change", reset, { signal: controller.signal });
    return () => { controller.abort(); reset(); };
  }, []);

  return <div ref={ref} className={className}>{children}</div>;
}
