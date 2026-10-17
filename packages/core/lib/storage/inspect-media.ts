import sharp from 'sharp';
import { Input, BufferSource, MP4 } from 'mediabunny';
import { uploadInputError, VIDEO_SECONDS } from '../metrics/attachments.ts';

/** MIME/확장자/브라우저의 duration을 신뢰하지 않는다. 업로드된 바이트만 검사한다. */
export async function inspectMedia(body: Buffer, mime: string) {
  const error=uploadInputError(mime,body.length);if(error)throw new Error(error);
  if(mime==='video/mp4') {
    const input=new Input({source:new BufferSource(body),formats:[MP4]});
    const timer=setTimeout(()=>input.dispose(),15000);
    try {
      const video=await input.getPrimaryVideoTrack();
      const tracks=await input.getTracks();
      const audio=await input.getAudioTracks();
      if(!video || tracks.length>2 || await video.getCodec()!=='avc' || (audio.length && await audio[0].getCodec()!=='aac')) throw new Error('MP4는 H.264 영상과 AAC 음성을 지원합니다.');
      const duration=await input.computeDuration();
      const width=await video.getDisplayWidth(),height=await video.getDisplayHeight();
      if(!Number.isFinite(duration)||duration<=0||duration>VIDEO_SECONDS)throw new Error('영상은 60초 이하로 올려 주세요.');
      if(width<=0||height<=0||width>3840||height>3840||width*height>8_294_400)throw new Error('영상 해상도는 최대 4K까지 지원합니다.');
      return {width,height,duration};
    } finally {clearTimeout(timer);input.dispose();}
  }
  const image=sharp(body,{animated:true,limitInputPixels:100_000_000,failOn:'warning'}).timeout({seconds:15});
  const meta=await image.metadata();
  const formats:Record<string,string>={jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif'};
  if(formats[meta.format??'']!==mime)throw new Error('파일 내용과 이미지 형식이 일치하지 않습니다.');
  const width=meta.width??0,height=meta.pageHeight??meta.height??0,pages=meta.pages??1;
  if(!width||!height||width*height>20_000_000||width*height*pages>100_000_000||pages>600)throw new Error('이미지 해상도 또는 움짤 프레임 수가 너무 큽니다.');
  await image.stats(); // 헤더뿐 아니라 픽셀 디코딩도 확인
  return {width,height,duration:null};
}
