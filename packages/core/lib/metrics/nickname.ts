/**
 * 회원 닉네임 규칙 — docs/COMMUNITY-PLAN.md §2 "닉네임 규칙". 판정은 여기 하나다(접근자·폼이 같이 쓴다).
 *
 * ★ 정규화 키로 중복과 사칭을 본다. 표시는 회원이 적은 그대로 한다.
 *   "철수", "철 수", "ＣＨＵＬＳＵ" 처럼 보기에 같은 이름이 따로 등록되면 사칭 판정이 무의미해진다.
 * ★ 스트리머 사칭 차단 — 스트리머 커뮤니티에서 가장 먼저 터지는 사고다. 등록 스트리머의 이름·별칭과
 *   정규화 키가 같으면 거부한다(숨긴 스트리머도 포함 — 숨겼다고 사칭이 괜찮아지지 않는다).
 */

export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 12;

/** 비교용 키. NFKC → 소문자 → 글자·숫자만 남긴다. */
export function nicknameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** 그대로 일치하면 안 되는 이름. "탈퇴한 회원" 은 화면이 탈퇴 회원을 그렇게 부르므로 막는다. */
const RESERVED_EXACT = new Set(
  ["운영자", "관리자", "운영진", "운영팀", "admin", "administrator", "moderator", "soop", "숲", "탈퇴한회원", "익명"].map(nicknameKey),
);
/** 들어가기만 해도 안 되는 말(공식처럼 보이는 이름). 영문은 다른 낱말에 섞이기 쉬워 일치만 본다. */
const RESERVED_PART = ["운영자", "관리자", "운영진"].map(nicknameKey);

export type NicknameCheck = { ok: true; nickname: string; key: string } | { ok: false; error: string };

/**
 * @param streamerKeys 등록 스트리머 이름·별칭의 정규화 키(접근자가 streamer 표에서 만든다)
 */
export function checkNickname(raw: string, streamerKeys: ReadonlySet<string>): NicknameCheck {
  const nickname = raw.normalize("NFKC").trim().replace(/\s+/g, " ");
  const length = [...nickname].length;
  if (length < NICKNAME_MIN || length > NICKNAME_MAX) {
    return { ok: false, error: `닉네임은 ${NICKNAME_MIN}~${NICKNAME_MAX}자로 정해 주세요.` };
  }
  if (/\p{C}/u.test(nickname)) return { ok: false, error: "닉네임에 쓸 수 없는 문자가 있습니다." };
  const key = nicknameKey(nickname);
  if ([...key].length < NICKNAME_MIN) return { ok: false, error: "닉네임에는 글자나 숫자가 두 개 이상 있어야 합니다." };
  if (RESERVED_EXACT.has(key) || RESERVED_PART.some((part) => key.includes(part))) {
    return { ok: false, error: "운영진으로 오해될 수 있는 닉네임은 쓸 수 없습니다." };
  }
  if (streamerKeys.has(key)) return { ok: false, error: "등록된 스트리머 이름과 같은 닉네임은 쓸 수 없습니다." };
  return { ok: true, nickname, key };
}
