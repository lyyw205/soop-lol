/** 기존 집계가 섞인 DB를 0071로 올려 원본 보존·집계 분리·숨김 경계를 검증한다. */
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
    INSERT INTO champion_stat(streamer_id,champion_id,queue_id,season,games,wins,kills,deaths,assists,cs,seconds_played,category,kda_games)
      VALUES('00000000-0000-0000-0000-000000000001',103,0,'ALL',3,3,15,3,6,0,0,'other',3);
  `);
  const originals=(await pg.query('SELECT * FROM match ORDER BY match_id')).rows;
  const participants=(await pg.query('SELECT * FROM match_participant ORDER BY match_id')).rows;
  assert.equal((await pg.query<{games:number}>('SELECT games FROM core_public.champion_stat')).rows[0]?.games,3);
  await pg.exec(`BEGIN;${migrations.find(m=>m.version==='0071')!.sql}COMMIT;`);
  assert.deepEqual((await pg.query('SELECT * FROM match ORDER BY match_id')).rows,originals,'원본 경기 보존');
  assert.deepEqual((await pg.query('SELECT * FROM match_participant ORDER BY match_id')).rows,participants,'원본 참가자 보존');
  assert.deepEqual((await pg.query('SELECT match_id FROM core_public.match ORDER BY match_id')).rows,
    [{match_id:'upgrade:classic'},{match_id:'upgrade:legacy'}],'구형 CUSTOM을 제목 추정으로 재분류하지 않음');
  assert.deepEqual((await pg.query('SELECT match_id FROM core_public.aram_match')).rows,[{match_id:'upgrade:aram'}],'숨긴 경기 제외');
  assert.deepEqual((await pg.query("SELECT games,kills,kda_games FROM core_public.champion_stat WHERE season='ALL'")).rows,
    [{games:2,kills:10,kda_games:2}]);
  assert.deepEqual((await pg.query("SELECT games,kills,kda_games FROM core_public.aram_champion_stat WHERE season='ALL'")).rows,
    [{games:1,kills:5,kda_games:1}]);
  await pg.exec("UPDATE streamer SET visibility='hidden' WHERE slug='aram-upgrade'");
  assert.equal((await pg.query('SELECT * FROM core_public.aram_champion_stat')).rows.length,0,'숨긴 스트리머 제외');
  console.log('ARAM 0071 upgrade: 원본 보존, 기존 집계 분리, 구형 모드 유지, 공개 숨김 경계 통과');
} finally {await pg.close();}
