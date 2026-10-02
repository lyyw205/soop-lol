/**
 * VOD 의 3초 칸 한 장 — `/admin/fco/screen/cell/<VOD>/<전체 초>`. 검수 화면의 앞뒤 프레임 띠가 쓴다.
 * ★ `/admin/*` 아래라 proxy.ts 의 Basic 인증이 자동으로 걸린다(프레임 라우트와 같다). 따로 검사하지 않는다.
 */
import { readCell } from "@/lib/vod-cells";

export async function GET(_request: Request, { params }: { params: Promise<{ vod: string; sec: string }> }) {
  const { vod, sec } = await params;
  const body = /^\d{1,7}$/.test(sec) ? await readCell(vod, Number(sec)) : null;
  if (!body) return new Response("썸네일 칸이 없습니다(시트가 없거나 범위 밖).", { status: 404 });
  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/jpeg",
      "Content-Length": String(body.byteLength),
      // 시트는 한 번 받으면 안 바뀐다.
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
}
