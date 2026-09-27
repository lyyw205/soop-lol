import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { vodDetail } from '../lib/soop-vod.mjs';
import { soopFetch } from '../lib/soop-http.mjs';

const vodId = process.argv[2];
if (!/^\d+$/.test(vodId ?? '')) throw new Error('Usage: node scripts/asr/probe-vod.mjs <vodId>');
const out = resolve('.local/asr/runs', vodId);
await mkdir(out, { recursive: true });
const detail = await vodDetail(vodId);
if (!detail?.files?.length) throw new Error('No accessible VOD files');
await writeFile(join(out, 'vod-detail.json'), JSON.stringify(detail, null, 2));
const parts = [];
let offset = 0;
for (const [index, file] of detail.files.entries()) {
  if (!file.file) continue;
  const response = await soopFetch(file.file, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!response.ok) throw new Error(`Master playlist HTTP ${response.status}`);
  const master = await response.text();
  await writeFile(join(out, `part-${index}.master.m3u8`), master);
  const lines = master.split(/\r?\n/).map(x => x.trim());
  const variants = [];
  const audio = [];
  for (const [i, line] of lines.entries()) {
    if (line.startsWith('#EXT-X-MEDIA:') && /TYPE=AUDIO(?:,|$)/.test(line)) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (uri) audio.push({ url: new URL(uri, file.file).href, tag: line });
    }
    if (line.startsWith('#EXT-X-STREAM-INF:') && lines[i + 1] && !lines[i + 1].startsWith('#')) {
      variants.push({ url: new URL(lines[i + 1], file.file).href,
        bandwidth: Number(line.match(/(?:^|,)BANDWIDTH=(\d+)/)?.[1] ?? line.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0),
        resolution: line.match(/RESOLUTION=([^,]+)/)?.[1] ?? null, tag: line });
    }
  }
  const selected = audio[0] ?? variants.sort((a, b) => a.bandwidth - b.bandwidth)[0]
    ?? (lines.some(x => x.startsWith('#EXTINF:')) ? { url: file.file, tag: 'media playlist' } : null);
  if (!selected) throw new Error('No playable HLS rendition');
  const mediaResponse = await soopFetch(selected.url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!mediaResponse.ok) throw new Error(`Media playlist HTTP ${mediaResponse.status}`);
  const media = await mediaResponse.text();
  await writeFile(join(out, `part-${index}.media.m3u8`), media);
  const durations = [...media.matchAll(/#EXTINF:([\d.]+)/g)].map(m => Number(m[1]));
  const actualSeconds = durations.reduce((a, b) => a + b, 0);
  parts.push({ index, offset, declaredSeconds: file.duration / 1000, actualSeconds,
    audioOnly: audio.length > 0, selected, variants, audio, file,
    segments: durations.length, encrypted: /#EXT-X-KEY:/.test(media) });
  offset += file.duration / 1000;
}
const manifest = { vodId, title: detail.title ?? detail.title_name ?? detail.bbs_title,
  owner: detail.writer_nick ?? detail.user_nick, declaredSeconds: offset,
  actualSeconds: parts.reduce((sum, part) => sum + part.actualSeconds, 0), parts };
await writeFile(join(out, 'probe.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ...manifest, parts: parts.map(({ file, selected, variants, audio, ...part }) => ({
  ...part, rendition: selected.tag, variants: variants.map(v => ({ bandwidth: v.bandwidth, resolution: v.resolution }))
})) }, null, 2));
