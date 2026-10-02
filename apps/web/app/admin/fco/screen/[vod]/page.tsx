import { redirect } from "next/navigation";

/** 화면 경기 작업대는 방송 작업대(/admin/fco/vod/<VOD>)로 합쳐졌다. 예전 주소는 거기로 보낸다. */
export default async function FcoScreenRedirect({ params }: { params: Promise<{ vod: string }> }) {
  const { vod } = await params;
  redirect(`/admin/fco/vod/${encodeURIComponent(vod)}`);
}
