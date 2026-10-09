import { readCell } from "@/lib/vod-cells";

export async function GET(_request: Request, { params }: { params: Promise<{ vod: string; sec: string }> }) {
  const { vod, sec } = await params;
  const body = /^\d{1,7}$/.test(sec) ? await readCell(vod, Number(sec)) : null;
  if (!body) return new Response("썸네일이 없습니다. 해당 시점 VOD를 확인하세요.", { status: 404 });
  return new Response(new Uint8Array(body), { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" } });
}
