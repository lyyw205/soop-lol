import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export function storageConfigured() {
  return ['R2_ACCOUNT_ID','R2_BUCKET','R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY'].every(k => !!process.env[k]?.trim());
}
export function uploadsEnabled() { return process.env.COMMUNITY_UPLOAD_ENABLED === 'true' && storageConfigured(); }
function config() {
  const account = process.env.R2_ACCOUNT_ID?.trim(), bucket = process.env.R2_BUCKET?.trim();
  if (!storageConfigured() || !/^[a-f0-9]{32}$/i.test(account!) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket!)) throw new Error('R2 설정을 확인해 주세요.');
  const client = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`, forcePathStyle: true,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!.trim(), secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!.trim() },
    requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', maxAttempts: 2 });
  return { client, bucket: bucket! };
}
export const stagingKey = (id: string) => `community/staging/${id}`;
export const finalKey = (id: string) => `community/files/${id}`;
export interface AttachmentStorage {
  uploadUrl(id: string, mime: string, bytes: number): Promise<string>;
  readStaging(id: string, bytes: number): Promise<Buffer>;
  publish(id: string, body: Buffer, mime: string): Promise<void>;
  removeStaging(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  readUrl(id: string, mime: string): Promise<string>;
}
export const r2Storage: AttachmentStorage = {
  async uploadUrl(id, mime, bytes) {
    const {client,bucket} = config();
    return getSignedUrl(client, new PutObjectCommand({Bucket:bucket,Key:stagingKey(id),ContentType:mime,ContentLength:bytes}),
      {expiresIn:300,signableHeaders:new Set(['content-type','content-length'])});
  },
  async readStaging(id, bytes) {
    const {client,bucket} = config();
    const r = await client.send(new GetObjectCommand({Bucket:bucket,Key:stagingKey(id)}), {abortSignal:AbortSignal.timeout(30000)});
    if (!r.Body) throw new Error('업로드 파일이 없습니다.');
    const body = r.Body as AsyncIterable<Uint8Array> & {destroy?:()=>void};
    try {
      if (r.ContentLength !== bytes) throw new Error('파일 크기가 다릅니다.');
      const chunks:Buffer[]=[];let total=0;
      for await (const chunk of body) { total+=chunk.length;if(total>bytes)throw new Error('파일 크기가 다릅니다.');chunks.push(Buffer.from(chunk)); }
      if(total!==bytes)throw new Error('파일 크기가 다릅니다.');
      return Buffer.concat(chunks);
    } finally {body.destroy?.();}
  },
  async publish(id, body, mime) {
    const {client,bucket}=config();
    // 클라이언트가 재사용할 수 있는 PUT 주소와 최종 파일 키를 분리한다.
    await client.send(new PutObjectCommand({Bucket:bucket,Key:finalKey(id),Body:body,ContentType:mime,CacheControl:'private, no-store'}),{abortSignal:AbortSignal.timeout(30000)});
  },
  async removeStaging(id) {const {client,bucket}=config();await client.send(new DeleteObjectCommand({Bucket:bucket,Key:stagingKey(id)}),{abortSignal:AbortSignal.timeout(15000)});},
  async remove(id) {const {client,bucket}=config();await this.removeStaging(id);await client.send(new DeleteObjectCommand({Bucket:bucket,Key:finalKey(id)}),{abortSignal:AbortSignal.timeout(15000)});},
  async readUrl(id,mime) {const {client,bucket}=config();return getSignedUrl(client,new GetObjectCommand({Bucket:bucket,Key:finalKey(id),ResponseContentType:mime,ResponseCacheControl:'private, no-store'}),{expiresIn:60});},
};
