/**
 * 수동 백필의 DB 경계. 진척은 event_lead.raw(조사 도장)가 정본이고,
 * 여기서 따로 저장하는 건 "마지막 요청 기간" 하나다 — 다음 요청의 기본값일 뿐이다.
 */
import { db } from './client.ts';
import { vodDate, type ScanRaw } from '../metrics/ck-vod-status.ts';

export interface BackfillTarget { id: string; display_name: string; slug: string; channel_id: string }
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

export async function getBackfillRequest(channel: string): Promise<BackfillRequest | null> {
  const [row] = await db()<BackfillRequest[]>`
    SELECT channel_id, streamer_id, to_char(from_date,'YYYY-MM-DD') AS from_date,
           to_char(to_date,'YYYY-MM-DD') AS to_date, requested_at
      FROM ck_backfill_request WHERE channel_id=${channel}`;
  return row ?? null;
}
export async function saveBackfillRequest(target: BackfillTarget, from: string, to: string): Promise<void> {
  await db()`INSERT INTO ck_backfill_request (channel_id, streamer_id, from_date, to_date)
    VALUES (${target.channel_id}, ${target.id}, ${from}, ${to})
    ON CONFLICT (channel_id) DO UPDATE SET streamer_id=EXCLUDED.streamer_id,
      from_date=EXCLUDED.from_date, to_date=EXCLUDED.to_date, requested_at=now()`;
}

/** VOD 번호 → 현재 조사 도장. 없으면 Map 에 없다. */
export async function vodRaws(titleNos: number[]): Promise<Map<number, ScanRaw>> {
  const keys = titleNos.map(n=>`vod:${n}`);
  const rows = keys.length ? await db()<{ source_key: string; raw: ScanRaw }[]>`
    SELECT source_key, raw FROM event_lead WHERE source='vod_title' AND source_key=ANY(${keys})` : [];
  return new Map(rows.map(r=>[Number(r.source_key.slice(4)), r.raw]));
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
