import { readMemoReferences } from "@/lib/ck-memo";

// Covered by the existing /admin authentication boundary. No DB or network writes.
export async function GET(_request: Request, { params }: { params: Promise<{ vod: string }> }) {
  const { vod } = await params;
  const references = await readMemoReferences(vod);
  return Response.json(references ?? { error: "메모장 수집 자료가 없습니다." }, {
    status: references ? 200 : 404,
    headers: { "Cache-Control": "private, no-store" },
  });
}
