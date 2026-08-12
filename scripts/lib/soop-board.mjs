/**
 * SOOP 방송국 **게시판**. 내전·대회 공지와 **참가 신청 명단**이 여기 있다.
 *
 * ★ 왜 중요한가
 *   참가 신청 댓글은 `user_id`(SOOP 채널 아이디)를 그대로 준다. 우리
 *   `streamer_channel.channel_id` 와 **같은 키**라 이름 대조도 OCR 도 필요 없다.
 *   실측에서 신청자 12명 중 8명이 즉시 붙었다. VOD 프레임 판독보다 훨씬 정확하다.
 *
 * ★ 호스트가 둘이다. 헷갈리면 조용히 빈 결과가 온다
 *   · 목록·검색  →  `api-channel.sooplive.com/v1.1/channel/...`   ← 이 파일
 *   · 글 상세·댓글 → `chapi.sooplive.co.kr/api/...`
 *   `chapi` 에서 목록을 찾느라 한참 헤맸다. 거기엔 없다.
 *   찾은 방법: 헤드리스 크로미움으로 게시판 페이지를 열어 네트워크를 잡았다.
 *
 * ★ `/board` 는 **자주 515 를 뱉는다**
 *   `{"code":"CHA0002","message":"An error occurred."}` 가 온다. Retry-After 도
 *   레이트리밋 헤더도 없다. 헤더를 브라우저와 똑같이 맞춰도 재현되므로
 *   **요청 내용 문제가 아니라 호출 빈도 문제**로 본다.
 *   → 호출 사이를 넉넉히 벌리고, 515 는 실패가 아니라 **나중에 다시**로 다룬다.
 *     조용히 0건으로 넘기면 "그날 공지가 없었다"로 잘못 기록된다.
 */

import { soopFetch } from "./soop-http.mjs";

const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const H = { "user-agent": UA, referer: "https://www.sooplive.com/", accept: "application/json, text/plain, */*" };
const CHANNEL_API = "https://api-channel.sooplive.com/v1.1/channel";
const CHAPI = "https://chapi.sooplive.co.kr/api";

/**
 * 515 를 만나면 **재시도하지 않는다.** 던진다.
 *
 * 처음엔 20초·40초 백오프로 3번 재시도하게 짰는데, 실측해 보니 이건 차단을
 * 늘리기만 한다 — 한 번 걸리면 **10분 넘게 안 풀리고**, 그 사이 계속 두드리면
 * 시계가 다시 돈다(브라우저로 때려도 똑같이 515 였다. IP 단위다).
 *
 * 그래서 규칙은 하나다: **막히면 물러난다.** 호출부가 `BoardBlocked` 를 보고
 * 그 판을 접고 다음 실행에 맡긴다. 0건으로 위장하지만 않으면 데이터는 안 상한다.
 */
export class BoardBlocked extends Error {
  constructor(url) {
    super(`SOOP 515 (CHA0002) — 게시판이 막혔다. 물러난다: ${url.slice(0, 90)}`);
    this.name = "BoardBlocked";
  }
}

async function getJson(url) {
  const r = await soopFetch(url, { headers: H });
  if (r.ok) return r.json();
  if (r.status === 515) throw new BoardBlocked(url);
  throw new Error(`SOOP ${r.status} — ${url.slice(0, 110)}`);
}

/**
 * 글 목록.
 *
 * `keyword` 를 주면 **게시판 전체를 가로질러** 검색한다(`bbsNo` 불필요).
 * 날짜로 훑을 때는 `bbsNo` 를 주는 편이 안정적이다.
 */
export async function posts(channelId, { bbsNo = "", keyword = "", from = "", to = "", page = 1, perPage = 20 } = {}) {
  const q = new URLSearchParams({
    perPage: String(perPage), page: String(page),
    startDate: from, endDate: to,
    // 이 field 목록은 웹이 보내는 것 그대로다. 줄이면 검색 대상이 좁아진다.
    field: "title,contents,user_nick,user_id,hashtags",
    keyword, type: "all", orderBy: "reg_date", bbsNo: String(bbsNo),
  });
  const d = await getJson(`${CHANNEL_API}/${channelId}/board?${q}`);
  return {
    total: d?.meta?.totalItems ?? 0,
    posts: (d?.contents ?? []).map((t) => ({
      title_no: t.titleNo,
      bbs_no: t.bbsNo,
      title: t.titleName,
      author_nick: t.userNick,
      author_id: t.userId,
      at: t.regDate,
      comments: t.countInfo?.commentCnt ?? t.commentCnt ?? 0,
      url: `https://www.sooplive.com/station/${channelId}/post/${t.titleNo}`,
    })),
  };
}

/**
 * 댓글 = **참가 신청 명단**.
 *
 * `user_id` 가 SOOP 채널 아이디다. 닉네임과 달리 바뀌지 않는다 —
 * 등록 안 된 사람도 이 값으로 남겨 두면 나중에 등록될 때 과거가 이어진다.
 * 이쪽은 `chapi` 호스트다(위 주석 참고).
 */
export async function comments(channelId, titleNo) {
  const r = await soopFetch(`${CHAPI}/${channelId}/title/${titleNo}/comment`, { headers: H });
  if (!r.ok) throw new Error(`SOOP ${r.status} — comment ${channelId}/${titleNo}`);
  const d = await r.json();
  return (d?.data ?? []).map((c) => ({
    channel_id: c.user_id,
    nickname: c.user_nick,
    // 원문 그대로 둔다. '탑 골중 / 원딜 플하' 같은 문구는 파싱이 틀려도 다시 할 수 있어야 한다.
    text: (c.comment ?? "").trim(),
    at: c.reg_date,
  }));
}
