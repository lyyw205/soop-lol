import { redirect } from "next/navigation";

/**
 * 방송(VOD)은 검수 단위가 아니라 경기의 시점이다 — 방송 단위로 검수하면 같은 경기를 방송마다 다시 본다(2026-10-02, 대전 단위로 바꿈).
 * 예전 방송 주소는 「이 방송에 나온 대전」 목록으로 보낸다.
 */
export default async function FcoVodRedirect({ params }: { params: Promise<{ vod: string }> }) {
  const { vod } = await params;
  redirect(`/admin/fco?view=all&vod=${encodeURIComponent(vod)}`);
}
