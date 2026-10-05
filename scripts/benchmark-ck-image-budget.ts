/** 유료 실행은 --run으로만. 운영 DB는 SELECT만, 판독·저장은 새 PGlite와 복사한 작업 폴더에서 한다. */
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync,readdirSync,symlinkSync,cpSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname,resolve} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import postgres from 'postgres';
import {PGlite} from '@electric-sql/pglite';
import {pg_trgm} from '@electric-sql/pglite/contrib/pg_trgm';
import {pgcrypto} from '@electric-sql/pglite/contrib/pgcrypto';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {applyAll} from './lib/migrations.ts';
import {freePort} from './lib/disposable-postgres.ts';
import {kstDateString} from '../packages/core/lib/time.ts';
import {vodWork} from '../packages/core/lib/metrics/ck-vod-status.ts';

const {values}=parseArgs({options:{vod:{type:'string',default:'206719759'},budget:{type:'string',default:'12'},run:{type:'boolean'}}});
const vod=Number(values.vod),budget=Number(values.budget);
if(!Number.isSafeInteger(vod)||vod<=0||!Number.isFinite(budget)||budget<=0)throw new Error('VOD/예산 확인 필요');
if(!values.run) {console.log('유료 시험: node --env-file-if-exists=apps/web/.env.local scripts/benchmark-ck-image-budget.ts --run --vod 206719759 --budget 12');process.exit(0);}
const root=resolve(import.meta.dirname,'..');
const dir=join(root,'out/ck/image-budget-pilot',new Date().toISOString().replaceAll(':','-'));
// 기존 저장소 아래면 CLI가 상위 프로젝트를 발견해 그쪽으로 이동할 수 있다.
const work=mkdtempSync(join(tmpdir(),'soop-image-pilot-'));
mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'workspace-path.txt'),work+'\n');
const json=(path:string,value:unknown)=>writeFileSync(path,JSON.stringify(value,null,2)+'\n');
console.log(`시험 기록: ${dir}`);

const probe=JSON.parse(readFileSync(join(root,`out/ck/${vod}/probe.json`),'utf8'));
const day=kstDateString(new Date(probe.broadcast.end));
const source=postgres(process.env.DATABASE_URL!,{prepare:false,max:1,onnotice:()=>{},connection:{default_transaction_read_only:true}});
const seed:Record<string,any[]>={};let truth:any[],truthParticipants:any[],target:any;
// POV 관찰에는 나중에 검수된 신원·포지션이 없을 수 있어, 최종 저장값도 같은 시점에 보존한다.
const participantQuery=`SELECT mp.match_id,m.game_duration,m.winning_team,mp.participant_id,mp.streamer_id,mp.observed_name,
  mp.team_id,mp.champion_id,mp.kills,mp.deaths,mp.assists,mp.team_position,s.slug
  FROM match_participant mp JOIN match m ON m.match_id=mp.match_id
  JOIN match_pov p ON p.match_id=mp.match_id JOIN event_lead l ON l.id=p.lead_id
  LEFT JOIN streamer s ON s.id=mp.streamer_id WHERE l.source_key=$1
  ORDER BY m.game_creation,mp.participant_id`;
try {
  for(const table of ['streamer','streamer_channel','riot_account','streamer_account'])seed[table]=await source.unsafe(`SELECT * FROM ${table}`);
  [target]=await source`SELECT s.slug,c.channel_id FROM streamer s JOIN streamer_channel c ON c.streamer_id=s.id
    WHERE c.platform='soop' AND c.channel_id=${probe.channel_id} AND c.active_to IS NULL`;
  if(!target)throw new Error('VOD 방송 주인 없음');
  truth=await source`SELECT p.match_id,p.observed,m.game_duration,m.winning_team,m.reviewed_at,m.review_completed_at
    FROM match_pov p JOIN event_lead l ON l.id=p.lead_id JOIN match m ON m.match_id=p.match_id
    WHERE l.source_key=${`vod:${vod}`} ORDER BY m.game_creation`;
  truthParticipants=await source.unsafe(participantQuery,[`vod:${vod}`]);
}finally{await source.end();}
json(join(dir,'truth.json'),truth);
json(join(dir,'truth-participants.json'),truthParticipants);

