"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { loginHref } from "@soop-lol/core/lib/site-paths";

/** 로그인 후 현재 검색·필터·날짜까지 복원한다. */
function CurrentPageLoginLink() {
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const next = pathname === "/login" ? undefined : `${pathname}${query ? `?${query}` : ""}`;
  return <Link href={loginHref(next)} className="header-account">로그인</Link>;
}

export function HeaderLoginLink() {
  return <Suspense fallback={<Link href={loginHref()} className="header-account">로그인</Link>}><CurrentPageLoginLink /></Suspense>;
}
