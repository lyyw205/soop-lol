/**
 * 커뮤니티 브라우저 계약 — 모듈의 클라이언트 부품이 쓴다. DB·쿠키·비밀값을 가져오지 않는다(타입은 컴파일에 지워진다).
 * 서버 쪽(읽기·쓰기)은 contract/community.ts.
 */
export {
  BODY_MAX, COMMENT_MAX, COMMUNITY_GAME_LABEL, COMMUNITY_GAMES, COMMUNITY_TOPIC_LABEL, MEMBER_TOPICS,
  REPORT_DETAIL_MAX, REPORT_REASON_LABEL, REPORT_REASONS, TAG_MAX, TITLE_MAX,
  parseContentId, parseGameFilter, parseTopicFilter,
} from "../metrics/community.ts";
export type { CommunityGame, CommunityTopic, GameFilter, PostInput, ReportReason } from "../metrics/community.ts";
export type { PublicCommunityComment, PublicCommunityPost, PublicCommunityPostRow } from "../db/community-public.ts";
export { kstDateString } from "../time.ts";
export { loginHref, meHref, profileHref, routeHref } from "../site-paths.ts";
export type { HrefQuery } from "../site-paths.ts";
