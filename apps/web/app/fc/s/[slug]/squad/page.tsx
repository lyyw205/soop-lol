import { redirect } from "next/navigation";
import { profileHref } from "@soop-lol/core/lib/site-paths";

/** 예전 스쿼드 분석 주소는 개인기록 카드 아래의 스쿼드 탭으로 보낸다. */
export default async function FcSquadRedirect({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(profileHref("fconline", slug, { tab: "squad" }));
}
