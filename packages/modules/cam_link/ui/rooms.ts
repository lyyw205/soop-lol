/**
 * 지난 방 기억 — 서버 없이 이 브라우저에만 남긴다. 다음에 열면 그 방이 그대로 떠서 링크가 안 바뀐다.
 * ★ 저장소는 막혀 있을 수 있다(사생활 보호 창·차단). 못 읽으면 새 방, 못 쓰면 조용히 넘어간다 — 화면은 그대로 돈다.
 */
import { DEFAULT_OPTIONS, isCamId, newCamId, type CamOptions, type CamQuality, type RoomSeat } from "./links.ts";

export interface SavedRoom {
  room: string;
  seats: RoomSeat[];
  options: CamOptions;
  /** 마지막으로 복사해 간 초대 문구. 지금 문구와 다르면 다시 보내라고 알린다. */
  sent?: string;
}

export const ROOM_MIN = 4;
/** 참가자 이름 최대 길이. */
export const NAME_MAX = 20;
const KEY = "cam_link.room.v1";
const QUALITIES: CamQuality[] = ["1080", "720", "360"];

export const newSeat = (): RoomSeat => ({ id: newCamId(), name: "" });
export function newRoom(): SavedRoom {
  return { room: newCamId(), seats: Array.from({ length: ROOM_MIN }, newSeat), options: { ...DEFAULT_OPTIONS } };
}

/** 저장된 글자를 믿지 않는다 — 모양이 맞을 때만 살린다. */
export function parseRoom(raw: string | null): SavedRoom | null {
  let r: any;
  try { r = JSON.parse(raw ?? "null"); } catch { return null; }
  if (!r || typeof r !== "object" || !isCamId(r.room) || !Array.isArray(r.seats)) return null;
  const seats: RoomSeat[] = r.seats.filter((s: any) => s && typeof s === "object" && isCamId(s.id))
    .map((s: any) => ({ id: s.id, name: typeof s.name === "string" ? s.name.slice(0, NAME_MAX) : "" }));
  if (seats.length < 2) return null;
  while (seats.length < ROOM_MIN) seats.push(newSeat());
  const o = r.options ?? {};
  return {
    room: r.room,
    seats,
    ...(typeof r.sent === "string" ? { sent: r.sent } : {}),
    options: {
      quality: QUALITIES.includes(o.quality) ? o.quality : DEFAULT_OPTIONS.quality,
      audio: typeof o.audio === "boolean" ? o.audio : DEFAULT_OPTIONS.audio,
      lowLatency: typeof o.lowLatency === "boolean" ? o.lowLatency : DEFAULT_OPTIONS.lowLatency,
    },
  };
}

export function loadRoom(): SavedRoom | null {
  try { return parseRoom(localStorage.getItem(KEY)); } catch { return null; }
}
export function saveRoom(room: SavedRoom) {
  try { localStorage.setItem(KEY, JSON.stringify(room)); } catch { /* 저장 못 해도 지금 화면은 쓸 수 있다 */ }
}
