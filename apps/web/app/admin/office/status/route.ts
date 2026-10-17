import { currentAdminAccess } from "@/lib/admin-auth";
import { collectSnapshot } from "@soop-lol/core/lib/ops/collector";
import { readSnapshot } from "@soop-lol/core/lib/ops/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
let fallback: ReturnType<typeof collectSnapshot> | undefined;
let expires = 0;
export async function GET(request: Request) {
  const auth = await currentAdminAccess();
  if (!auth.ok) return Response.json({ error: auth.message }, { status: auth.status });
  const saved = await readSnapshot();
  // Never hide a stopped collector by replacing its old snapshot with a fresh web read.
  if (saved) return Response.json(saved, { headers: { "Cache-Control": "no-store" } });
  if (!fallback || Date.now() > expires) {
    expires = Date.now() + 30_000;
    fallback = collectSnapshot().catch(error => { fallback = undefined; throw error; });
  }
  return Response.json(await fallback, { headers: { "Cache-Control": "no-store" } });
}
