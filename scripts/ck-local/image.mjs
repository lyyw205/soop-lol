/**
 * 썸네일 칸 확대·몽타주. ffmpeg 를 칸마다 띄우지 않으려고 jpeg-js 로 직접 한다.
 *
 * ★ 실험 도구(ck-local)의 일부다. 지울 때는 scripts/ck-local/ 폴더째 지운다.
 */
import jpeg from "jpeg-js";

import { FW, FH } from "../lib/vod-timeline.mjs";

// 칸 자르기·빈 칸 판정·시트 해석은 공용 시간축 모듈(scripts/lib/vod-timeline.mjs)에 있다.
export const encode = (img, quality = 85) => jpeg.encode(img, quality).data;

export function blank(width, height, [r, g, b] = [0, 0, 0]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return { width, height, data };
}

/** 쌍선형 확대. 192×108 을 그대로 주면 모델이 보는 조각이 30개도 안 된다. */
export function upscale(img, k) {
  const W = img.width * k, H = img.height * k, out = blank(W, H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(img.height - 1, (y + 0.5) / k - 0.5), y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(img.height - 1, y0 + 1), fy = Math.max(0, sy - y0);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(img.width - 1, (x + 0.5) / k - 0.5), x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(img.width - 1, x0 + 1), fx = Math.max(0, sx - x0);
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = img.data[(y0 * img.width + x0) * 4 + c], b = img.data[(y0 * img.width + x1) * 4 + c];
        const d = img.data[(y1 * img.width + x0) * 4 + c], e = img.data[(y1 * img.width + x1) * 4 + c];
        out.data[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
      }
    }
  }
  return out;
}

// 3×5 숫자 글꼴 — 몽타주 칸 밑에 VOD 시각을 찍는다. Claude 가 "몇 번째 칸" 을 세다 틀리지 않게.
const GLYPH = {
  0: "111101101101111", 1: "010110010010111", 2: "111001111100111", 3: "111001111001111", 4: "101101111001001",
  5: "111100111001111", 6: "111100111101111", 7: "111001010010010", 8: "111101111101111", 9: "111101111001111",
  ":": "000010000010000", " ": "000000000000000", "#": "101111101111101",
};
function text(img, x, y, str, scale, [r, g, b]) {
  for (const ch of str) {
    const bits = GLYPH[ch] ?? GLYPH[" "];
    for (let gy = 0; gy < 5; gy++) for (let gx = 0; gx < 3; gx++) {
      if (bits[gy * 3 + gx] !== "1") continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const px = x + gx * scale + dx, py = y + gy * scale + dy;
        if (px < 0 || py < 0 || px >= img.width || py >= img.height) continue;
        const o = (py * img.width + px) * 4;
        img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b;
      }
    }
    x += 4 * scale;
  }
}

/**
 * 칸들을 격자로 붙인다. 칸마다 테두리 색(분류)과 밑에 시각 글자.
 * @param {{img, color:[number,number,number], label:string}[]} tiles
 */
export function montage(tiles, cols) {
  const B = 4, LH = 16, TW = FW + B * 2, TH = FH + B * 2 + LH;
  const rows = Math.ceil(tiles.length / cols);
  const out = blank(cols * TW, rows * TH, [24, 24, 24]);
  tiles.forEach((t, i) => {
    const ox = (i % cols) * TW, oy = Math.floor(i / cols) * TH;
    for (let y = 0; y < FH + B * 2; y++) for (let x = 0; x < TW; x++) {
      const o = ((oy + y) * out.width + ox + x) * 4;
      const inside = x >= B && x < B + FW && y >= B && y < B + FH;
      if (inside) out.data.set(t.img.data.subarray(((y - B) * FW + (x - B)) * 4, ((y - B) * FW + (x - B)) * 4 + 3), o);
      else { out.data[o] = t.color[0]; out.data[o + 1] = t.color[1]; out.data[o + 2] = t.color[2]; }
    }
    text(out, ox + B, oy + FH + B * 2 + 2, t.label, 2, [235, 235, 235]);
  });
  return out;
}
