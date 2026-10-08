/**
 * 커뮤니티 규칙 — docs/COMMUNITY-PLAN.md §2·§3. 계산은 여기 하나다(접근자·정기 작업·화면이 같이 쓴다 — 원칙 6).
 * DB 를 모른다. 단위 테스트로 지킨다.
 */

const DAY_MS = 86_400_000;

// ── 탈퇴와 재가입 ─────────────────────────────────────────────────────

/** 탈퇴 뒤 같은 소셜 계정으로 다시 가입할 수 없는 기본 기간. 신고 중복 제한·쓰기 한도를 탈퇴로 초기화하는 것을 막는다. */
export const REJOIN_COOLDOWN_DAYS = 30;
/** 영구 제재를 받은 계정의 로그인 연결을 남겨 두는 기간 — 무기한 보관하지 않는다. */
export const PERMANENT_SANCTION_HOLD_DAYS = 365;

export interface SanctionPeriod {
  created_at: Date;
  /** NULL = 영구 */
  ends_at: Date | null;
  lifted_at: Date | null;
}

/**
 * 탈퇴 회원이 같은 소셜 계정으로 다시 가입할 수 있게 되는 시각.
 *
 * ★ 저장하지 않고 그때그때 계산한다 — 탈퇴 뒤에 걸리거나 풀린 제재도 바로 반영된다
 *   (탈퇴 29일째 영구 제재 → 31일째 연결이 지워지는 일이 없다).
 * - 기본: 탈퇴 + 30일
 * - 풀리지 않은 기간 제재: 끝날 때까지(탈퇴 + 30일보다 짧으면 30일)
 * - 풀리지 않은 영구 제재: 제재 시각 + 1년
 */
export function rejoinBlockedUntil(withdrawnAt: Date, sanctions: readonly SanctionPeriod[]): Date {
  let until = withdrawnAt.getTime() + REJOIN_COOLDOWN_DAYS * DAY_MS;
  for (const s of sanctions) {
    if (s.lifted_at) continue;
    const end = s.ends_at ? s.ends_at.getTime() : s.created_at.getTime() + PERMANENT_SANCTION_HOLD_DAYS * DAY_MS;
    if (end > until) until = end;
  }
  return new Date(until);
}

/** 지금 쓰기를 막는 제재가 있나. */
export function activeSanction<T extends SanctionPeriod>(sanctions: readonly T[], now: Date): T | null {
  return sanctions.find((s) => !s.lifted_at && s.created_at.getTime() <= now.getTime()
    && (s.ends_at === null || s.ends_at.getTime() > now.getTime())) ?? null;
}

// ── 분류 — 게임 × 말머리 ──────────────────────────────────────────────

/** 글의 게임. NULL 은 "게임이 없음"(화면 이름 기타) — 'platform'·'etc' 같은 값을 저장하지 않는다. 게임을 추가하면 DB CHECK 와 함께 넓힌다. */
export type CommunityGame = "lol" | "fconline";
export const COMMUNITY_GAMES: readonly CommunityGame[] = ["lol", "fconline"];
export const COMMUNITY_GAME_LABEL: Record<CommunityGame, string> = { lol: "LOL", fconline: "FC" };
/**
 * 게임을 고르지 않은 회원 글(game_code NULL)의 이름. '공통' 이었다 — 공통은 "모든 게임에 해당" 으로 읽히는데
 * 이 글들은 "어느 게임 이야기도 아님"(닉네임 질문 등)이다. 공지만은 NULL 이 "모든 게임 필터에 보임" 이라 관리자 폼이 따로 부른다.
 */
export const NO_GAME_LABEL = "기타";

export type CommunityTopic = "free" | "question" | "info" | "match" | "notice";
/** 회원이 고를 수 있는 말머리. 공지는 운영자만 쓴다. */
export const MEMBER_TOPICS: readonly Exclude<CommunityTopic, "notice">[] = ["free", "question", "info", "match"];
export const COMMUNITY_TOPIC_LABEL: Record<CommunityTopic, string> = {
  free: "자유", question: "질문", info: "정보", match: "경기 이야기", notice: "공지",
};

