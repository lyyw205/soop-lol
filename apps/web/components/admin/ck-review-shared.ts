/**
 * CK 검수 화면들(경기 검수·VOD 찾기)이 같이 쓰는 모양과 작은 도우미. 화면 코드(JSX)는 없다.
 */
import { setLabel } from "@soop-lol/core/lib/metrics/set-label";

export interface ReviewFrame {
  id: string;
  match_id: string | null;
  frame_path: string;
  at_sec: number | null;
  kind: "result" | "roster" | "other";
}

export interface ReviewParticipant {
  account_streamer_id?: string | null;
  /** Riot ID(`닉네임#태그`) — 표시 전용. 저장 값(observed_name)으로 옮기지 않는다. */
  riot_id?: string | null;
  participant_id: number;
  puuid: string | null;
  streamer_id: string | null;
  observed_name: string | null;
  team_id: number;
  team_position: string | null;
  champion_id: number;
  champion_name: string | null;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
}

export interface ReviewMatch {
  match_id: string;
  game_creation: string;
  /** datetime-local 문자열의 브라우저 시간대 해석에 기대지 않는 타임라인 계산값. */
  game_creation_epoch_ms: number;
  game_duration: number | null;
  winning_team: number | null;
  visibility: "public" | "hidden";
  review_completed_at: string | null;
  review_version: number;
  position_count: number;
  linked_count: number;
  champion_count: number;
  kda_count: number;
  origin: string | null;
  source: string | null;
  event_id: string | null;
  series_id: string | null;
  series_game_no: number | null;
  best_of: number | null;
  best_of_evidence: string | null;
  /** 'date' 면 시각은 모른다 — 날짜만 보여준다(0035). */
  game_creation_precision: "datetime" | "date";
  /** 세트 순서를 출처에서 확인했나. false 면 "N세트" 로 단정하지 않는다. */
  set_order_known: boolean;
  source_url: string | null;
  participants: ReviewParticipant[];
}

export interface ReviewStreamer {
  id: string;
  slug: string;
  display_name: string;
}

/** 경기를 붙일 대회. 분류(내전/대회)가 여기서 나온다. */
export interface ReviewEvent {
  id: string;
  slug: string | null;
  name: string;
  kind: string;
}

export interface PovDiffRowView {
  participant_id: number | null;
  who: string;
  field: string;
  stored: unknown;
  observed: unknown;
  status: "mismatch_open" | "mismatch_reviewed" | "pending" | "empty";
}

// ── 작은 조각 ────────────────────────────────────────────────────────

export function vodAt(url: string, seconds: number | null): string {
  if (seconds == null) return url;
  try {
    const target = new URL(url);
    target.searchParams.set("change_second", String(Math.floor(seconds)));
    return target.toString();
  } catch { return url; }
}

export const hms = (sec: number | null) => {
  if (sec == null) return "--:--:--";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};

/** 날짜만 아는 경기는 시각을 내지 않는다(0035) — 시드 생성기가 19시·20시를 지어 넣는다. */
export const compactKst = (value: string, precision: string = "datetime") =>
  !value ? "—" : precision === "date" ? value.slice(0, 10) : value.replace("T", " ");

/** 세트 이름은 core 의 setLabel 하나로 낸다 — 화면마다 규칙이 다르면 같은 판이 다르게 불린다. */
export const matchSetLabel = (m: { series_id: string | null; best_of: number | null; set_order_known: boolean; series_game_no: number | null }) =>
  setLabel({ standalone: !m.series_id, unassigned: !m.series_id, best_of: m.best_of, set_order_known: m.set_order_known, series_game_no: m.series_game_no });
export const durationLabel = (sec: number | null) => sec == null
  ? "—"
  : `${Math.floor(sec / 60)}분${sec % 60 ? ` ${sec % 60}초` : ""}`;

/** 프레임 파일을 서빙하는 라우트. `out/` 밖은 라우트가 거부한다. */
export const frameUrl = (path: string) => `/admin/ck/frame/${path.split("/").map(encodeURIComponent).join("/")}`;
/** 사진 줄·목록의 작은 칸용 축소본(가로 160px). 큰 화면에는 frameUrl 을 쓴다. */
export const frameThumbUrl = (path: string) => `${frameUrl(path)}?w=160`;

export const KIND_LABEL: Record<ReviewFrame["kind"], string> = {
  result: "결과창",
  roster: "로스터",
  other: "그 밖",
};

export const inputClass =
  "w-full rounded border border-ink-700 bg-ink-950 px-2 py-1 text-xs text-ink-200 " +
  "placeholder:text-ink-400/50 outline-none focus:border-accent-600";

export const POSITIONS = ["", "TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"];
