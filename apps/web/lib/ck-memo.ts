/** Local reference candidates, deliberately separate from evidence and scan progress. */
export interface MemoFrame { at: number; score: number }
export interface MemoGroup {
  key: string;
  kind: "memo";
  from: number;
  to: number;
  representative_at: number;
  thumbnail: string;
  frames: MemoFrame[];
  original?: string;
}
export type MemoVerdict = "memo" | "not_memo" | "unknown";
export interface MemoReferences { vod: string; groups: MemoGroup[]; experimental: boolean;
  model_sha256: string; source_sha256: string; feedback: Record<string, MemoVerdict> }

const finiteTime = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1_000_000;

/** Reject paths and timestamps from malformed sidecars before sending them to the client. */
export function parseMemoReferences(raw: unknown, vod: string): MemoReferences | null {
  if (!/^\d{1,12}$/.test(vod) || !raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.model_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.model_sha256)
    || typeof data.source_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(data.source_sha256)) return null;
  if (data.schema !== 1 || data.vod !== vod || data.kind !== "memo_references" || !Array.isArray(data.groups) || data.groups.length > 10_000) return null;
  const groups: MemoGroup[] = [], keys = new Set<string>();
  let totalFrames = 0, previousEnd = -1;
  for (const item of data.groups) {
    if (!item || typeof item !== "object") return null;
    const g = item as Record<string, unknown>;
    if (g.kind !== "memo" || typeof g.key !== "string" || keys.has(g.key)
      || !finiteTime(g.from) || !finiteTime(g.to) || g.to < g.from || g.from <= previousEnd
      || !finiteTime(g.representative_at) || g.representative_at < g.from || g.representative_at > g.to
      || g.key !== `${vod}:${Math.round(g.from * 1000)}:memo`
      || typeof g.thumbnail !== "string" || !new RegExp(`^ck/${vod}/local/memo/[a-f0-9]{16}/t\\d+\\.jpg$`).test(g.thumbnail)
      || !Array.isArray(g.frames) || g.frames.length === 0) return null;
    const frames: MemoFrame[] = [];
    let previousAt = -1;
    for (const f of g.frames) {
      if (!f || typeof f !== "object" || !finiteTime(f.at) || f.at < g.from || f.at > g.to || f.at <= previousAt
        || typeof f.score !== "number" || !Number.isFinite(f.score) || f.score < 0 || f.score > 1) return null;
      frames.push({ at: f.at, score: f.score }); previousAt = f.at;
    }
    totalFrames += frames.length;
    if (totalFrames > 250_000 || !frames.some(f => f.at === g.representative_at)) return null;
    groups.push({ key: g.key, kind: "memo", from: g.from, to: g.to, representative_at: g.representative_at, thumbnail: g.thumbnail, frames });
    keys.add(g.key); previousEnd = g.to;
  }
  return { vod, groups, experimental: data.experimental !== false,
    model_sha256: data.model_sha256, source_sha256: data.source_sha256, feedback: {} };
}

export async function readMemoReferences(vod: string): Promise<MemoReferences | null> {
  if (!/^\d{1,12}$/.test(vod) || !process.env.CK_OUT_ROOT) return null;
  const fs = await import("node:fs/promises");
  const { resolve, join, sep } = await import("node:path");
  try {
    const root = await fs.realpath(resolve(process.env.CK_OUT_ROOT));
    const file = await fs.realpath(join(root, "ck", vod, "local", "memo.json"));
    if (!file.startsWith(root + sep) || (await fs.stat(file)).size > 8_000_000) return null;
    const raw = JSON.parse(await fs.readFile(file, "utf8"));
    const meta = await fs.realpath(join(root, "ck", vod, "local", "sheets.json"));
    if (!meta.startsWith(root + sep) || (await fs.stat(meta)).size > 4_000_000) return null;
    const { createHash } = await import("node:crypto");
    if (createHash("sha256").update(await fs.readFile(meta)).digest("hex") !== raw.source_sha256) return null;
    const data = parseMemoReferences(raw, vod);
    if (!data) return null;
    const { readMemoFeedback } = await import("./ck-memo-feedback.ts");
    data.feedback = await readMemoFeedback(vod, data.source_sha256);
    // Reuse already extracted originals only. Reading this endpoint never downloads video.
    await Promise.all(data.groups.map(async g => {
      const rel = `ck/${vod}/g${String(Math.round(g.representative_at)).padStart(7, "0")}.jpg`;
      try {
        const original = await fs.realpath(join(root, rel));
        if (original.startsWith(root + sep) && (await fs.stat(original)).isFile()) g.original = rel;
      } catch { /* Thumbnail and VOD link remain usable. */ }
    }));
    return data;
  } catch { return null; }
}