/** 목록의 게임 필터. 'etc' 는 기타 글(game_code NULL)만 — 필터 값일 뿐 저장값이 아니다. null 은 전부. */
export type GameFilter = CommunityGame | "etc" | null;
export function parseGameFilter(value: string | undefined | null): GameFilter {
  if (value === "etc") return "etc";
  return (COMMUNITY_GAMES as readonly string[]).includes(value ?? "") ? (value as CommunityGame) : null;
}
export function parseTopicFilter(value: string | undefined | null): CommunityTopic | null {
  // ★ `in` 은 상속 속성(toString …)도 참이다 — 주소에 ?topic=toString 이 오면 그대로 질의로 갔다(단위 테스트로 확인).
  return value && Object.hasOwn(COMMUNITY_TOPIC_LABEL, value) ? (value as CommunityTopic) : null;
}

// ── 글·댓글 입력 ─────────────────────────────────────────────────────

export const TITLE_MAX = 100;
export const BODY_MAX = 10_000;
export const COMMENT_MAX = 1_000;
export const TAG_MAX = 5;
export const REPORT_DETAIL_MAX = 1_000;

export interface PostInput {
  game_code: CommunityGame | null;
  topic: CommunityTopic;
  title: string;
  body: string;
  /** 태그할 스트리머(streamer.id). 공개 명부에 있는지는 접근자가 본다. */
  streamer_ids: string[];
}

/** 폼 값 정리 — 제목은 앞뒤 공백을 지우고, 본문은 줄바꿈을 \n 하나로 맞춘다(길이를 세는 기준이 같아야 DB CHECK 와 어긋나지 않는다). */
export function normalizePostInput(input: PostInput): PostInput {
  return {
    ...input,
    title: input.title.trim(),
    body: input.body.replace(/\r\n?/g, "\n").replace(/\s+$/u, ""),
    streamer_ids: [...new Set(input.streamer_ids)],
  };
}

export const normalizeCommentBody = (body: string): string => body.replace(/\r\n?/g, "\n").trim();

/** 글 입력 검증. 접근자가 폼과 별개로 다시 부른다. 공지는 운영자 경로(allowNotice)에서만. */
export function validatePostInput(input: PostInput, opts: { allowNotice?: boolean } = {}): string[] {
  const errors: string[] = [];
  if (input.game_code !== null && !COMMUNITY_GAMES.includes(input.game_code)) errors.push("게임을 확인해 주세요.");
  if (input.topic === "notice" ? !opts.allowNotice : !MEMBER_TOPICS.includes(input.topic as Exclude<CommunityTopic, "notice">)) {
    errors.push("말머리를 확인해 주세요.");
  }
  if (input.title.length < 1 || input.title.length > TITLE_MAX) errors.push(`제목은 1~${TITLE_MAX}자로 써 주세요.`);
  if (input.body.trim().length < 1 || input.body.length > BODY_MAX) errors.push(`본문은 1~${BODY_MAX.toLocaleString()}자로 써 주세요.`);
  if (input.streamer_ids.length > TAG_MAX) errors.push(`스트리머는 ${TAG_MAX}명까지 태그할 수 있습니다.`);
  return errors;
}

export function validateCommentBody(body: string): string[] {
  return body.length < 1 || body.length > COMMENT_MAX ? [`댓글은 1~${COMMENT_MAX.toLocaleString()}자로 써 주세요.`] : [];
}

// ── 신고 ─────────────────────────────────────────────────────────────

export type ReportReason = "spam" | "abuse" | "privacy" | "defamation" | "illegal" | "other";
export const REPORT_REASON_LABEL: Record<ReportReason, string> = {
  spam: "스팸·도배", abuse: "욕설·비하", privacy: "개인정보 노출", defamation: "명예훼손·허위사실", illegal: "불법", other: "기타",
};
export const REPORT_REASONS = Object.keys(REPORT_REASON_LABEL) as ReportReason[];
/** 관리자 목록에서 먼저 볼 사유 — 사람에게 바로 피해가 가는 것. */
export const URGENT_REPORT_REASONS: readonly ReportReason[] = ["privacy", "defamation"];

