/**
 * 실시간 캠공유 모듈 화면. 공개 VDO.Ninja 의 방 링크(사람마다 보내기·받기)를 만들어 준다 — 서버·DB 를 쓰지 않는다.
 * 둘이어도 방송인은 서로 주고받으므로 방 하나로 1:1·여러 명을 다 한다.
 * ★ 이름표와 지난 방은 브라우저에서 정한다. 서버에서 만들면 정적 렌더가 모든 방문자에게 같은 이름표를 줄 수 있고,
 *   지난 방은 이 브라우저(localStorage)에만 있다.
 */
import { CamLink } from "./cam-link.tsx";
import "./cam-link.css";

export function generateMetadata() {
  return { title: "실시간 캠공유" };
}

export default function CamLinkPage() {
  return <CamLink />;
}
