import { test } from "node:test";
import assert from "node:assert/strict";
import { videoEmbed, postBodyBlocks, EMBED_MAX } from "./media.ts";

test("SOOP current/legacy/share URLs become one official player, discard user iframe parameters", () => {
  for (const url of ["https://vod.sooplive.com/player/192114259", "https://vod.sooplive.co.kr/player/192114259/embed?autoPlay=true&evil=x", "https://vod.afreecatv.com/PLAYER/STATION/192114259", "https://v.afree.ca/ST/192114259"]) {
    const v = videoEmbed(url)!;
    assert.equal(v.provider, "SOOP");
    assert.equal(v.src, "https://vod.sooplive.com/player/192114259/embed?autoPlay=false&showChat=false");
  }
  assert.equal(videoEmbed("https://vod.sooplive.com/player/123/catch")?.portrait, true);
  assert.match(videoEmbed("https://vod.sooplive.com/player/123?change_second=90")!.src, /change_second=90/);
});
test("YouTube watch/share/shorts/live and timestamps", () => {
  for (const url of ["https://www.youtube.com/watch?v=M7lc1UVf-VE&t=1m30s", "https://youtu.be/M7lc1UVf-VE?t=90", "https://m.youtube.com/shorts/M7lc1UVf-VE?start=90", "https://www.youtube.com/live/M7lc1UVf-VE?t=90s"]) {
    const v = videoEmbed(url)!;
    assert.equal(v.provider, "YouTube");
    assert.match(v.src, /^https:\/\/www.youtube-nocookie.com\/embed\/M7lc1UVf-VE\?autoplay=0&playsinline=1&start=90$/);
  }
});
test("untrusted hosts, HTML, schemes, credentials, malformed paths never become frames", () => {
  for (const url of ["javascript:alert(1)", "https://youtube.com.evil.test/watch?v=M7lc1UVf-VE", "https://youtube.com@evil.test/watch?v=M7lc1UVf-VE", "https://x@youtube.com/watch?v=M7lc1UVf-VE", "https://youtube.com:444/watch?v=M7lc1UVf-VE", "https://evil.test/embed/foo", '<iframe src="https://youtu.be/M7lc1UVf-VE"></iframe>', "https://youtube.com/watch?v=bad", "https://vod.sooplive.com/player/123/anything", "https://vod.sooplive.com/player/123\\evil", "https://vod.sooplive.com/player/123%0A", "https://www.youtube.com/redirect?q=https://evil.test", "//youtu.be/M7lc1UVf-VE"]) {
    assert.equal(videoEmbed(url), null, url);
  }
});
test("only standalone URLs embed, ordinary text/CRLF/order preserved; bounded frame count", () => {
  const before = "설명 https://youtu.be/M7lc1UVf-VE\r\n\r\n";
  const after = "\r\n<script>alert(1)</script>\r\n끝";
  const blocks = postBodyBlocks(before + "  https://youtu.be/M7lc1UVf-VE \r\n" + after);
  assert.deepEqual(blocks.filter(x => x.kind === "text").map(x => x.text), [before, after]);
  assert.equal(blocks[1].kind, "video");
  const many = postBodyBlocks(Array(EMBED_MAX + 2).fill("https://youtu.be/M7lc1UVf-VE").join("\n"));
  assert.equal(many.filter(x => x.kind === "video").length, EMBED_MAX);
  assert.equal(many.at(-1)?.kind, "text");
  assert.deepEqual(postBodyBlocks("ordinary\n\ntext"), [{ kind: "text", text: "ordinary\n\ntext" }]);
});
