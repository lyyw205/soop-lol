/** 기존 데이터/권한이 있는 0084 DB → 새 규칙. 운영 DB에는 접속하지 않는다. */
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {loadMigrations} from './lib/migrations.ts';
import {resolvePosition} from '../packages/core/lib/metrics/matchup.ts';
const database = await PGlite.create({extensions:{pg_trgm,pgcrypto}});
try {
  const migrations = loadMigrations(join(import.meta.dirname,'..'));
  for(const m of migrations.filter(m=>m.version < '0085')) await database.exec(m.sql);
  await database.exec(`CREATE ROLE consistency_reader; GRANT USAGE ON SCHEMA core_public TO consistency_reader;
    GRANT SELECT ON core_public.event TO consistency_reader;
    INSERT INTO event (slug,name,kind,game_code,counts_toward_titles) VALUES ('upgrade-allstar','올스타','tournament','lol',false);
    INSERT INTO fco_account (ouid,nickname) VALUES ('upgrade','기존계정');
    INSERT INTO fco_club_snapshot (ouid,status,nickname,nexon_sn,club_value,captured_at) VALUES ('upgrade','ok','기존계정',1,12345,'2026-10-12T01:00Z');
    INSERT INTO fco_club_snapshot (ouid,status,nickname,captured_at) VALUES ('upgrade','missing','기존계정','2026-10-13T01:00Z');`);
  for(const m of migrations.filter(m=>m.version >= '0085')) await database.exec(m.sql);
  const grants = await database.query<{allowed:boolean}>(`SELECT has_table_privilege('consistency_reader','core_public.event','SELECT') AS allowed`);
  assert.equal(grants.rows[0].allowed,true);
  assert.equal((await database.query(`SELECT 1 FROM information_schema.columns WHERE table_name='event' AND column_name='counts_toward_titles'`)).rows.length,0);
  const snapshots = await database.query<{status:string;club_value:number|null}>(`SELECT status,club_value::int FROM fco_club_snapshot ORDER BY id`);
  assert.deepEqual(snapshots.rows,[{status:'ok',club_value:12345},{status:'missing',club_value:null}]);
  const attempts = await database.query<{outcome:string;legacy:boolean}>(`SELECT outcome,legacy FROM fco_club_attempt ORDER BY started_at`);
  assert.deepEqual(attempts.rows,[{outcome:'ok',legacy:true},{outcome:'missing',legacy:true}]);
  assert.equal((await database.query<{enabled:boolean}>(`SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='fco_club_attempt'::regclass`)).rows[0].enabled,true);
  // API 구버전/수기(null individual), 정상 포지션, 불일치, 잘못된 표기: SQL과 TS 전 조합.
  for(const team of [null,'','TOP','top','JUNGLE','MIDDLE','BOTTOM','UTILITY','INVALID']) {
    for(const individual of [null,'','TOP','top','JUNGLE','MIDDLE','BOTTOM','UTILITY','INVALID']) {
      const sql = await database.query<{position:string|null}>(`SELECT core_public.resolve_position($1,$2) AS position`,[team,individual]);
      assert.equal(sql.rows[0].position,resolvePosition({teamPosition:team ?? '',individualPosition:individual ?? ''}),`${team}/${individual}`);
    }
  }
  console.log('0084 → 0087 업그레이드: 권한·기존 스냅샷 보존·레거시 이관·RLS·SQL/TS 포지션 81조합 통과');
} finally { await database.close(); }
