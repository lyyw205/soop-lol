import { readSessionToken } from '@soop-lol/core/lib/auth/request';
import { attachmentReadUrl } from '@soop-lol/core/lib/db/attachments';
import { privateHeaders } from '../http';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(_req:Request,{params}:{params:Promise<{id:string}>}) {
  const url=await attachmentReadUrl(await readSessionToken(),(await params).id);
  return url ? new Response(null,{status:302,headers:{...privateHeaders,Location:url}}) : new Response('파일을 찾을 수 없습니다.',{status:404,headers:privateHeaders});
}
