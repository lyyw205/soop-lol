/** 요청은 [전체 시작초, 길이], 제외 구간은 [전체 시작초, 끝초]. */
export interface AudioPart { index: number; offset_sec: number; length_sec: number }
export function splitAudioRanges(requested: number[][], inputParts: AudioPart[]) {
  const parts = inputParts.map(p => ({...p, end:p.offset_sec+p.length_sec})).sort((a,b)=>a.offset_sec-b.offset_sec);
  const pieces: {at:number;span:number;part:AudioPart}[] = [];
  const outOfRange: [number,number][] = [];
  for (const request of requested) {
    const [at, span] = request;
    if (request.length !== 2 || !Number.isFinite(at) || !Number.isFinite(span) || at < 0 || span <= 0 || !Number.isFinite(at+span)) throw new Error('요청은 [시작초, 양수 길이초]여야 합니다.');
    let cursor=at;
    const stop=at+span;
    while (cursor<stop) {
      const part=parts.find(p=>cursor>=p.offset_sec && cursor<p.end);
      if (!part) {
        const until=Math.min(stop,parts.find(p=>p.offset_sec>cursor)?.offset_sec ?? stop);
        outOfRange.push([cursor,until]); cursor=until; continue;
      }
      const until=Math.min(stop,part.end);
      pieces.push({at:cursor,span:until-cursor,part}); cursor=until;
    }
  }
  return {pieces,outOfRange};
}
export function audioManifest(input: {
  vodId: number; title: string | null; vodSeconds: number; plannedRanges: number[][];
  outOfRange: [number,number][]; clips: {id:string;at:number;seconds:number;audio:string;cached?:boolean}[];
  failed: {at:number;why:string}[];
}) {
  return {...input, timestampBasis:'ck:probe 의 HLS 실측 축 (VOD 전체 초)',
    plannedRangeFormat:'start,duration', outOfRangeFormat:'start,end',
    // complete 는 유효 다운로드 조각의 완료 여부다. 요청 제외·읽음과 구분한다.
    complete:input.clips.length>0 && input.failed.length===0,
    clips:input.clips.map(({cached:_,...clip})=>clip)};
}
