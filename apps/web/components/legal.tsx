import type { ReactNode } from "react";

import { PageShell, SiteHeader } from "@/components/public";

/**
 * 약관·처리방침·운영정책 화면의 틀. ★ 내용은 초안이다 — 서비스 이름(미정)과 법률 검토가 끝나야 확정한다
 * (docs/COMMUNITY-PLAN.md §9). 화면에도 그렇게 적어 둔다 — 확정된 문서처럼 보이면 거짓이다.
 */
export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return <>
    <SiteHeader site="platform" />
    <PageShell>
      <article className="legal-doc arena-panel">
        <h1>{title}</h1>
        <p className="member-alert">초안입니다. 서비스 이름과 내용은 출시 전에 확정하고 법률 검토를 받습니다.</p>
        {children}
      </article>
    </PageShell>
  </>;
}
