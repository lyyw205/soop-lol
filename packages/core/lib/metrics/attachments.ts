export const IMAGE_BYTES = 10_000_000;
export const VIDEO_BYTES = 30_000_000;
export const DAILY_UPLOAD_BYTES = 100_000_000;
export const ATTACHMENT_MAX = 10;
export const VIDEO_SECONDS = 60;
export const UPLOAD_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4'] as const;
export interface AttachmentView { id: string; name: string; mime: string; bytes: number; width: number; height: number; }
export function uploadInputError(mime: string, bytes: number): string | null {
  if (!(UPLOAD_MIMES as readonly string[]).includes(mime)) return 'JPG·PNG·WebP·GIF 이미지 또는 MP4 영상만 첨부할 수 있습니다.';
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > (mime === 'video/mp4' ? VIDEO_BYTES : IMAGE_BYTES)) return '이미지는 10MB, 영상은 30MB 이하로 올려 주세요.';
  return null;
}
export const attachmentUrl = (id: string) => `/api/community/attachments/${id}`;

export const attachmentUploadUrl = () => '/api/community/attachments';
export const attachmentCompleteUrl = () => '/api/community/attachments/complete';
