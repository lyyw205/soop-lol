"use client";
import { useLayoutEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
/** Save the actual scrolling container. Reapply while expanded list content is loading. */
export function AdminScrollMemory() {
  const pathname = usePathname(), query = useSearchParams().toString();
  useLayoutEffect(() => {
    const key = `admin-scroll:v1:${pathname}?${query}`;
    const containers = [document.querySelector<HTMLElement>(".admin-content"), document.querySelector<HTMLElement>(".admin-workspace"), document.scrollingElement as HTMLElement].filter((el): el is HTMLElement => el !== null);
    let saved: number[] = [];
    try { saved = JSON.parse(sessionStorage.getItem(key) ?? "[]"); } catch { /* optional */ }
    let restoring = saved.some(n => n > 0);
    const restore = () => { if (restoring) containers.forEach((el, i) => { el.scrollTop = saved[i] ?? 0; }); };
    restore();
    const observer = new ResizeObserver(restore);
    containers[0]?.children && Array.from(containers[0].children).forEach(el => observer.observe(el));
    const save = () => { if (!restoring) try { sessionStorage.setItem(key, JSON.stringify(containers.map(el => el.scrollTop))); } catch { /* optional */ } };
    const stop = () => { restoring = false; observer.disconnect(); };
    const timer = window.setTimeout(stop, 2500);
    containers.forEach(el => el.addEventListener("scroll", save, { passive: true }));
    window.addEventListener("wheel", stop, { passive: true }); window.addEventListener("touchstart", stop, { passive: true }); window.addEventListener("keydown", stop);
    return () => { window.clearTimeout(timer); observer.disconnect(); containers.forEach(el => el.removeEventListener("scroll", save)); window.removeEventListener("wheel", stop); window.removeEventListener("touchstart", stop); window.removeEventListener("keydown", stop); };
  }, [pathname, query]);
  return null;
}
