/** 수동 백필: 목록 위치만 별도 저장하고 조사 상태는 기존 event_lead를 읽는다. */
import { db } from './client.ts';
import { upsertEventLeadInTx } from './ck.ts';
import { backfillUpper, newestFirst, processed, vodDate, type ScanRaw } from '../metrics/ck-backfill.ts';

export interface BackfillTarget { id: string; display_name: string; slug: string; channel_id: string; watch: boolean }
export interface BackfillProgress {
  id: string; streamer_id: string; channel_id: string; upper_before: Date;
  cursor_at: Date | null; cursor_vod: number | null; exhausted: boolean;
}
export interface BackfillVod {
  title_no: number; ended_at: string; title: string; channel_id: string;
  duration_sec: number | null; url: string;
}
export interface BackfillLead { source_key: string; raw: ScanRaw; title: string }
export async function resolveBackfillTarget(name: string): Promise<BackfillTarget> {
  const rows = await db()<BackfillTarget[]>`
    SELECT s.id, s.display_name, s.slug, s.watch, c.channel_id FROM streamer s
    JOIN streamer_channel c ON c.streamer_id=s.id AND c.platform='soop' AND c.active_to IS NULL
    WHERE s.slug=${name} OR s.display_name=${name} OR c.channel_id=${name}`;
  if (rows.length !== 1) throw new Error(rows.length ? `대상이 모호하다: ${rows.map(r=>r.slug+':'+r.channel_id).join(', ')}` : `SOOP 채널을 찾지 못했다: ${name}`);
  return rows[0];
}
export async function getBackfillProgress(channel: string): Promise<BackfillProgress | null> {
  const [row] = await db()<BackfillProgress[]>`SELECT * FROM ck_backfill_progress WHERE channel_id=${channel}`;
  return row ?? null;
}
export async function ensureBackfillProgress(target: BackfillTarget, now = new Date()): Promise<BackfillProgress> {
  await db()`INSERT INTO ck_backfill_progress (streamer_id, channel_id, upper_before)
    VALUES (${target.id}, ${target.channel_id}, ${backfillUpper(target.watch, now)}) ON CONFLICT (channel_id) DO NOTHING`;
  const p = (await getBackfillProgress(target.channel_id))!;
  if (p.streamer_id !== target.id) throw new Error('채널 소유자가 바뀌었다. 기존 진행을 자동 이관하지 않는다.');
  return p;
}
export async function backfillLeads(keys: string[]): Promise<Map<string, BackfillLead>> {
  const rows = keys.length ? await db()<BackfillLead[]>`
    SELECT source_key, raw, title FROM event_lead WHERE source='vod_title' AND source_key=ANY(${keys})` : [];
  return new Map(rows.map(r=>[r.source_key,r]));
}
export async function markedBackfillVods(p: BackfillProgress): Promise<(BackfillVod & { raw: ScanRaw })[]> {
  const rows = await db()<BackfillLead[]>`SELECT source_key, raw, title FROM event_lead
    WHERE source='vod_title' AND raw->'backfill'->>'progress_id'=${p.id}`;
  return rows.map(r=>({ ...r.raw.backfill.vod as BackfillVod, raw:r.raw })).sort(newestFirst);
}
export async function markBackfillVod(p: BackfillProgress, target: BackfillTarget, vod: BackfillVod): Promise<void> {
  if (vod.channel_id !== p.channel_id || !Number.isSafeInteger(vod.title_no) || vod.title_no <= 0) throw new Error('잘못된 백필 VOD');
  await db().begin(async tx=>{
    // 계획/체크포인트 명령끼리도 같은 행으로 직렬화한다.
    await tx`SELECT id FROM ck_backfill_progress WHERE id=${p.id} FOR UPDATE`;
    const [existing] = await tx<{id:string;raw:ScanRaw}[]>`SELECT id, raw FROM event_lead
      WHERE source='vod_title' AND source_key=${`vod:${vod.title_no}`} FOR UPDATE`;
    if (existing?.raw.backfill && existing.raw.backfill.progress_id !== p.id) throw new Error('다른 백필에 속한 VOD');
    if (existing?.raw.scan?.status === 'running' && !existing.raw.backfill && target.watch) throw new Error('자동 실행의 running VOD는 이관하지 않는다');
    const id = existing?.id ?? await upsertEventLeadInTx(tx, {
      source:'vod_title', source_key:`vod:${vod.title_no}`, url:vod.url, channel_id:target.channel_id,
      streamer_id:target.id, title:vod.title, observed_at:vodDate(vod.ended_at),
    });
    await tx`UPDATE event_lead SET raw=raw || ${tx.json({backfill:{progress_id:p.id,vod}} as never)}
      WHERE id=${id}`;
  });
}
/** DB에 저장된 최근순 연속 처리 구간만 전진. 이미 커서보다 앞인 행을 재적용하지 않는다. */
export async function reconcileBackfill(channel: string): Promise<BackfillProgress | null> {
  return await db().begin(async tx=>{
    const [p] = await tx<BackfillProgress[]>`SELECT * FROM ck_backfill_progress WHERE channel_id=${channel} FOR UPDATE`;
    if (!p) return null;
    const rows = await tx<BackfillLead[]>`SELECT source_key, raw, title FROM event_lead
      WHERE source='vod_title' AND raw->'backfill'->>'progress_id'=${p.id} FOR UPDATE`;
    const sorted = rows.map(r=>({ ...r.raw.backfill.vod as BackfillVod, raw:r.raw })).sort(newestFirst);
    let last: BackfillVod | null = null;
    for (const v of sorted) {
      if (p.cursor_at && newestFirst(v,{ended_at:p.cursor_at.toISOString(),title_no:Number(p.cursor_vod)}) <= 0) continue;
      if (!processed(v.raw, v.duration_sec)) break;
      last=v;
    }
    if (last) {
      await tx`UPDATE ck_backfill_progress SET cursor_at=${vodDate(last.ended_at)}, cursor_vod=${last.title_no},
        checked_at=now(), updated_at=now() WHERE id=${p.id}`;
      p.cursor_at=vodDate(last.ended_at); p.cursor_vod=last.title_no;
    }
    return p;
  }) as BackfillProgress | null;
}
export async function setBackfillExhausted(id: string): Promise<void> {
  await db()`UPDATE ck_backfill_progress SET exhausted=true, checked_at=now(), updated_at=now() WHERE id=${id}`;
}
export async function recordBackfillAccess(p: BackfillProgress, vod: number, status: 'temporary'|'unavailable'|'retry', reason: string): Promise<void> {
  if (!reason.trim()) throw new Error('접근 상태에는 확인 근거·사유가 필요하다');
  const rows = await db()`UPDATE event_lead SET raw=raw || ${db().json({backfill_access:{status,reason,checked_at:new Date().toISOString()}})}
    WHERE source='vod_title' AND source_key=${`vod:${vod}`} AND raw->'backfill'->>'progress_id'=${p.id} RETURNING id`;
  if (!rows.length) throw new Error('이 백필에 속한 VOD가 아니다');
  // 재확인을 명시적으로 요청하면 해당 VOD를 pending 목록에서 다시 선택한다.
  if (status === 'retry') await db()`UPDATE ck_backfill_progress SET exhausted=false WHERE id=${p.id}`;
}
/** 자동 큐의 기간 밖 running 경로도 동일한 수동 표시를 존중한다. */
export async function listAutoRunningLeads(channels: string[]) {
  if (!channels.length) return [];
  return db()<{source_key:string;channel_id:string;title:string;observed_at:Date}[]>`
    SELECT source_key, channel_id, title, observed_at FROM event_lead
    WHERE source='vod_title' AND source_key LIKE 'vod:%' AND raw->'scan'->>'status'='running'
      AND NOT (raw ? 'backfill') AND channel_id=ANY(${channels})`;
}
