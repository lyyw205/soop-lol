/** 외부 DB/R2 없이 첨부 권한·한도·검사·보존 정책을 실제 PGlite에서 검증한다. */
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {readFile} from 'node:fs/promises';
import {Input,BufferSource,MP4,EncodedPacketSink,Output,Mp4OutputFormat,BufferTarget,EncodedVideoPacketSource} from 'mediabunny';
import {inspectMedia} from '../packages/core/lib/storage/inspect-media.ts';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { applyAll } from './lib/migrations.ts';
import { freePort } from './lib/disposable-postgres.ts';
import type { AttachmentStorage } from '../packages/core/lib/storage/r2.ts';
const memory=await PGlite.create({extensions:{pg_trgm,pgcrypto}}),port=await freePort();
const server=new PGLiteSocketServer({db:memory,host:'127.0.0.1',port});await server.start();
process.env.DATABASE_URL=`postgres://postgres@127.0.0.1:${port}/postgres`;process.env.DATABASE_POOL_MAX='1';
process.env.COMMUNITY_UPLOAD_ENABLED='true';process.env.R2_ACCOUNT_ID='a'.repeat(32);process.env.R2_BUCKET='test';process.env.R2_ACCESS_KEY_ID='test';process.env.R2_SECRET_ACCESS_KEY='test';
const {db,closeDb}=await import('../packages/core/lib/db/client.ts');
const {loginWithIdentity,createSession,setNickname}=await import('../packages/core/lib/db/member.ts');
const {reserveAttachment,completeAttachment,attachmentReadUrl,publicAttachments,cleanupAttachments}=await import('../packages/core/lib/db/attachments.ts');
const {createPost,editPost,reportContent}=await import('../packages/core/lib/db/community.ts');
const {getPublicCommunityPost}=await import('../packages/core/lib/db/community-public.ts');
const staging=new Map<string,Buffer>(),files=new Map<string,Buffer>();
const storage:AttachmentStorage={
 async uploadUrl(id){return `https://test.invalid/${id}`;},async readStaging(id,n){const b=staging.get(id);if(!b||b.length!==n)throw Error('size');return b;},
 async publish(id,b){files.set(id,Buffer.from(b));},async removeStaging(id){staging.delete(id);},async remove(id){files.delete(id);staging.delete(id);},async readUrl(id){return `https://test.invalid/read/${id}`;},
};
try{
 await applyAll(sql=>memory.exec(sql),join(import.meta.dirname,'..'));
 async function member(sub:string){const m=await loginWithIdentity('google',sub);if(m.kind!=='ok')throw Error();const s=await createSession(m.memberId);await setNickname(s.token,`첨부${sub}`,{agreed:true});return {id:m.memberId,token:s.token};}
 const a=await member('회원가'),b=await member('회원나');
 const png=await sharp({create:{width:12,height:8,channels:3,background:'#abc'}}).png().toBuffer();
 await assert.rejects(()=>inspectMedia(png,'image/gif'),/일치/);
 const video=await readFile(join(import.meta.dirname,'fixtures/attachment-frame.mp4'));
 assert.equal((await inspectMedia(video,'video/mp4')).duration,1);
 await assert.rejects(()=>inspectMedia(png,'video/mp4'));
 const vin=new Input({source:new BufferSource(video),formats:[MP4]});
 const track=(await vin.getPrimaryVideoTrack())!,packet=(await new EncodedPacketSink(track).getFirstKeyPacket())!;
 const target=new BufferTarget(),output=new Output({format:new Mp4OutputFormat(),target}),source=new EncodedVideoPacketSource('avc');
 output.addVideoTrack(source);await output.start();await source.add(packet.clone({timestamp:0,duration:61}),{decoderConfig:(await track.getDecoderConfig())!});await output.finalize();vin.dispose();
 await assert.rejects(()=>inspectMedia(Buffer.from(target.buffer!),'video/mp4'),/60초/);
 const input={name:'image.png',mime:'image/png',bytes:png.length};
 process.env.COMMUNITY_UPLOAD_ENABLED='false';await assert.rejects(()=>reserveAttachment(a.token,input,storage),/중지/);process.env.COMMUNITY_UPLOAD_ENABLED='true';
 await assert.rejects(()=>reserveAttachment(null,input,storage),/로그인/);
 await assert.rejects(()=>reserveAttachment(a.token,{...input,bytes:10_000_001},storage),/10MB/);
 await assert.rejects(()=>reserveAttachment(a.token,{...input,mime:'image/svg+xml'},storage),/MP4/);
 const r=await reserveAttachment(a.token,input,storage);staging.set(r.id,png);
 await assert.rejects(()=>completeAttachment(b.token,r.id,storage),/확인/);
 const ready=await completeAttachment(a.token,r.id,storage);assert.equal(ready.width,12);assert.equal(staging.has(r.id),false);
 assert.equal(await attachmentReadUrl(null,r.id,storage),null);
 assert.equal(await attachmentReadUrl(b.token,r.id,storage),null);
 assert.ok(await attachmentReadUrl(a.token,r.id,storage));
 const postInput={game_code:null,topic:'free' as const,title:'첨부검증',body:'',streamer_ids:[],attachment_ids:[r.id]};
 await assert.rejects(()=>createPost(b.token,postInput),/첨부파일/);
 const post=await createPost(a.token,postInput);
 assert.equal((await publicAttachments(post.id)).length,1);assert.ok(await attachmentReadUrl(null,r.id,storage));
 await db()`UPDATE community_post SET status='hidden' WHERE id=${post.id}`;
 assert.equal(await attachmentReadUrl(null,r.id,storage),null);assert.equal(await attachmentReadUrl(a.token,r.id,storage),null);
 await db()`UPDATE community_post SET status='published' WHERE id=${post.id}`;
 await reportContent(b.token,'post',post.id,'spam',null);
 const [snapshot]=await db()`SELECT snapshot_attachment_ids FROM community_report WHERE target_id=${post.id}`;assert.deepEqual(snapshot.snapshot_attachment_ids,[r.id]);
 const detail=await getPublicCommunityPost(post.id);assert.ok(detail);
 await editPost(a.token,post.id,{...postInput,body:'파일을 제거했습니다.',attachment_ids:[]},detail.version);
 assert.equal(await attachmentReadUrl(null,r.id,storage),null);
 const future=new Date(Date.now()+32*86400000);
 await cleanupAttachments(storage,future);assert.ok(files.has(r.id),'신고된 파일은 보존');
 await db()`UPDATE community_report SET status='dismissed',handled_at=now(),snapshot_body=NULL,snapshot_title=NULL,snapshot_attachment_ids='{}' WHERE target_id=${post.id}`;
 await cleanupAttachments(storage,future);assert.equal(files.has(r.id),false);
 const orphan=await reserveAttachment(a.token,input,storage);staging.set(orphan.id,png);await completeAttachment(a.token,orphan.id,storage);
 await cleanupAttachments(storage,new Date(Date.now()+2*86400000));assert.equal(files.has(orphan.id),false);
 const fake=await reserveAttachment(a.token,{...input,bytes:8},storage);staging.set(fake.id,Buffer.from('notimage'));await assert.rejects(()=>completeAttachment(a.token,fake.id,storage));assert.equal(files.has(fake.id),false);
 const budget=await member('한도');for(let i=0;i<3;i++)await reserveAttachment(budget.token,{name:'v.mp4',mime:'video/mp4',bytes:30_000_000},storage);
 await assert.rejects(()=>reserveAttachment(budget.token,{name:'v.mp4',mime:'video/mp4',bytes:30_000_000},storage),/100MB/);
 process.env.COMMUNITY_STORAGE_LIMIT_BYTES='1';await assert.rejects(()=>reserveAttachment(a.token,input,storage),/저장 공간/);
 console.log('PASS format/size, session/ownership, private draft, atomic post attachment, hidden access, report snapshot retention, orphan cleanup, user/global quotas');
}finally{await closeDb();await server.stop();await memory.close();}
