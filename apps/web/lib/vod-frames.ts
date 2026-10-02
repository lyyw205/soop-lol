/**
 * 한 VOD 에서 뽑아 둔 프레임 목록 — `out/ck/<VOD>/g<초 7자리>.jpg`.
 *
 * 검수자가 "결과 화면 앞뒤"를 보고 맥락을 판단하려면 조사가 근거로 건 몇 장만이 아니라 디스크에 있는 전부가 필요하다.
 * 프레임 라우트(`/admin/ck/frame/...`)와 같은 규칙으로 `CK_OUT_ROOT` 에서만 읽는다(배포 서버에는 프레임이 없으므로 빈 목록).
 * ★ fs 를 동적으로 import 한다 — 정적 import 면 빌드가 프로젝트 전체를 추적한다(라우트 머리말의 실측 경고).
 */
export interface VodFrame { sec: number; path: string }

export async function listVodFrames(vod: string): Promise<VodFrame[]> {
  const root = process.env.CK_OUT_ROOT;
  if (!root || !/^\d{1,12}$/.test(vod)) return [];
  const fs = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    const names = await fs.readdir(join(root, "ck", vod));
    const out: VodFrame[] = [];
    for (const name of names) {
      const m = /^g(\d{7})\.jpg$/.exec(name);
      if (m) out.push({ sec: Number(m[1]), path: `out/ck/${vod}/${name}` });
    }
    return out.sort((a, b) => a.sec - b.sec);
  } catch {
    return [];
  }
}
