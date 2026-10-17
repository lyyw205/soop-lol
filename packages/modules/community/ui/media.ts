/** 저장된 일반 텍스트에서 독립된 영상 주소만 해석한다. 임의 HTML/리다이렉트/원격 요청 없음. */
export const EMBED_MAX = 5;
export interface VideoEmbed {
  provider: "SOOP" | "YouTube";
  src: string;
  href: string;
  portrait: boolean;
}

function seconds(value: string | null): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Math.min(Number(value), 604800);
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value);
  return m ? Math.min(Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0), 604800) : 0;
}

export function videoEmbed(raw: string): VideoEmbed | null {
  if (!/^https?:\/\//i.test(raw) || /[\s<>"'`\\]/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  let id: string | undefined;
  let portrait = false;
  if (["vod.sooplive.com", "vod.sooplive.co.kr", "vod.afreecatv.com"].includes(host)) {
    const m = /^\/player\/([1-9]\d{0,14})(?:\/(embed|catch))?\/?$/i.exec(url.pathname)
      ?? /^\/(?:ST|PLAYER\/STATION)\/([1-9]\d{0,14})\/?$/i.exec(url.pathname);
    if (!m) return null;
    id = m[1]; portrait = m[2] === "catch";
  } else if (host === "v.afree.ca") {
    id = /^\/ST\/([1-9]\d{0,14})\/?$/i.exec(url.pathname)?.[1];
    if (!id) return null;
  }
  if (id) {
    const href = new URL(portrait ? `https://vod.sooplive.com/player/${id}/catch` : `https://vod.sooplive.com/player/${id}`);
    const src = new URL(`https://vod.sooplive.com/player/${id}/embed`);
    src.searchParams.set("autoPlay", "false");
    src.searchParams.set("showChat", "false");
    const start = seconds(url.searchParams.get("change_second"));
    if (start) { src.searchParams.set("change_second", String(start)); href.searchParams.set("change_second", String(start)); }
    return { provider: "SOOP", src: src.toString(), href: href.toString(), portrait };
  }
  if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
    id = url.pathname === new URL("https://www.youtube.com/watch").pathname ? url.searchParams.get("v") ?? undefined
      : /^\/(?:shorts|live|embed)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    portrait = url.pathname.startsWith(new URL("https://www.youtube.com/shorts/").pathname);
  } else if (host === "youtu.be") {
    id = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  } else if (host === "www.youtube-nocookie.com") {
    id = /^\/embed\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
  }
  if (!id || !/^[\w-]{11}$/.test(id)) return null;
  const src = new URL(`https://www.youtube-nocookie.com/embed/${id}`);
  src.searchParams.set("autoplay", "0"); src.searchParams.set("playsinline", "1");
  const href = new URL(`https://www.youtube.com/watch?v=${id}`);
  const start = seconds(url.searchParams.get("t") ?? url.searchParams.get("start"));
  if (start) { src.searchParams.set("start", String(start)); href.searchParams.set("t", `${start}s`); }
  return { provider: "YouTube", src: src.toString(), href: href.toString(), portrait };
}

export type BodyBlock = { kind: "text"; text: string } | { kind: "video"; video: VideoEmbed };
export function postBodyBlocks(body: string): BodyBlock[] {
  const blocks: BodyBlock[] = [];
  let text = "", count = 0;
  const flush = () => { if (text) blocks.push({ kind: "text", text }); text = ""; };
  for (const line of body.split(/(?<=\n)/)) {
    const video = count < EMBED_MAX ? videoEmbed(line.trim()) : null;
    if (video) { flush(); blocks.push({ kind: "video", video }); count++; }
    else text += line;
  }
  flush();
  return blocks;
}
