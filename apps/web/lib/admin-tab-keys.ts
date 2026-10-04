import type { KeyboardEvent } from "react";
/** Keyboard navigation stays within the tabs instead of changing the evidence frame. */
export function adminTabKeys(event: KeyboardEvent<HTMLElement>) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)')];
  if (!tabs.length) return;
  const index = tabs.indexOf(event.target as HTMLButtonElement);
  const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault(); event.stopPropagation(); tabs[next].focus(); tabs[next].click();
}
