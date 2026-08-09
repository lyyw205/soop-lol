"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

import type { ActionState } from "@/lib/action-state";

const inputClass =
  "w-full rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-200 " +
  "placeholder:text-ink-400/60 outline-none focus:border-accent-600";

export function Field({
  label,
  name,
  hint,
  ...props
}: { label: string; name: string; hint?: ReactNode } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-ink-400">{label}</span>
      <input name={name} className={inputClass} {...props} />
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-ink-400">{hint}</span>}
    </label>
  );
}

export function SelectField({
  label,
  name,
  options,
  hint,
  defaultValue,
}: {
  label: string;
  name: string;
  options: { value: string; label: string }[];
  hint?: ReactNode;
  defaultValue?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs text-ink-400">{label}</span>
      <select name={name} defaultValue={defaultValue} className={inputClass}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <span className="mt-1 block text-[11px] leading-relaxed text-ink-400">{hint}</span>}
    </label>
  );
}

export function CheckField({
  label,
  name,
  defaultChecked,
}: {
  label: string;
  name: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-200">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="size-4 accent-accent-600" />
      {label}
    </label>
  );
}

export function SubmitButton({ children, tone = "primary" }: { children: ReactNode; tone?: "primary" | "ghost" | "danger" }) {
  const { pending } = useFormStatus();
  const tones = {
    primary: "bg-accent-600 text-ink-950 hover:bg-accent-500",
    ghost: "border border-ink-700 text-ink-200 hover:border-ink-600",
    danger: "border border-lose/40 text-lose hover:bg-lose/10",
  } as const;
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded-lg px-3 py-2 text-sm font-medium transition disabled:opacity-50 ${tones[tone]}`}
    >
      {pending ? "처리 중…" : children}
    </button>
  );
}

export function ActionMessage({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return (
    <p className={`text-xs ${state.ok ? "text-win" : "text-lose"}`} role="status">
      {state.message}
    </p>
  );
}
