/**
 * HLS 재생목록 → 세그먼트 · 구간·시각 단위 내려받기. SOOP VOD 의 분할 파일 하나를 다룬다.
 *
 * ★ 왜 따로 있나 (docs/CK-LOCAL-FC-PLAN.md 계열 정리, Codex 검토 2026-10-01)
 *   soop-vod.mjs ↔ vod-timeline.mjs 가 서로를 import 하는 순환이 있었다(vod-timeline 이 hlsSegments 를, soop-vod 가 시트 함수를).
 *   지금은 최상위 코드가 상수·함수 선언뿐이라 무해했지만, 한쪽에 상대 값을 쓰는 최상위 const 가 생기는 순간 깨진다.
 *   이 모듈은 soop-http 만 의존한다 — 의존 방향은 soop-vod → vod-timeline → vod-hls, soop-vod → vod-hls 로 한쪽이다.
 *   soop-vod.mjs 가 다시 export 하므로 기존 호출부는 그대로다.
 */
import { soopFetch } from "./soop-http.mjs";

const UA = { "User-Agent": "Mozilla/5.0" };

/**
 * HLS 세그먼트 목록. 6초짜리라 **원하는 시각의 세그먼트 하나만** 받으면 된다
 * (1080p 세그먼트 ~6MB). 전체를 내려받을 이유가 없다.
 *
 * `prefer` 로 어느 렌디션을 고를지 정한다:
 *   `"video"`(기본)  1080p — 프레임을 뽑을 때. 화면을 읽어야 하므로 해상도가 필요하다
 *   `"audio"`        오디오 전용 트랙이 있으면 그것, 없으면 **가장 낮은 화질**
 *
 * ★ 왜 audio 를 따로 두나: 음성은 **계산보다 확보가 비싸다**
 *   (docs/CK-RESEARCH-PLAN.md §1 — 30분 표본에 HLS 298MB 를 받았다).
 *   1080p 로 오디오를 뜨면 필요한 것의 수십 배를 내려받는다.
 *   ⚠ 오디오 전용 렌디션이 **없는 VOD 가 실재한다**(207602969). 그때는 최저 화질로 간다.
 */
export async function hlsSegments(file, { prefer = "video" } = {}) {
  const master = await soopFetch(file.file, { headers: UA }).then((r) => r.text());
  const lines = master.split("\n").map((l) => l.trim());

  let rel = null;
  let audioOnly = false;

  if (prefer === "audio") {
    // ① 오디오 전용 트랙
    const media = lines.find((l) => l.startsWith("#EXT-X-MEDIA:") && /TYPE=AUDIO(?:,|$)/.test(l));
    const uri = media?.match(/URI="([^"]+)"/)?.[1];
    if (uri) { rel = uri; audioOnly = true; }
    // ② 없으면 가장 낮은 대역폭 변형 — 소리는 같고 그림만 작다
    if (!rel) {
      let best = null;
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("#EXT-X-STREAM-INF:") || !lines[i + 1] || lines[i + 1].startsWith("#")) continue;
        const bw = Number(lines[i].match(/BANDWIDTH=(\d+)/)?.[1] ?? Infinity);
        if (!best || bw < best.bw) best = { bw, uri: lines[i + 1] };
      }
      rel = best?.uri ?? null;
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("1920x1080") && lines[i + 1]?.trim()) { rel = lines[i + 1]; break; }
    }
  }

  // 변형 목록이 없는 미디어 플레이리스트도 있다 — 그러면 그 자체가 재생목록이다.
  // ★ 그 경우 첫 비주석 줄은 재생목록이 아니라 **첫 세그먼트**(seg-0.m4s)다. 예전엔 그걸 재생목록으로
  //   다시 받아 읽어 세그먼트가 0개가 됐고, 2019~2020 VOD 여러 개가 "그 시각의 세그먼트가 없다" 로
  //   통째로 '재생 불가' 처럼 보였다(2026-09-26, 2019 시즌1 예선 판독 중 발견).
  const isMediaPlaylist = lines.some((l) => l.startsWith("#EXTINF"));
  if (!rel && !isMediaPlaylist) rel = lines.find((l) => l && !l.startsWith("#"));
  const base = rel ? new URL(rel, file.file).href : file.file;
  const dir = base.slice(0, base.lastIndexOf("/"));
  const pl = rel ? (await soopFetch(base, { headers: UA }).then((r) => r.text())).split("\n") : lines;

  const segs = [];
  let t = 0;
  for (let i = 0; i < pl.length; i++) {
    const m = /^#EXTINF:([\d.]+)/.exec(pl[i]);
    if (!m) continue;
    segs.push({ start: t, dur: Number(m[1]), uri: pl[i + 1].trim() });
    t += Number(m[1]);
  }
  const mapUri = pl.find((l) => l.includes("EXT-X-MAP"))?.match(/URI="([^"]+)"/)?.[1];
  const init = mapUri ? await soopFetch(`${dir}/${mapUri}`, { headers: UA }).then((r) => r.arrayBuffer()) : null;
  return { segs, dir, init, audioOnly };
}

/**
 * 한 구간(`[sec, sec+span)`)을 담은 세그먼트들을 이어 받는다.
 *
 * `segmentAt` 은 한 장(프레임용)이고 이건 **구간**(음성용)이다. 구간이 6초 세그먼트
 * 여러 개에 걸치므로 걸치는 것들을 전부 받아 붙인다.
 * 돌려주는 `offset` 은 받은 조각의 맨 앞에서 요청 시각까지의 거리다 — ffmpeg `-ss` 에 쓴다.
 */
export async function segmentsSpan({ segs, dir, init }, sec, span) {
  const chosen = segs.filter((s) => s.start + s.dur > sec && s.start < sec + span);
  if (chosen.length === 0) return null;
  const parts = [Buffer.from(init ?? [])];
  let bytes = 0;
  for (const s of chosen) {
    const buf = await soopFetch(`${dir}/${s.uri}`, { headers: UA }).then((r) => r.arrayBuffer());
    bytes += buf.byteLength;
    parts.push(Buffer.from(buf));
  }
  return { data: Buffer.concat(parts), offset: sec - chosen[0].start, bytes, segments: chosen.length };
}

/** 그 시각을 담은 세그먼트를 받는다. `init` 과 이어붙이면 재생 가능한 조각이 된다. */
export async function segmentAt({ segs, dir, init }, sec) {
  const idx = segs.findIndex((s) => sec >= s.start && sec < s.start + s.dur);
  if (idx < 0) return null;
  const buf = await soopFetch(`${dir}/${segs[idx].uri}`, { headers: UA }).then((r) => r.arrayBuffer());
  return { data: Buffer.concat([Buffer.from(init ?? []), Buffer.from(buf)]), offset: sec - segs[idx].start, bytes: buf.byteLength };
}
