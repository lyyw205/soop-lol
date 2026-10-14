/**
 * 공개 VDO.Ninja 방 링크를 만든다. 사람마다 두 개 — 시작(내 캠 보내기)과 보기(나를 뺀 참가자 전원을 한 화면에).
 * 같은 방(room)에 들어온 사람끼리 VDO.Ninja 가 직접(P2P) 잇는다. 우리 서버는 끼지 않는다.
 * 매개변수는 VDO.Ninja 원본 main.js 의 urlParams 처리로 확인했다 —
 *   push·room·webcam·quality(보내는 쪽), scene·room·view·clean(=cleanoutput)·buffer·noaudio(보는 쪽).
 * ★ 보기는 명단 고정이다(view=다른 참가자 이름표들). 방 이름이 새어 낯선 사람이 캠을 들고 들어와도
 *   방송 화면에는 안 뜬다 — 원본 webrtc.js 가 view_set 에 없는 이름표는 방에 들어와도 재생하지 않는다.
 *   대가: 참가자를 추가하면 기존 사람들의 보기 링크를 다시 보내야 한다(시작 링크는 그대로).
 * ★ 링크는 만료되지 않는다 — 같은 방을 다시 쓰면 방송 도구에 넣어 둔 보기 링크를 그대로 둔다.
 */
export const VDO_BASE = "https://vdo.ninja/";

export type CamQuality = "1080" | "720" | "360";
export interface CamOptions {
  /** 보내는 캠의 최대 해상도. 원본은 카메라 고르는 화면의 톱니 메뉴에 숨어 있다. */
  quality: CamQuality;
  /** 보기 화면에서 소리를 낸다. 원본은 링크 옵션(&noaudio)으로만 끈다. 기본은 끔 — 목소리는 보통 디스코드로 하므로 켜면 두 번 나간다. */
  audio: boolean;
  /** 보기 화면의 재생 대기(버퍼)를 0으로. 원본은 링크 옵션(&buffer)으로만 정한다. */
  lowLatency: boolean;
}
export const DEFAULT_OPTIONS: CamOptions = { quality: "720", audio: false, lowLatency: true };

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // 헷갈리는 l·o·0·1 은 뺀다
/**
 * 추측하기 어려운 이름표. 보기 링크를 아는 사람은 누구나 볼 수 있으므로 길이가 곧 보안이다.
 * 8자 = 32^8 ≈ 1조 가지. 더 길면 8명 초대 문구가 디스코드 한 메시지(2,000자)를 넘는다.
 */
export const CAM_ID_LENGTH = 8;
export function newCamId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return [...random(CAM_ID_LENGTH)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}
export const isCamId = (id: unknown): id is string => typeof id === "string" && /^[a-z0-9]{6,40}$/.test(id);

/** 방 안의 한 사람. 이름표를 미리 정해 두면 보기 명단을 방에 들어오기 전에 만들 수 있다. */
export interface RoomSeat { id: string; name: string }
export const seatName = (s: RoomSeat, i: number) => s.name.trim() || `참가자 ${i + 1}`;

/** 시작 — 그 사람만 연다. 화면 공유 버튼 없이 카메라만 고르고 시작을 누른다. */
export function startLink(room: string, seat: RoomSeat, o: CamOptions): string {
  const url = new URL(VDO_BASE);
  url.searchParams.set("push", seat.id);
  url.searchParams.set("room", room);
  url.searchParams.set("webcam", "");
  url.searchParams.set("quality", o.quality);
  return tidy(url);
}

/** 보기 — 나를 뺀 참가자 명단만 한 화면에 자동 분할. 버튼·글자 없이 영상만. */
export function watchLink(room: string, seat: RoomSeat, seats: RoomSeat[], o: CamOptions): string {
  const url = new URL(VDO_BASE);
  url.searchParams.set("scene", "");
  url.searchParams.set("room", room);
  url.searchParams.set("view", seats.filter((s) => s.id !== seat.id).map((s) => s.id).join(","));
  url.searchParams.set("clean", ""); // cleanoutput 의 원본 줄임 표기 — 초대 문구 길이 때문
  if (o.lowLatency) url.searchParams.set("buffer", "0");
  if (!o.audio) url.searchParams.set("noaudio", "");
  return tidy(url);
}

// URLSearchParams 는 값 없는 키를 "webcam=" 으로, 쉼표를 %2C 로 쓴다. VDO.Ninja 문서 표기(&webcam, view=a,b)에 맞춘다.
const tidy = (url: URL) => url.toString().replace(/=(?=&|$)/g, "").replace(/%2C/g, ",");

/** 단톡방·디스코드에 그대로 붙여 넣을 초대 문구. 사람마다 자기 링크 두 개. */
export function inviteText(room: string, seats: RoomSeat[], o: CamOptions): string {
  const lines = [
    "[캠 합방] 자기 이름 아래 링크 두 개만 쓰세요",
    "① 시작: 열고 카메라를 고른 뒤 시작을 누르세요. 이 창은 켜 두세요.",
    "② 보기: 다른 사람 캠이 한 화면에 나옵니다. 방송 도구에서 이 창을 캡처하세요.",
    "⚠ 링크는 방송에 안 잡힐 때 열고, ② 창은 주소창이 안 나오게 영상 부분만 잘라 띄우세요.",
  ];
  seats.forEach((s, i) => lines.push("", `■ ${seatName(s, i)}`, `① ${startLink(room, s, o)}`, `② ${watchLink(room, s, seats, o)}`));
  return lines.join("\n");
}
