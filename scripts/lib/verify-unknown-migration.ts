import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {loadMigrations} from './migrations.ts';

/**
 * Existing 0022 install with data vs a fresh install, including a safe reapplication.
 * ★ 0089 이후 이름만 읽은 자리의 공개 경로는 core_public.match_detail 이다(옛 참가자 공개 뷰는 0089 에서 없어졌다).
 *   이 판은 0022 시점의 행사(match.event_id)에 붙어 있어야 0089 가 한 판짜리 시리즈로 옮긴다 — 행사 없는 영상 판독 판은
 *   0089 가 거부한다(옮겨 담기가 빠뜨린 것으로 본다).
 */
export async function verifyUnknownUpgrade(fresh: PGlite) {
  const upgrade=await PGlite.create({extensions:{pg_trgm,pgcrypto}});
  try {
    const migrations=loadMigrations(new URL('../..',import.meta.url).pathname);
    for(const m of migrations.filter(m=>m.version<='0022')) await upgrade.exec(`BEGIN;${m.sql}COMMIT;`);
    await upgrade.exec(`INSERT INTO event(id,slug,name,kind) VALUES('00000000-0000-0000-0000-0000000000e1','upgrade-unknown','업그레이드 내전','other');
      INSERT INTO match(match_id,queue_id,game_creation,winning_team,source,origin,result_evidence,event_id)
      VALUES('upgrade:unknown',0,'2026-09-20T00:00:00Z',100,'manual','vod_scan','fixture','00000000-0000-0000-0000-0000000000e1');
      INSERT INTO match_participant(match_id,participant_id,team_id,observed_name,champion_id,win,kills,deaths,assists)
      VALUES('upgrade:unknown',1,100,'same-name',34,true,3,8,7),('upgrade:unknown',2,100,'same-name',0,true,null,null,null);`);
    const before=(await upgrade.query('SELECT * FROM match_participant ORDER BY participant_id')).rows as Record<string,unknown>[];
    // 0023 재적용 안전성은 **0023 시점의 스키마**에서 확인한다. 전체 체인 뒤에 재적용하면
    // 0023 의 뷰가 0028 에서 은퇴한 win 컬럼을 참조해 반드시 죽는데, 장부(schema_migration)
    // 때문에 그 순서는 실전에서 일어날 수 없다 — 일어날 수 없는 시나리오로 검사를 깨지 않는다.
    await upgrade.exec(`BEGIN;${migrations.find(m=>m.version==='0023')!.sql}COMMIT;`);
    await upgrade.exec(migrations.find(m=>m.version==='0023')!.sql);
    assert.deepEqual((await upgrade.query('SELECT * FROM match_participant ORDER BY participant_id')).rows,before);
    for(const m of migrations.filter(m=>m.version>'0023')) await upgrade.exec(`BEGIN;${m.sql}COMMIT;`);
    // 0026 이 side_no·outcome 을 붙이고 0028 이 win(boolean) 을 outcome 으로 이관하며 지운다.
    // 스냅샷을 같은 규칙으로 이관해 비교해야 "데이터 보존" 검사가 스키마 진화를 따라간다 —
    // SELECT * 를 그대로 비교하면 컬럼이 하나 늘 때마다 이 검사가 거짓 경보를 낸다.
    // 0089 는 참가자를 기본 칸만 남긴다(상세 칸·버림 칸 삭제) — 남는 칸의 값만 같은 규칙으로 이관해 비교한다.
    const BASE=['match_id','participant_id','puuid','streamer_id','observed_name','team_id','side_no','team_position','individual_position',
      'champion_id','champion_name','champ_level','kills','deaths','assists','outcome'] as const;
    const migrated=before.map(({win,...rest})=>Object.fromEntries(BASE.map(k=>[k,
      k==='side_no'?(rest.team_id===100?1:rest.team_id===200?2:null):k==='outcome'?(win===true?'win':'loss'):rest[k]??null])));
    const baseRows=async(db:PGlite)=>(await db.query(`SELECT ${BASE.join(',')} FROM match_participant ORDER BY participant_id`)).rows;
    assert.deepEqual(await baseRows(upgrade),migrated,'이름만 읽은 자리의 값이 0089 까지 그대로 온다');
    const columns=`SELECT column_name,data_type,ordinal_position FROM information_schema.columns WHERE table_schema='core_public' AND table_name='match_detail' ORDER BY ordinal_position`;
    assert.deepEqual((await upgrade.query(columns)).rows,(await fresh.query(columns)).rows);
    const definition=`SELECT pg_get_viewdef('core_public.match_detail'::regclass) AS definition`;
    assert.deepEqual((await upgrade.query(definition)).rows,(await fresh.query(definition)).rows);
    // 행사에 직접 붙었던 판은 같은 행사의 한 판짜리 시리즈(set:<경기>)가 되고, 이름만 읽은 두 자리가 공개 상세에 나온다.
    assert.deepEqual((await upgrade.query(`SELECT series_id, scope, collected_via FROM match WHERE match_id='upgrade:unknown'`)).rows,
      [{series_id:'set:upgrade:unknown',scope:'versus',collected_via:'vod'}]);
    assert.deepEqual((await upgrade.query(`SELECT participant_id, observed_name, format FROM core_public.match_detail ORDER BY participant_id`)).rows,
      [{participant_id:1,observed_name:'same-name',format:'unclassified'},{participant_id:2,observed_name:'same-name',format:'unclassified'}]);
    console.log('Unknown roster migration: fresh/0022 upgrade schema equality, seat values through 0089, reapplication, public detail passed');
  } finally {await upgrade.close()}
}
