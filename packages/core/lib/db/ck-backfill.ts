/**
 * 수동 백필의 DB 경계. 진척은 event_lead.raw(조사 도장)가 정본이고,
 * 여기서 따로 저장하는 건 "마지막 요청 기간" 하나다 — 다음 요청의 기본값일 뿐이다.
 */
import { db } from './client.ts';
import { activeCandidates, vodDate, type ScanRaw } from '../metrics/ck-vod-status.ts';

export interface BackfillTarget { id: string; display_name: string; slug: string; channel_id: string }
export type BackfillGame = 'lol' | 'fconline';
export interface BackfillRequest { channel_id: string; streamer_id: string; from_date: string; to_date: string; requested_at: Date }
export interface BackfillVod {
  title_no: number; ended_at: string; title: string; channel_id: string;
  duration_sec: number | null; url: string;
}

export async function resolveBackfillTarget(name: string): Promise<BackfillTarget> {
  const rows = await db()<BackfillTarget[]>`
    SELECT s.id, s.display_name, s.slug, c.channel_id FROM streamer s
    JOIN streamer_channel c ON c.streamer_id=s.id AND c.platform='soop' AND c.active_to IS NULL
    WHERE s.slug=${name} OR s.display_name=${name} OR c.channel_id=${name}`;
  if (rows.length !== 1) throw new Error(rows.length ? `대상이 모호하다: ${rows.map(r=>r.slug+':'+r.channel_id).join(', ')}` : `SOOP 채널을 찾지 못했다: ${name}`);
  return rows[0];
}

/** 게임별 마지막 요청 기간(0055). 롤과 FC 는 같은 채널이어도 따로 요청한다. */
export async function getBackfillRequest(channel: string, game: BackfillGame = 'lol'): Promise<BackfillRequest | null> {
  const [row] = await db()<BackfillRequest[]>`
    SELECT channel_id, streamer_id, to_char(from_date,'YYYY-MM-DD') AS from_date,
           to_char(to_date,'YYYY-MM-DD') AS to_date, requested_at
      FROM ck_backfill_request WHERE channel_id=${channel} AND game_code=${game}`;
  return row ?? null;
}
export async function saveBackfillRequest(target: BackfillTarget, from: string, to: string, game: BackfillGame = 'lol'): Promise<void> {
  await db()`INSERT INTO ck_backfill_request (channel_id, game_code, streamer_id, from_date, to_date)
    VALUES (${target.channel_id}, ${game}, ${target.id}, ${from}, ${to})
    ON CONFLICT (channel_id, game_code) DO UPDATE SET streamer_id=EXCLUDED.streamer_id,
      from_date=EXCLUDED.from_date, to_date=EXCLUDED.to_date, requested_at=now()`;
}

/** VOD 번호 → 현재 조사 도장. 없으면 Map 에 없다. */
export async function vodRaws(titleNos: number[]): Promise<Map<number, ScanRaw>> {
  const keys = titleNos.map(n=>`vod:${n}`);
  const rows = keys.length ? await db()<{ source_key: string; raw: ScanRaw }[]>`
    SELECT source_key, raw FROM event_lead WHERE source='vod_title' AND source_key=ANY(${keys})` : [];
  return new Map(rows.map(r=>[Number(r.source_key.slice(4)), r.raw]));
}

/** 조사 결과를 다시 읽어 만드는 인계 자료. 별도 진행 테이블이나 추측한 재개 커서는 없다. */
export async function backfillContext(vod: number, game: BackfillGame = 'lol') {
  const [lead] = await db()<{ id: string; source_key: string; raw: ScanRaw }[]>`
    SELECT id, source_key, raw FROM event_lead WHERE source='vod_title' AND source_key=${`vod:${vod}`}`;
  if (!lead) return null;
  const scan = lead.raw[game === 'lol' ? 'scan' : 'fco_scan'];
  const candidates = game === 'lol' ? activeCandidates(lead.raw) : [];
  const matches = game === 'lol' ? await db()<{
    match_id: string; winning_team: number | null; game_creation: Date; game_duration: number | null;
  }[]>`SELECT m.match_id, m.winning_team, m.game_creation, m.game_duration
    FROM match_pov p JOIN match m ON m.match_id=p.match_id
    WHERE p.lead_id=${lead.id}::uuid ORDER BY m.game_creation, m.match_id` : [];
  const people = matches.length ? await db()<{
    streamer_id: string; display_name: string; observed_name: string | null;
  }[]>`SELECT DISTINCT s.id AS streamer_id, s.display_name, mp.observed_name
    FROM match_pov p JOIN match_participant mp ON mp.match_id=p.match_id
    JOIN streamer s ON s.id=mp.streamer_id WHERE p.lead_id=${lead.id}::uuid
    ORDER BY s.display_name, mp.observed_name` : [];
  return {
    source_key: lead.source_key,
    // 매 next/context 호출 때 생성한다. 이미 실행 중인 셸의 다음 세션도 최신 완료 규칙을 받는다.
    ...(game === 'lol' ? { completion_policy: {
      done: '전 범위의 필수 탐색·결과창 보완 탐색·교차검증 처리를 마쳤다면, 큐 종류·신원·승패가 미해결이어도 후보와 질문을 보존하고 done으로 저장한다. done은 모든 값 확정이 아니라 탐색 완료다.',
      running: '아직 수행할 필수 탐색이나 실패 범위가 있으면 running으로 남기고 구체적인 남은 위치·행동을 적는다. 이미지/비용 예산 소진과 추가로 볼 것이 없다는 메모만으로 done을 만들지 않는다.',
      evidence: '완료 전 후보별 확인 구간·결과창 탐색 종료 사유·교차검증 시도와 한계를 확인한다. 근거 부족을 not_target으로 바꾸거나 후보를 삭제하지 않는다. 미해결 상세 근거는 detail_command로 조회한다.',
      rebroadcast: '방송 주인이 참가하지 않은 다른 방송의 결과창도 직접 읽어 rebroadcast 근거로 쓸 수 있다. 본인 VOD에서만 읽어야 한다는 이유로 보류하지 않는다. 판 식별·신원이 불명확하면 관찰과 질문을 보존한다.',
      previous_resume: '이전 인계의 사용자 판단 필요·미해결이라 완료 불가라는 결론을 그대로 따르지 않는다. 사실·근거는 재사용하되 위 조건으로 남은 필수 탐색과 검수 질문을 구분한다.',
    } } : {}),
    scan: scan ? { status: scan.status, requested: scan.requested, failed: scan.failed,
      opened_count: new Set(scan.opened ?? []).size, resume: scan.resume ?? null,
      // 구형 조사에는 resume가 없다. 메모는 힌트로만 제공하고 전체 기록 조회 경로를 남긴다.
      note: typeof scan.note === 'string' ? scan.note.slice(0, 3000) : null } : null,
    access: lead.raw.access ?? null,
    saved_matches: matches,
    identities: people,
    candidates: candidates.map(c => ({ id: c.id, at: c.at, conclusion: c.conclusion, match_id: c.match_id })),
    detail_command: `npm run ck:record -- --lead vod:${vod}`,
    warning: '동일 VOD에서 저장 확인된 결과를 재사용한다. 기존 경기값은 다른 VOD의 독립 판독을 대체하지 않는다. 미해결 상세 근거는 ck:record로 조회한다.',
  };
}