export function validateReport(reason: string, detail: string | null): string[] {
  const errors: string[] = [];
  if (!REPORT_REASONS.includes(reason as ReportReason)) errors.push("신고 사유를 골라 주세요.");
  if (reason === "other" && !detail?.trim()) errors.push("기타 사유는 설명을 적어 주세요.");
  if (detail && detail.length > REPORT_DETAIL_MAX) errors.push(`설명은 ${REPORT_DETAIL_MAX.toLocaleString()}자까지 적을 수 있습니다.`);
  return errors;
}

// ── 쓰기 한도 ────────────────────────────────────────────────────────

export type WriteKind = "post" | "comment" | "report";
/** 숫자는 출시 뒤 조정한다(docs/COMMUNITY-PLAN.md §3 쓰기). 하루 창이 가장 길어야 접근자가 하루치만 읽으면 된다. */
export const WRITE_LIMITS: Record<WriteKind, readonly { windowMs: number; max: number; label: string }[]> = {
  post: [{ windowMs: 60_000, max: 1, label: "1분에 1개" }, { windowMs: DAY_MS, max: 20, label: "하루 20개" }],
  comment: [{ windowMs: 10_000, max: 1, label: "10초에 1개" }, { windowMs: DAY_MS, max: 300, label: "하루 300개" }],
  report: [{ windowMs: DAY_MS, max: 30, label: "하루 30건" }],
};
const WRITE_NOUN: Record<WriteKind, string> = { post: "글", comment: "댓글", report: "신고" };

/** 최근 하루의 쓰기 시각을 보고 한도에 걸리면 안내 문구. 걸리지 않으면 null. */
export function writeLimitMessage(kind: WriteKind, recent: readonly Date[], now: Date): string | null {
  for (const limit of WRITE_LIMITS[kind]) {
    const since = now.getTime() - limit.windowMs;
    if (recent.filter((t) => t.getTime() > since).length >= limit.max) {
      return `${WRITE_NOUN[kind]}은(는) ${limit.label}까지 쓸 수 있습니다. 잠시 뒤 다시 시도해 주세요.`;
    }
  }
  return null;
}

// ── 운영 · 파기 ──────────────────────────────────────────────────────

/** 삭제 뒤 파기까지. 처리방침과 같아야 한다(apps/web/app/privacy). */
export const PURGE_AFTER_DAYS = 30;
/** 신고가 처리되고 신고 당시 내용을 지우기까지. */
export const SNAPSHOT_KEEP_DAYS = 30;
/** 운영 조치가 있었던 대상은 이 기간이 지나야 파기한다(분쟁 중 원문 보존). */
export const MODERATION_HOLD_DAYS = 30;
/** 임시조치·숨김을 다시 보게 하는 기간. */
export const REVIEW_AFTER_DAYS = 30;

export type ModerationAction = "keep" | "hide" | "blind" | "delete" | "restore";
export const MODERATION_ACTION_LABEL: Record<ModerationAction, string> = {
  keep: "유지", hide: "숨김", blind: "임시조치", delete: "삭제", restore: "해제",
};

export const daysAgo = (now: Date, days: number): Date => new Date(now.getTime() - days * DAY_MS);

export type ContentStatus = "published" | "hidden" | "deleted";

/**
 * 운영 조치의 상태 전이. 규칙은 여기 하나다.
 * - 숨김·임시조치: 공개·숨김 → 숨김(지운 글은 숨길 게 없다)
 * - 해제: **숨김 → 공개만** — 삭제된 글은 되살리지 않는다
 * - 삭제: → 삭제(이미 지웠으면 그대로) · 유지: 그대로
 */
export function moderationTransition(status: ContentStatus, action: ModerationAction): { next: ContentStatus } | { error: string } {
  switch (action) {
    case "keep": return { next: status };
    case "hide":
    case "blind": return status === "deleted" ? { error: "지운 글은 숨길 수 없습니다." } : { next: "hidden" };
    case "delete": return { next: "deleted" };
    case "restore":
      if (status === "hidden") return { next: "published" };
      return { error: status === "deleted" ? "삭제된 글은 되살리지 않습니다." : "숨긴 글이 아닙니다." };
  }
}

/** 주소의 글·댓글 번호. 숫자가 아니면 null — 캐스트 오류로 500 을 내지 않게 질의 전에 거른다. */
export function parseContentId(value: string | undefined | null): number | null {
  if (!value || !/^[1-9]\d{0,14}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string | undefined | null): value is string => typeof value === "string" && UUID.test(value);
