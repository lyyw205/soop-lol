/**
 * 영상 판독 경기가 쌓인 DB 를 0071 로 올려 원본 보존을, 0089 까지 올려 칼바람 구분(맵 칼럼)·공개 세트·숨김 경계를 검증한다.
 * ★ 0071 의 옛 집계(저장된 분류·파생 표)는 0089 에서 없어졌다 — 그 단언 대신 0089 의 맵·공개 세트 불변식을 본다.
 */
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { loadMigrations } from './lib/migrations.ts';

const pg=await PGlite.create({extensions:{pg_trgm,pgcrypto}});
try {
  const migrations=loadMigrations(new URL('..',import.meta.url).pathname);
  for(const m of migrations.filter(m=>m.version<'0071')) await pg.exec(`BEGIN;${m.sql}COMMIT;`);
  await pg.exec(`
    INSERT INTO streamer(id,slug,display_name) VALUES('00000000-0000-0000-0000-000000000001','aram-upgrade','업그레이드');
    INSERT INTO match(match_id,game_code,queue_id,mode_key,game_mode,game_creation,winning_team,source,origin)
      VALUES('upgrade:classic','lol',0,'0','CLASSIC','2026-09-01T00:00:00Z',100,'manual','vod_scan'),
            ('upgrade:aram','lol',0,'0','ARAM','2026-09-02T00:00:00Z',100,'manual','vod_scan'),
            ('upgrade:legacy','lol',0,'0','CUSTOM','2026-09-03T00:00:00Z',100,'manual','vod_scan'),
            ('upgrade:hidden','lol',0,'0','ARAM','2026-09-04T00:00:00Z',100,'manual','vod_scan');
    UPDATE match SET visibility='hidden' WHERE match_id='upgrade:hidden';
    INSERT INTO match_participant(match_id,participant_id,team_id,streamer_id,champion_id,outcome,kills,deaths,assists)
      SELECT match_id,1,100,'00000000-0000-0000-0000-000000000001',103,'win',5,1,2 FROM match;
  `);
  const originals=(await pg.query('SELECT * FROM match ORDER BY match_id')).rows;
  const participants=(await pg.query('SELECT * FROM match_participant ORDER BY match_id')).rows;
  await pg.exec(`BEGIN;${migrations.find(m=>m.version==='0071')!.sql}COMMIT;`);
  assert.deepEqual((await pg.query('SELECT * FROM match ORDER BY match_id')).rows,originals,'원본 경기 보존');
  assert.deepEqual((await pg.query('SELECT * FROM match_participant ORDER BY match_id')).rows,participants,'원본 참가자 보존');
  await pg.exec("UPDATE streamer SET visibility='public' WHERE slug='aram-upgrade'");

  // ── 0089 까지: 칼바람 구분은 저장된 분류(category)가 아니라 맵(match.map, 모드에서 정해지는 생성 칼럼) 하나다 ──
  // 영상 판독 판은 행사 안에 있어야 0089 가 옮겨 담는다(행사 직접 → 같은 행사의 한 판짜리 시리즈).
  await pg.exec(`INSERT INTO event(id,slug,name,kind,game_code) VALUES('00000000-0000-0000-0000-0000000000a1','aram-upgrade-ck','칼바람 내전','ck','lol');
    UPDATE match SET event_id='00000000-0000-0000-0000-0000000000a1';`);
  for(const m of migrations.filter(m=>m.version>'0071')) await pg.exec(`BEGIN;${m.sql}COMMIT;`);
  assert.deepEqual((await pg.query('SELECT match_id, map, scope, series_id FROM match ORDER BY match_id')).rows, [
    {match_id:'upgrade:aram',map:'aram',scope:'versus',series_id:'set:upgrade:aram'},
    {match_id:'upgrade:classic',map:'rift',scope:'versus',series_id:'set:upgrade:classic'},
    {match_id:'upgrade:hidden',map:'aram',scope:'versus',series_id:'set:upgrade:hidden'},
    {match_id:'upgrade:legacy',map:'rift',scope:'versus',series_id:'set:upgrade:legacy'},
  ],'구형 CUSTOM 은 제목 추정 없이 협곡, 칼바람은 모드에서');
  assert.deepEqual((await pg.query("SELECT match_id, map, format FROM core_public.lol_versus_set ORDER BY match_id")).rows, [
    {match_id:'upgrade:aram',map:'aram',format:'ck'},{match_id:'upgrade:classic',map:'rift',format:'ck'},{match_id:'upgrade:legacy',map:'rift',format:'ck'},
  ],'공개 세트는 숨긴 경기를 빼고, 맵과 진행 방식을 따로 단다');
  await pg.exec("UPDATE streamer SET visibility='hidden' WHERE slug='aram-upgrade'");
  assert.equal((await pg.query('SELECT 1 FROM core_public.lol_versus_set')).rows.length,0,'숨긴 스트리머 제외');
  console.log('ARAM upgrade: 0071 원본 보존 · 0089 맵 칼럼(구형 CUSTOM 협곡 유지)·공개 세트·숨김 경계 통과');
} finally {await pg.close();}
