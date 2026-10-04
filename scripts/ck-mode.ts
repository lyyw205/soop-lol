/** 확인한 원본에 근거한 모드 정정. 기본은 미리보기. 대회명/후보 제목으로 모드를 추측하지 않는다. */
import {parseArgs} from 'node:util';
import {db,closeDb} from '@soop-lol/core/lib/db/client';
import {correctMatchMode} from '@soop-lol/core/lib/db/ck';
const {values:v}=parseArgs({options:{match:{type:'string'},mode:{type:'string'},frame:{type:'string'},reason:{type:'string'},apply:{type:'boolean'}}});
try {
  if(!v.match||!v.frame||!v.reason?.trim()||!['CLASSIC','ARAM'].includes(v.mode??''))
    throw new Error('사용법: node --env-file-if-exists=apps/web/.env.local scripts/ck-mode.ts --match ID --mode ARAM|CLASSIC --frame 경로 --reason 확인근거 [--apply]');
  const [row]=await db()<{game_mode:string|null;map_id:number|null}[]>`
    SELECT m.game_mode,m.map_id FROM match m JOIN match_evidence_frame f ON f.match_id=m.match_id
    WHERE m.match_id=${v.match} AND m.game_code='lol' AND m.source='manual' AND f.frame_path=${v.frame} AND f.read_at IS NOT NULL`;
  if(!row)throw new Error('경기와 연결된 열람 근거를 찾지 못했다');
  console.log(JSON.stringify({match:v.match,before:row,after:{game_mode:v.mode,map_id:v.mode==='ARAM'?12:11},frame:v.frame,reason:v.reason,apply:v.apply===true},null,2));
  if(v.apply)await correctMatchMode({match_id:v.match,expected_mode:row.game_mode,game_mode:v.mode as 'CLASSIC'|'ARAM',evidence_frame:v.frame,reason:v.reason});
}catch(e){console.error(e instanceof Error?e.message:e);process.exitCode=1;}finally{await closeDb();}
