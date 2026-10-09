import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jpeg from "jpeg-js";
import { readCell } from "./vod-cells.ts";

test("cell lookup crops the same grid cell in both 720p and 1080p sheets", async () => {
  const root = await mkdtemp(join(tmpdir(), "ck-cells-")), previous = process.env.CK_OUT_ROOT;
  process.env.CK_OUT_ROOT = root;
  try {
    for (const [vod, width, height] of [["720", 1280, 720], ["1080", 1920, 1080]] as const) {
      const fw = width / 10, fh = height / 10, pixels = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4, selected = x >= fw && x < fw * 2 && y >= fh && y < fh * 2;
        pixels[i] = selected ? 240 : 0; pixels[i + 2] = selected ? 0 : 240; pixels[i + 3] = 255;
      }
      const directory = join(root, "ck", vod); await mkdir(join(directory, "local"), { recursive: true });
      await writeFile(join(directory, "sheet.jpg"), jpeg.encode({ width, height, data: pixels }, 95).data);
      await writeFile(join(directory, "local/sheets.json"), JSON.stringify({ parts: [{ offset: 0, length: 300, cells: 100, sheets: [`out/ck/${vod}/sheet.jpg`] }] }));
      const image = jpeg.decode((await readCell(vod, 33))!);
      assert.equal(image.width, fw); assert.equal(image.height, fh);
      for (const [x, y] of [[4, 4], [fw - 5, fh - 5], [fw / 2, fh / 2]]) {
        const i = (Math.floor(y) * fw + Math.floor(x)) * 4;
        assert.ok(image.data[i] > 200 && image.data[i + 2] < 40, `wrong cell in ${width}×${height}`);
      }
      assert.equal(await readCell(vod, 300), null);
    }
  } finally {
    if (previous === undefined) delete process.env.CK_OUT_ROOT; else process.env.CK_OUT_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
