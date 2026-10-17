import { readSessionToken } from '@soop-lol/core/lib/auth/request';
import { completeAttachment } from '@soop-lol/core/lib/db/attachments';
import { uploadRequest, uploadError, privateHeaders } from '../http';
export const runtime='nodejs';
export async function POST(req:Request) {
  try {const data=await uploadRequest(req);const result=await completeAttachment(await readSessionToken(),String(data.id??''));return Response.json(result,{headers:privateHeaders});}
  catch(e){return uploadError(e);}
}