// 운영 .env, 과거 판독 JSON, 과거 대화는 복사하지 않는다. 코드와 판독 전 준비물만 새 작업 폴더에 둔다.
const tracked=execFileSync('git',['ls-files','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
const extra=['scripts/ck-image-budget.ts','scripts/lib/ck-image-budget.ts'];
for(const file of new Set([...tracked,...extra])) {
  if(/(^|\/)\.env(?:\.|$)/.test(file) || !existsSync(join(root,file)))continue;
  const dest=join(work,file);mkdirSync(dirname(dest),{recursive:true});copyFileSync(join(root,file),dest);
}
symlinkSync(join(root,'node_modules'),join(work,'node_modules'),'dir');
execFileSync('git',['init','-q',work]);
const input=join(root,`out/ck/${vod}`),output=join(work,`out/ck/${vod}`);mkdirSync(join(output,'local'),{recursive:true});
for(const name of readdirSync(input))if(/^g\d+\.(jpg|png)$/.test(name) || name==='probe.json')copyFileSync(join(input,name),join(output,name));
for(const name of readdirSync(join(input,'local')))if(/^(overview-\d+\.jpg|candidates-\d+\.jpg|scan\.json|scan-draft\.json|map\.txt)$/.test(name))
  copyFileSync(join(input,'local',name),join(output,'local',name));
if(existsSync(join(input,'sheets')))cpSync(join(input,'sheets'),join(output,'sheets'),{recursive:true});
mkdirSync(join(work,'out/ck-detector'),{recursive:true});
cpSync(join(root,'out/ck-detector/model'),join(work,'out/ck-detector/model'),{recursive:true});
symlinkSync(join(root,'out/ck-detector/venv'),join(work,'out/ck-detector/venv'),'dir');
// 조사 이전부터 쓰던 이름 자료는 유지한다. 평가할 VOD의 결과 파일은 위에서 제외했다.
for(const name of readdirSync(join(root,'seed')))if(/^tournaments-.*\.json$/.test(name))copyFileSync(join(root,'seed',name),join(work,'seed',name));

const database=await PGlite.create({dataDir:join(dir,'database'),extensions:{pg_trgm,pgcrypto}});
let server:PGLiteSocketServer|undefined,active:ReturnType<typeof spawn>|undefined;
const sessions:any[]=[];let reason='session_limit',spent=0;
try {
  await applyAll(sql=>database.exec(sql),root,{includeModules:true});
  for(const [table,rows] of Object.entries(seed)) {
    const {rows:columns}=await database.query<{column_name:string}>(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' AND is_identity='NO' ORDER BY ordinal_position`,[table]);
    const names=columns.map(c=>'"'+c.column_name+'"').join(',');
    for(let i=0;i<rows.length;i+=500)await database.query(`INSERT INTO ${table} (${names}) SELECT ${names} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,[JSON.stringify(rows.slice(i,i+500))]);
  }
  const port=await freePort();server=new PGLiteSocketServer({db:database,port,host:'127.0.0.1'});await server.start();
  const env={...process.env,DATABASE_URL:`postgres://postgres@127.0.0.1:${port}/postgres`,DATABASE_POOL_MAX:'1',
    CK_BACKFILL_MODEL:'sonnet',CK_BACKFILL_SESSION_GAMES:'0',CK_BACKFILL_IMAGE_FLUSH_SECONDS:'180',
    CK_IMAGE_BUDGET_FORBID_ROOT:root,PWD:work};
  // PGlite 시험 DB는 동시에 여러 연결을 받지 않으므로 조사 프롬프트에도 직렬 명령을 명시한다.
  const instruction='\n이 폴더는 이미지 예산 비교용 독립 작업 폴더다. 모든 Bash/DB 명령은 한 번에 하나씩 직렬 실행한다. 다른 폴더의 과거 판독 결과·진단·정답 파일은 읽지 않는다.\n';
  writeFileSync(join(work,'CLAUDE.md'),readFileSync(join(work,'CLAUDE.md'),'utf8')+instruction);
  json(join(dir,'config.json'),{vod,budget,day,target,model:'sonnet',cli:'2.1.285',warning_mib:8,limit_mib:12,
    baseline:'historical; current identity seed, no match/candidate/observation answers in test DB',work});
  let interrupted=false;
  const stop=()=>{interrupted=true;if(active)active.kill('SIGTERM');};process.on('SIGTERM',stop);process.on('SIGINT',stop);
  for(let n=1;n<=12;n++) {
    if(interrupted){reason='interrupted';break;}
    const remaining=budget-spent;if(remaining<0.1){reason='cost_limit';break;}
    const log=join(dir,`session-${n}.log`);writeFileSync(log,'');
    const child=spawn('bash',['scripts/ck-backfill.sh','--streamer',target.slug,'--from',day,'--to',day,'--vod',String(vod),
      '--image-limit-mib','12','--max-sessions','1','--max-budget',String(Math.min(3,remaining))],{cwd:work,env,stdio:['ignore','pipe','pipe']});active=child;
    const {appendFileSync}=await import('node:fs');for(const stream of [child.stdout,child.stderr])stream!.on('data',chunk=>appendFileSync(log,chunk));
    const code=await new Promise<number>((done,reject)=>{child.once('error',reject);child.once('close',c=>done(c??1));});active=undefined;
    const runDirs=readdirSync(join(work,'out/ck/backfill')).filter(x=>x.startsWith('run-')).sort();
    const run=join(work,'out/ck/backfill',runDirs.at(-1)!);
    const usagePath=join(run,'usage.jsonl');const usage=existsSync(usagePath)?JSON.parse(readFileSync(usagePath,'utf8').trim().split('\n').at(-1)!):null;
    if(typeof usage?.api_equivalent_usd==='number')spent+=usage.api_equivalent_usd;
    const {rows}=await database.query<any>('SELECT raw FROM event_lead WHERE source_key=$1',[`vod:${vod}`]);
    const status=vodWork(rows[0]?.raw,probe.total_sec);
    const exitPath=join(run,'session-1.json.exit.json');const image=existsSync(exitPath)?JSON.parse(readFileSync(exitPath,'utf8')):null;
    sessions.push({n,code,usage,image,status,run});json(join(dir,'sessions.json'),sessions);
    console.log(`세션 ${n}: rc=${code}, 누적 $${spent.toFixed(4)}, 상태 ${status.reason}, 이미지 ${image?.images??'?'}`);
    if(!usage){reason='usage_missing';break;}
    if(code!==0){reason=`exit_${code}`;break;}
    if(status.reason===null){reason='complete';break;}
  }
  const {rows:matches}=await database.query('SELECT p.match_id,p.observed,m.game_duration,m.winning_team FROM match_pov p JOIN match m ON m.match_id=p.match_id ORDER BY m.game_creation');
  const {rows:leads}=await database.query('SELECT source_key,raw FROM event_lead');
  const {rows:reviews}=await database.query('SELECT * FROM review_record');
  const {rows:participants}=await database.query(participantQuery,[`vod:${vod}`]);
  json(join(dir,'new-results.json'),{matches,leads,reviews,participants});
  json(join(dir,'summary.json'),{reason,spent,sessions:sessions.length,expected_matches:truth!.length,new_matches:matches.length,
    image_reads:sessions.reduce((n,s)=>n+(s.image?.images??0),0),repeats_within_sessions:sessions.reduce((n,s)=>n+(s.image?.repeats??0),0),
    quality:'원본 및 truth.json과 별도 대조 필요. complete만으로 정확도 통과를 뜻하지 않는다.'});
  console.log(`시험 종료: ${reason}, $${spent.toFixed(4)}, 저장 ${matches.length}경기. ${dir}`);
}finally{if(active)active.kill('SIGTERM');if(server)await server.stop();await database.close();}
