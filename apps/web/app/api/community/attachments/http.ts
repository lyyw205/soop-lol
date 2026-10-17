import { MemberError } from '@soop-lol/core/lib/db/member';
export const privateHeaders = { 'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff' };
export async function uploadRequest(req:Request):Promise<Record<string,unknown>> {
  const origin=req.headers.get('origin');
  if(!origin || new URL(origin).host!==req.headers.get('host') || !req.headers.get('content-type')?.startsWith('application/json'))throw new MemberError('사이트에서 다시 시도해 주세요.');
  const reader=req.body?.getReader();if(!reader)throw new MemberError('요청 내용이 없습니다.');
  let size=0;const chunks:Uint8Array[]=[];
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>4096)throw new MemberError('요청이 너무 큽니다.');chunks.push(value);}}
  finally {await reader.cancel();}
  try {const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))throw Error();return data;}
  catch {throw new MemberError('요청 형식을 확인해 주세요.');}
}
export function uploadError(e:unknown) {
  return Response.json({error:e instanceof MemberError?e.message:'파일 처리에 실패했습니다. 잠시 후 다시 시도해 주세요.'},{status:e instanceof MemberError?400:503,headers:privateHeaders});
}
