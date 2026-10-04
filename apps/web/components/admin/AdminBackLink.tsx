"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { adminReturn } from "@/lib/admin-navigation";

export function AdminBackLink({ fallback, children = "목록으로" }: { fallback: string; children?: React.ReactNode }) {
  const params = useSearchParams();
  return <Link href={adminReturn(params.get("from"), fallback)} className="text-xs text-ink-400 hover:text-ink-200">← {typeof children === "string" ? children.replace(/^←\s*/, "") : children}</Link>;
}
