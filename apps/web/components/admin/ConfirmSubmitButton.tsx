"use client";
import { useFormStatus } from "react-dom";
import type { ReactNode } from "react";
export function ConfirmSubmitButton({ message, children }: { message: string; children: ReactNode }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} onClick={e => { if (!window.confirm(message)) e.preventDefault(); }} className="rounded-md border border-lose/40 px-2 py-1 text-xs text-lose disabled:opacity-50">{pending ? "처리 중…" : children}</button>;
}
