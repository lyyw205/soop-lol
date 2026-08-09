import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
};

export default nextConfig;
