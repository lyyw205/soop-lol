/**
 * 판독 프레임 서빙 — `out/ck/<날짜>/*.jpg` 를 검수 화면에 띄운다.
 *
 * ★ 왜 라우트가 필요한가: 프레임은 저장소 밖(`out/`, gitignore)에 있고 Next 의
 *   `public/` 이 아니다. 수만 장이 쌓이는 로컬 산출물을 `public/` 에 두면 빌드가
 *   통째로 끌어안는다. 그래서 읽어서 흘려준다.
 *
 * ★ 인증: 이 라우트는 `/admin/*` 아래라 `apps/web/proxy.ts` 의 Basic 인증이
 *   **자동으로** 걸린다(matcher `/admin/:path*`). 따로 검사하지 않는다 —
 *   두 곳에서 인증을 하면 한쪽이 낡는다.
 *
 * ⚠ 경로 탈출을 막는다. `frame_path` 는 DB 값이지만 DB 에 들어가는 값은 스킬이 쓰고,
 *   신뢰 경계를 파일시스템 접근에 두면 안 된다 — 해석한 실제 경로가 `out/` 밖이면 거부한다.
 *
 * ⚠ **`node:fs` 를 동적으로 import 하는 이유**: 정적 import 로 두면 빌드의 정적 분석이
 *   런타임에 정해지는 이 경로를 보고 "프로젝트 전체를 추적해 배포에 넣겠다" 고 판단한다
 *   (실측 경고: 18,189개 파일). 여기서 읽는 것은 번들에 들어갈 것이 아니다.
 *   ★ 그래서 이 라우트는 **프레임이 디스크에 있는 기계에서만** 동작한다 — 배포된 서버에는
 *     `out/` 이 없으므로 404 를 준다. 배포까지 가면 프레임을 스토리지로 옮겨야 한다.
 */

import { join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

type Fs = typeof import("node:fs/promises");

/**
 * 산출물 뿌리(`out/`). **`CK_OUT_ROOT` 로만 받는다.**
 *
 * ⚠⚠ 예전엔 cwd 에서 `../../out` 으로 거슬러 올라가 찾았다. 그러면 **빌드가 그 상향
 *    경로를 추적 대상으로 잡아 `out/` 을 배포 산출물에 통째로 복사한다** —
 *    실측으로 `.next/standalone` 이 **3.3GB**(프레임 3.2GB 포함)가 됐다.
 *    `outputFileTracingExcludes` 로는 막지 못했다. 정적 분석이 뿌리 밖으로 나가는
 *    경로를 못 보게 하는 것이 유일하게 먹은 방법이다.
 *
 * 그래서 설정을 요구한다 — 이 화면은 프레임이 디스크에 있는 기계에서만 쓰는 도구다.
 *   apps/web/.env.local:  CK_OUT_ROOT=/절대/경로/soop-lol/out
 */
async function outRoot(fs: Fs): Promise<string | null> {
  const configured = process.env.CK_OUT_ROOT;
  if (!configured) return null;
  try {
    const info = await fs.stat(configured);
    return info.isDirectory() ? resolve(configured) : null;
  } catch {
    return null;
  }
}

/** 보관 위치(외장 디스크). 설정이 없거나 마운트가 빠져 있으면 null — 그때 보관된 사진은 404 로 보인다. */
async function archiveRoot(fs: Fs): Promise<string | null> {
  const configured = process.env.CK_ARCHIVE_ROOT;
  if (!configured) return null;
  try { return await fs.realpath(configured); } catch { return null; }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const fs: Fs = await import("node:fs/promises");

  const root = await outRoot(fs);
  if (!root) {
    return new Response(
      "판독 프레임 디렉터리를 찾지 못했습니다.\n"
      + "apps/web/.env.local 에 `CK_OUT_ROOT=<저장소>/out` 을 넣고 개발 서버를 다시 띄우세요.\n"
      + "(배포된 서버에는 프레임이 없습니다 — 이 화면은 판독한 기계에서 씁니다)",
      { status: 503 },
    );
  }

  // DB 의 frame_path 는 `out/ck/…` 로 시작한다. 뿌리를 두 번 붙이지 않는다.
  const rel = path[0] === "out" ? path.slice(1) : path;
  const target = resolve(join(root, ...rel));

  // ★ 해석한 뒤에 검사한다. `..` 은 resolve 가 접은 뒤라야 실제 목적지를 알 수 있다.
  const inside = (p: string) => p === root || p.startsWith(root + sep);
  if (!inside(target)) return new Response("경로를 벗어났습니다.", { status: 403 });

  const type = TYPES[target.slice(target.lastIndexOf(".")).toLowerCase()];
  if (!type) return new Response("이미지 파일만 제공합니다.", { status: 415 });

  try {
    // ★★ **심볼릭 링크 탈출도 막는다.** `resolve` 는 문자열만 접기 때문에,
    //    out/ 안에 바깥을 가리키는 링크가 있으면 위 검사를 그대로 통과한다.
    //    `realpath` 로 링크를 다 따라간 **실제 목적지**를 다시 검사한다.
    //    뿌리 자체가 링크일 수 있으므로 뿌리도 같이 푼다.
    //    예외는 **보관 위치 하나**다(`CK_ARCHIVE_ROOT`, 예: /mnt/d/soop-lol-ck). 조사가 끝난 VOD 폴더는
    //    `ck:archive` 가 외장 디스크로 옮기고 링크만 남긴다(2026-10-09) — 그 링크만 따라가도록 허용한다.
    const realRoot = await fs.realpath(root);
    const real = await fs.realpath(target);
    const archive = await archiveRoot(fs);
    const under = (p: string, base: string) => p === base || p.startsWith(base + sep);
    if (!(under(real, realRoot) || (archive && under(real, archive)))) {
      return new Response("경로를 벗어났습니다(링크).", { status: 403 });
    }

    const info = await fs.stat(real);
    if (!info.isFile()) return new Response("파일이 아닙니다.", { status: 404 });
    const body = await fs.readFile(real);
    return new Response(new Uint8Array(body), {
      headers: {
        "Content-Type": type,
        "Content-Length": String(info.size),
        // 프레임은 한 번 뽑으면 안 바뀐다. 판독 중 같은 장을 여러 번 열므로 캐시가 크게 돕는다.
        "Cache-Control": "private, max-age=86400, immutable",
      },
    });
  } catch {
    // 프레임 파일이 지워졌어도 DB 행은 남는다(디스크를 비웠을 때). 그걸 그대로 말하고, 되살릴 수 있으면 정확한 명령을 준다.
    // ck:probe 는 `out/ck/<VOD>/g<전체 초 7자리>.jpg` 를 같은 이름으로 다시 만든다. 그 밖의 경로(옛 날짜 폴더·ck-local 시트 등)는 못 만든다.
    const g = /^ck\/(\d+)\/g(\d{7})\.jpg$/.exec(rel.join("/"));
    return new Response(g
      ? `프레임 파일이 없습니다. 같은 경로로 다시 뽑으려면:\nnpm run ck:probe -- --vod ${g[1]} --at ${Number(g[2])}`
      : "프레임 파일이 없습니다. 이 경로(옛 날짜 폴더·ck-local 시트 등)는 같은 이름으로 다시 만들 수 없습니다.\n"
        + "같은 시각을 `npm run ck:probe -- --vod <번호> --at <VOD 전체 초>` 로 뽑아 근거를 다시 거세요.", {
      status: 404,
    });
  }
}
