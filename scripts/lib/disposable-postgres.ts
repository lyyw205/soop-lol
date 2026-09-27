/** Owns a fresh local cluster; never accepts DATABASE_URL or an existing data directory. */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
const exec = promisify(execFile);
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const port=(server.address() as {port:number}).port;
  await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  return port;
}
export async function disposablePostgres() {
  const bin = process.env.CK_PG_BIN;
  if (!bin) throw new Error('CK_PG_BIN 에 PostgreSQL initdb/pg_ctl 실행 파일 디렉터리를 지정하세요. 외부 DATABASE_URL 은 사용하지 않습니다.');
  const dir=await mkdtemp(join(tmpdir(),'soop-ck-pg-'));
  const data=join(dir,'data'), port=await freePort();
  let started=false;
  try {
    await exec(join(bin,'initdb'),['-D',data,'--username=ck_test','--auth=trust','--no-locale'],{timeout:60_000});
    await exec(join(bin,'pg_ctl'),['-D',data,'-l',join(dir,'server.log'),'-o',`-h 127.0.0.1 -p ${port} -k ${dir}`,'-w','start'],{timeout:60_000});
    started=true;
  } catch (error) {
    const log=await readFile(join(dir,'server.log'),'utf8').catch(()=> '');
    await rm(dir,{recursive:true,force:true});
    throw new Error(`${error}\n${log}`);
  }
  return {url:`postgres://ck_test@127.0.0.1:${port}/postgres`, async stop(){
    if (started) await exec(join(bin,'pg_ctl'),['-D',data,'-m','immediate','-w','stop'],{timeout:30_000});
    await rm(dir,{recursive:true,force:true});
  }};
}
