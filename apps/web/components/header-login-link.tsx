"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { loginHref } from "@soop-lol/core/lib/site-paths";

/** 로그인 링크. 지금 보던 화면으로 돌아오도록 경로를 같이 넘긴다(쿼리는 넘기지 않는다). */
export function HeaderLoginLink() {
  const pathname = usePathname();
  return <Link href={loginHref(pathname === "/login" ? undefined : pathname)} className="header-account">로그인</Link>;
}
