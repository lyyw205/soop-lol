import type postgres from 'postgres';
import { db } from './client.ts';
import { lockSessionMember, memberFromSession, MemberError } from './member.ts';
import { isUuid } from '../metrics/community.ts';
import { ATTACHMENT_MAX, DAILY_UPLOAD_BYTES, uploadInputError, type AttachmentView } from '../metrics/attachments.ts';
import { uploadsEnabled, storageConfigured, r2Storage, type AttachmentStorage } from '../storage/r2.ts';
import { inspectMedia } from '../storage/inspect-media.ts';
import { isOwnerMember } from '../auth/owner.ts';

type Tx=postgres.TransactionSql;
interface Row extends AttachmentView { author_id:string;post_id:number|null;state:string;attached:boolean;created_at:Date; }
const view=(r:AttachmentView):AttachmentView=>({id:r.id,name:r.name,mime:r.mime,bytes:r.bytes,width:r.width,height:r.height});
export async function reserveAttachment(token:string|null,input:{name:string;mime:string;bytes:number},storage:AttachmentStorage=r2Storage) {
  if(!uploadsEnabled())throw new MemberError('파일 첨부가 잠시 중지되어 있습니다.');
  const error=uploadInputError(input.mime,input.bytes);if(error)throw new MemberError(error);
  const name=input.name.replace(/[\x00-\x1f\x7f/\\]/g,'').trim().slice(0,160)||'첨부파일';
  const id=await db().begin(async tx=>{
    const m=await lockSessionMember(tx,token,new Date(),{needNickname:true,checkSanction:true});
    const [usage]=await tx`SELECT coalesce(sum(bytes),0)::float8 AS bytes,count(*)::int AS n FROM community_attachment
      WHERE author_id=${m.id} AND created_at>now()-interval '24 hours'`;
    if(usage.bytes+input.bytes>DAILY_UPLOAD_BYTES||usage.n>=30)throw new MemberError('파일 첨부는 24시간 동안 총 100MB·30회까지 가능합니다.');
    // 모든 예약은 같은 잠금을 사용한다. 삭제 전까지 staging+final 두 사본을 보수적으로 예약.
    await tx`SELECT pg_advisory_xact_lock(920092)`;
    const limit=Number(process.env.COMMUNITY_STORAGE_LIMIT_BYTES??'10000000000');
    const [total]=await tx`SELECT coalesce(sum(bytes::bigint*2),0)::float8 AS bytes FROM community_attachment WHERE state<>'deleted'`;
    if(!Number.isSafeInteger(limit)||limit<=0||total.bytes+input.bytes*2>limit)throw new MemberError('첨부 저장 공간이 가득 찼습니다. 잠시 후 다시 시도해 주세요.');
    const [r]=await tx`INSERT INTO community_attachment(author_id,name,mime,bytes) VALUES(${m.id},${name},${input.mime},${input.bytes}) RETURNING id`;
    return r.id as string;
  });
  return {id,url:await storage.uploadUrl(id,input.mime,input.bytes)};
}
export async function completeAttachment(token:string|null,id:string,storage:AttachmentStorage=r2Storage):Promise<AttachmentView> {
  if(!uploadsEnabled())throw new MemberError('파일 첨부가 잠시 중지되어 있습니다.');
  if(!isUuid(id))throw new MemberError('첨부파일을 확인해 주세요.');
  return db().begin(async tx=>{
    const m=await lockSessionMember(tx,token,new Date(),{needNickname:true,checkSanction:true});
    const [row]=await tx<Row[]>`SELECT * FROM community_attachment WHERE id=${id} FOR UPDATE`;
    if(!row||row.author_id!==m.id)throw new MemberError('첨부파일을 확인해 주세요.');
    if(row.state==='ready')return view(row);
    if(row.state!=='pending'||Date.now()-row.created_at.getTime()>30*60*1000)throw new MemberError('업로드 시간이 만료되었습니다. 파일을 다시 선택해 주세요.');
    await tx`UPDATE community_attachment SET state='verifying' WHERE id=${id}`;
    const body=await storage.readStaging(id,row.bytes);
    let meta;
    try {meta=await inspectMedia(body,row.mime);}catch(e){throw new MemberError(e instanceof Error ? e.message : '파일을 읽을 수 없습니다.');}
    await storage.publish(id,body,row.mime);
    // 원본 PUT 주소는 최대 5분 재사용 가능. 남는 staging은 정기 정리에서도 다시 삭제한다.
    await storage.removeStaging(id);
    const [saved]=await tx<Row[]>`UPDATE community_attachment SET state='ready',width=${meta.width},height=${meta.height},duration=${meta.duration}
      WHERE id=${id} RETURNING *`;
    return view(saved);
  });
}
/** 글 저장 트랜잭션 안에서 호출. 본인 파일만 하나의 글에 연결; 명시하지 않은 기존 호출은 연결 유지. */
export async function attachToPost(tx:Tx,author:string,postId:number,ids:string[]|undefined) {
  if(ids===undefined)return;
  if(!Array.isArray(ids)||ids.length>ATTACHMENT_MAX||new Set(ids).size!==ids.length||!ids.every(isUuid))throw new MemberError('첨부파일은 최대 10개까지 선택해 주세요.');
  const rows=ids.length?await tx<Row[]>`SELECT * FROM community_attachment WHERE id=ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`:[];
  if(rows.length!==ids.length||rows.some(r=>r.author_id!==author||r.state!=='ready'||(r.post_id!==null&&Number(r.post_id)!==postId)||(!r.post_id&&Date.now()-r.created_at.getTime()>86400000)))throw new MemberError('사용할 수 없는 첨부파일이 있습니다. 다시 올려 주세요.');
  await tx`UPDATE community_attachment SET attached=false,retired_at=now() WHERE post_id=${postId} AND attached AND NOT(id=ANY(${ids}::uuid[]))`;
  for(const [position,id] of ids.entries())await tx`UPDATE community_attachment SET post_id=${postId},attached=true,position=${position},retired_at=NULL WHERE id=${id}`;
}
export async function publicAttachments(postId:number):Promise<AttachmentView[]> {
  return db()<AttachmentView[]>`SELECT id,name,mime,bytes,width,height FROM core_public.community_attachment WHERE post_id=${postId} ORDER BY position,id`;
}
export async function attachmentReadUrl(token:string|null,id:string,storage:AttachmentStorage=r2Storage):Promise<string|null> {
  if(!isUuid(id)||!storageConfigured())return null;
  const [pub]=await db()`SELECT id,mime FROM core_public.community_attachment WHERE id=${id}`;
  if(pub)return storage.readUrl(id,pub.mime);
  const me=await memberFromSession(token);if(!me)return null;
  const [row]=await db()<Row[]>`SELECT * FROM community_attachment WHERE id=${id} AND state='ready'`;
  if(!row)return null;
  // 숨김/삭제된 글의 작성자에게도 URL을 발급하지 않는다. 미게시 초안만 본인 미리보기 허용.
  if(isOwnerMember(me)||(row.post_id===null&&row.author_id===me.member_id&&Date.now()-row.created_at.getTime()<86400000))return storage.readUrl(id,row.mime);
  return null;
}
/** 기존 일일 housekeep에 참여. 삭제 실패는 deleting으로 남겨 재시도하고 용량도 해제하지 않는다. */
export async function cleanupAttachments(storage:AttachmentStorage=r2Storage,now=new Date()) {
  if(!storageConfigured())return {deleted:0,failed:0};
  const candidates=await db()`SELECT a.id FROM community_attachment a LEFT JOIN community_post p ON p.id=a.post_id
    WHERE a.state<>'deleted' AND (
      a.state='deleting' OR
      (a.post_id IS NULL AND a.created_at<${new Date(now.getTime()-86400000)}) OR
      (a.post_id IS NOT NULL AND (p.body IS NULL OR (NOT a.attached AND a.retired_at<${new Date(now.getTime()-30*86400000)}))
        AND NOT EXISTS(SELECT 1 FROM community_report r WHERE r.kind='post' AND r.target_id=a.post_id AND (r.status='open' OR r.snapshot_body IS NOT NULL)))
    ) ORDER BY a.created_at LIMIT 100`;
  let deleted=0,failed=0;
  for(const candidate of candidates){
    // 글 → 첨부 잠금 순서. 후보 조회 뒤 재연결/신고 발생 여부를 다시 검사.
    const claimed=await db().begin(async tx=>{
      const [hint]=await tx`SELECT post_id FROM community_attachment WHERE id=${candidate.id}`;
      if(hint?.post_id)await tx`SELECT id FROM community_post WHERE id=${hint.post_id} FOR UPDATE`;
      const [a]=await tx`SELECT a.*,p.body FROM community_attachment a LEFT JOIN community_post p ON p.id=a.post_id WHERE a.id=${candidate.id} FOR UPDATE OF a`;
      if(!a||a.state==='deleted')return false;
      if(a.state!=='deleting'){
        if(a.post_id){
          if(a.body!==null&&(a.attached||!a.retired_at||a.retired_at>=new Date(now.getTime()-30*86400000)))return false;
          const [held]=await tx`SELECT 1 FROM community_report WHERE kind='post' AND target_id=${a.post_id} AND (status='open' OR snapshot_body IS NOT NULL) LIMIT 1`;
          if(held)return false;
        } else if(a.created_at>=new Date(now.getTime()-86400000))return false;
      }
      await tx`UPDATE community_attachment SET state='deleting',attached=false WHERE id=${a.id}`;return true;
    });
    if(!claimed)continue;
    try{await storage.remove(candidate.id);await db()`UPDATE community_attachment SET state='deleted' WHERE id=${candidate.id} AND state='deleting'`;deleted++;}catch{failed++;}
  }
  // PUT 주소 재사용으로 남는 staging도 서명 만료 이후에 다시 정리한다.
  const ready=await db()`SELECT id FROM community_attachment WHERE state='ready' AND NOT staging_cleaned AND created_at<${new Date(now.getTime()-3600000)} ORDER BY created_at LIMIT 100`;
  for(const a of ready){try{await storage.removeStaging(a.id);await db()`UPDATE community_attachment SET staging_cleaned=true WHERE id=${a.id}`;}catch{failed++;}}
  return {deleted,failed};
}
