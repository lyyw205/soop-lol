/**
 * SOOP 멸망전 **FA 등록** 명단. 스트리머가 대회 신청 때 본인 손으로 입력한
 * 라이엇 ID 가 들어 있다 — 근거 있는 계정 매핑(§11-2)의 1차 소스다.
 *
 * ★ 세 스크립트(build-soop-fa · identify-candidates · build-meljang)가 각자
 *   이 API 를 fetch 하면서 파라미터가 서로 어긋나기 시작해서 여기로 모았다.
 *
 * ★ 열려 있는 건 **현재 시즌뿐**이다. seasonIdx 를 과거로 내리면 빈 응답이 온다
 *   (2026-08-11 확인). 그래서 빈 결과는 "그 시즌이 닫혔다"는 뜻일 수 있다 —
 *   호출부가 구분할 수 있게 null 이 아니라 빈 배열을 돌려주고, 네트워크 실패만 던진다.
 */

import { soopFetch } from "./soop-http.mjs";

/** 사람이 보는 페이지. evidence.url 로 쓴다 — 출처를 되짚을 수 있어야 한다. */
export const faPageUrl = (season) => `https://bjmatchfa.sooplive.com/fa/${season}`;

/**
 * FA 등록자 전원. `userId`(SOOP 채널 아이디) · `userNick` · `gameNick`(대표 라이엇 ID)
 * · `totalGameNickList`(부계 포함 전체) 를 그대로 돌려준다.
 *
 * ⚠ 라이엇 ID 표기는 SOOP 쪽이라 정본과 어긋날 수 있다(태그 공백 등).
 *   여기서 해석하지 않는다 — 정본은 항상 Riot account-v1 이다.
 */
export async function fetchFaList(season, { perPage = 1000 } = {}) {
  const res = await soopFetch("https://gpapi.sooplive.com/api/v1/bjmatchfa/fa/list", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      orderType: "point_desc", filter: [], searchBjNick: "", minPoint: 0,
      maxPoint: 1000, positionIdx: "", pageNo: 1, perPageNo: perPage, seasonIdx: season,
    }),
  });
  if (!res.ok) throw new Error(`SOOP FA ${res.status} — seasonIdx=${season}`);
  return (await res.json())?.data?.faList ?? [];
}
