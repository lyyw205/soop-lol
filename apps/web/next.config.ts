import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 별도 UI 검토 서버를 띄울 때 기존 개발 서버의 빌드 캐시·잠금과 분리한다.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // EC2 자체 호스팅(next start) 배포용. `.next/standalone` 에 서버 + 필요한 node_modules 만
  // 담긴 자립 실행본이 나온다.
  // ★ standalone 은 public/ 과 .next/static 을 복사하지 않는다 — 배포 스크립트가 따로 얹어야 한다.
  output: "standalone",

  /**
   * ★ packages/core 는 빌드되지 않은 TS 를 그대로 내보낸다(exports 가 .ts 로 매핑).
   *   워크스페이스 심볼릭 링크라 Next 에게는 node_modules 안의 패키지로 보이므로,
   *   명시하지 않으면 "node_modules 는 이미 컴파일돼 있다"는 기본 가정에 걸린다.
   */
  transpilePackages: ["@soop-lol/core"],

  // postgres.js 는 서버 전용이다. 번들에 끌려들어가지 않게 외부로 뺀다.
  serverExternalPackages: ["postgres"],

  // ⚠ `outputFileTracingExcludes` 를 여기 두지 마라 — **안 먹는다.** 실측:
  //   판독 프레임 라우트가 cwd 에서 `../../out` 으로 거슬러 올라가자 빌드가 `out/`(3.2GB)을
  //   standalone 에 통째로 복사했고(3.3GB), `"*": ["**/out/**"]` 로도 막히지 않았다.
  //   먹은 방법은 **라우트가 뿌리 밖 경로를 계산하지 않게** 하는 것이다 —
  //   `CK_OUT_ROOT` 환경변수로만 받는다. app/admin/ck/frame/[...path]/route.ts 참고.
  //   (그 뒤 67MB)
};

export default nextConfig;
