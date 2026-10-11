/**
 * **경기 하나의 검수 근거** — 경기 검수 화면이 보여 줄 방송(VOD)별 사진과 판독.
 *
 * ★ 근거는 **사진의 경기 연결(match_evidence_frame.match_id)** 과 **시점 기록(match_pov)** 둘이다.
 *   시점 기록에서 출발하면 시점 기록 없이 사진만 연결된 예전 경기의 사진이 빠진다
 *   (2026-10-09 공개 LoL 722경기 1,822장). 그래서 두 출처의 VOD 를 합친다.
 * ★ VOD↔경기 관계 뷰(lead_match: 사진·후보 JSON·출처 URL·시점 기록)는 근거가 아니다 — VOD 찾기용이다.
 *   여기서는 VOD 안에서 경기 구간을 나눌 때(참고 사진 계산)만 그 VOD 의 경기 목록으로 쓴다.
 *   VOD 화면의 구간 나누기와 같은 입력이어야 같은 사진이 같은 판으로 묶인다.
 * ★ 참고 사진(연결 안 된 같은 구간 사진)을 고르는 규칙은 화면 쪽 한 함수(projectReviewQueue)다.
 *   여기는 그 계산에 필요한 VOD 의 사진·경기를 넘긴다.
 */
import { db } from "./client.ts";
import { getMatchPovViews, povDiffOf, type PovDiffRow, type PovRole, type PovSource } from "./ck-pov.ts";

export interface ReviewEvidenceFrame {
  id: string;
  match_id: string | null;
  frame_path: string;
  at_sec: number | null;
  kind: "result" | "roster" | "other";
}

export interface ReviewEvidenceVod {
  lead_id: string;
  source_key: string;
  title: string;
  url: string | null;
  streamer_name: string | null;
  vod_started_at: string | null;
  /** 이 VOD 의 사진 전부. 이 경기 연결분은 match_id 로, 나머지는 구간 계산·참고 사진용. */
  frames: ReviewEvidenceFrame[];
  /** 이 VOD 와 관련된 경기들 — 구간 나누기용(VOD 화면과 같은 입력). */
  matches: Array<{ match_id: string; game_creation_epoch_ms: number; game_duration: number | null }>;
  /** 이 VOD 가 이 경기 값을 제출했으면 그 시점 기록과 경기 값과 다른 칸. */
  pov: { role: PovRole; source: PovSource; link_basis: string | null; compared: number; rows: PovDiffRow[] } | null;
}

export async function getMatchReviewEvidence(matchId: string): Promise<ReviewEvidenceVod[]> {
  const sql = db();
  const leads = await sql<Omit<ReviewEvidenceVod, "frames" | "matches" | "pov">[]>`
    SELECT el.id AS lead_id, el.source_key, el.title, el.url,
           CASE WHEN jsonb_typeof(el.raw->'vod_started_at') = 'string' THEN el.raw->>'vod_started_at' END AS vod_started_at,
           (SELECT s.display_name FROM streamer s
             WHERE s.id = COALESCE(el.streamer_id, (
               SELECT c.streamer_id FROM streamer_channel c
                WHERE c.channel_id = el.channel_id AND c.platform = 'soop'
                ORDER BY c.active_to IS NULL DESC LIMIT 1))) AS streamer_name
      FROM event_lead el
     WHERE el.id IN (SELECT lead_id FROM match_evidence_frame WHERE match_id = ${matchId}
                     UNION SELECT lead_id FROM match_pov WHERE match_id = ${matchId})
     ORDER BY el.observed_at, el.source_key`;
  if (leads.length === 0) return [];
  const ids = leads.map((l) => l.lead_id);
  const frames = await sql<(ReviewEvidenceFrame & { lead_id: string })[]>`
    SELECT id, lead_id, match_id, frame_path, at_sec, kind FROM match_evidence_frame
     WHERE lead_id = ANY(${ids}::uuid[]) ORDER BY at_sec NULLS LAST, frame_path`;
  const matches = await sql<{ lead_id: string; match_id: string; game_creation: Date; game_duration: number | null }[]>`
    SELECT DISTINCT lm.lead_id, m.match_id, m.game_creation, m.game_duration
      FROM lead_match lm JOIN match m ON m.match_id = lm.match_id
     WHERE lm.lead_id = ANY(${ids}::uuid[])`;
  const views = new Map((await getMatchPovViews(matchId)).map((v) => [v.lead_id, v]));
  return leads.map((l) => {
    const view = views.get(l.lead_id);
    return {
      ...l,
      frames: frames.filter((f) => f.lead_id === l.lead_id).map(({ lead_id: _lead, ...f }) => f),
      matches: matches.filter((m) => m.lead_id === l.lead_id)
        .map((m) => ({ match_id: m.match_id, game_creation_epoch_ms: m.game_creation.getTime(), game_duration: m.game_duration })),
      pov: view ? { role: view.role, source: view.source, link_basis: view.link_basis, ...povDiffOf(view) } : null,
    };
  });
}