export async function savedPovCounts(vods: number[]): Promise<Map<number, number>> {
  if (!vods.length) return new Map();
  const rows = await db()<{ source_key: string; n: number }[]>`
    SELECT l.source_key, count(p.match_id)::int AS n FROM event_lead l
    LEFT JOIN match_pov p ON p.lead_id=l.id
    WHERE l.source='vod_title' AND l.source_key=ANY(${vods.map(n => `vod:${n}`)}) GROUP BY l.source_key`;
  return new Map(rows.map(r => [Number(r.source_key.slice(4)), r.n]));
}

/**
 * 목록에서 본 VOD 의 lead 를 **없을 때만** 만든다.
 * ★ 기존 행은 건드리지 않는다. upsertEventLead 는 state·note 를 기본값으로 덮는다.
 * observed_at 은 ck:merge 와 같은 뜻(방송 시작)으로 맞춘다 — 종료 − 길이.
 */
export async function ensureVodLeads(target: BackfillTarget, vods: BackfillVod[]): Promise<void> {
  for (const v of vods) {
    const ended = vodDate(v.ended_at);
    const started = new Date(ended.getTime() - (v.duration_sec ?? 0) * 1000);
    await db()`INSERT INTO event_lead (source, source_key, url, channel_id, streamer_id, title, observed_at, raw, state)
      VALUES ('vod_title', ${`vod:${v.title_no}`}, ${v.url}, ${target.channel_id}, ${target.id}, ${v.title}, ${started}, '{}'::jsonb, 'new')
      ON CONFLICT (source, source_key) DO NOTHING`;
  }
}

/**
 * 이 채널에서 방송 시작이 기간 안(앞뒤 하루 여유)인 lead. 목록에서 사라진 미완료 VOD 를 찾는 데 쓴다.
 * 목록만 다시 받으면 삭제·비공개된 VOD 는 조용히 빠진다.
 */
export async function channelLeadsBetween(channel: string, from: string, to: string) {
  return db()<{ source_key: string; title: string; observed_at: Date; raw: ScanRaw }[]>`
    SELECT source_key, title, observed_at, raw FROM event_lead
     WHERE source='vod_title' AND channel_id=${channel} AND source_key LIKE 'vod:%'
       AND observed_at >= ${new Date(`${from}T00:00:00+09:00`)}::timestamptz - interval '1 day'
       AND observed_at <  ${new Date(`${to}T00:00:00+09:00`)}::timestamptz + interval '1 day'`;
}

/**
 * 접근 상태. 자동·수동 공용이다. 사유·확인 시각을 남기고, retry 로 다시 조사 대상에 넣는다.
 * lead 가 없으면 만들지 않는다 — 목록에서 본 VOD 만 기록한다.
 */
export async function recordVodAccess(vod: number, status: 'temporary'|'unavailable'|'retry', reason: string): Promise<void> {
  if (!reason.trim()) throw new Error('접근 상태에는 확인 근거·사유가 필요하다');
  const rows = await db()`UPDATE event_lead
    SET raw = raw || ${db().json({ access: { status, reason, checked_at: new Date().toISOString() } })}
    WHERE source='vod_title' AND source_key=${`vod:${vod}`} RETURNING id`;
  if (!rows.length) throw new Error(`vod:${vod} lead가 없다. 목록에서 본 VOD만 기록한다`);
}

/** 와치리스트 채널의 running — 기간과 무관하게 자동 조사가 이어받는다(수동 백필이 멈춘 것 포함). */
export async function listRunningLeads(channels: string[]) {
  if (!channels.length) return [];
  return db()<{source_key:string;channel_id:string;title:string;observed_at:Date}[]>`
    SELECT source_key, channel_id, title, observed_at FROM event_lead
    WHERE source='vod_title' AND source_key LIKE 'vod:%' AND raw->'scan'->>'status'='running'
      AND channel_id=ANY(${channels})`;
}
