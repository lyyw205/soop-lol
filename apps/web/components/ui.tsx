import type { ReactNode } from "react";

import type { Confidence } from "@soop-lol/core/lib/db/types";

export function Card({
  title,
  description,
  actions,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-ink-800 bg-ink-900/60 p-5">
      {(title || actions) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink-200">{title}</h2>}
            {description && <p className="mt-1 text-xs leading-relaxed text-ink-400">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/60 px-4 py-3">
      <div className="text-xs text-ink-400">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold text-ink-200">{value}</div>
      {hint && <div className="mt-1 text-[11px] text-ink-400">{hint}</div>}
    </div>
  );
}

const CONFIDENCE_STYLE: Record<Confidence, { label: string; className: string }> = {
  verified: { label: "확인됨", className: "border-win/40 bg-win/10 text-win" },
  likely: { label: "추정", className: "border-amber-400/40 bg-amber-400/10 text-amber-300" },
  unverified: { label: "미확인", className: "border-ink-600 bg-ink-800 text-ink-400" },
};

/**
 * 매핑 신뢰도는 **화면에 반드시 노출한다** (docs/PLAN.md §11-2).
 * 미확인 매핑을 확정처럼 보여주면 그게 곧 오정보다.
 */
export function ConfidenceBadge({ confidence }: { confidence: Confidence }) {
  const style = CONFIDENCE_STYLE[confidence] ?? CONFIDENCE_STYLE.unverified;
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${style.className}`}>
      {style.label}
    </span>
  );
}

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "warn" }) {
  const tones = {
    neutral: "border-ink-700 bg-ink-800 text-ink-400",
    accent: "border-accent-600/40 bg-accent-600/10 text-accent-400",
    warn: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  } as const;
  return (
    <span className={`rounded-md border px-2 py-0.5 text-[11px] ${tones[tone]}`}>{children}</span>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-700 px-4 py-8 text-center text-sm text-ink-400">
      {children}
    </div>
  );
}
