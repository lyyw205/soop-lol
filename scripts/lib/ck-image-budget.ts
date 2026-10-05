/** 백필 전용. DB 진척과 무관한 세션 이미지 상한이며 파일 바이트를 base64 상한으로 환산한다. */
import {closeSync, openSync, readSync, statSync} from 'node:fs';
import {extname} from 'node:path';

export const MIB = 1024 * 1024;
export const VERIFIED_CLAUDE_VERSION = '2.1.285';
export const BUDGET_TOOLS = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Skill'];
export interface ImageBudget {
  version: 1; sessionId: string; root: string; vod: number;
  warnBytes: number; limitBytes: number; maxImages: number; flushMs: number;
  bytes: number; images: number; warned: boolean; flushAt: number | null;
  flushCalls: number; maxFlushCalls: number;
  reads: Record<string, number>; actualBytes: number; actualImages: number;
  error?: string;
  forbiddenRoot?: string;
}
export function parseBudget(value: unknown): ImageBudget {
  const s=value as ImageBudget;
  if(!s || s.version!==1 || typeof s.sessionId!=='string' || typeof s.root!=='string'
    || !Number.isSafeInteger(s.vod) || s.vod<=0
    || ![s.warnBytes,s.limitBytes,s.maxImages,s.flushMs,s.bytes,s.images,s.flushCalls,s.maxFlushCalls,s.actualBytes,s.actualImages].every(n=>Number.isSafeInteger(n)&&n>=0)
    || s.warnBytes<=0 || s.warnBytes>=s.limitBytes || s.limitBytes>12*MIB || s.bytes>s.limitBytes
    || s.maxImages<1 || s.maxImages>60 || s.images>s.maxImages || s.flushMs<=0 || s.maxFlushCalls<=0
    || (s.flushAt!==null && (!Number.isFinite(s.flushAt) || s.flushAt<0))
    || !s.reads || typeof s.reads!=='object' || Array.isArray(s.reads) || typeof s.warned!=='boolean')
    throw new Error('이미지 예산 상태가 손상되었다');
  return s;
}
export interface HookInput {
  hook_event_name: string; session_id: string; cwd: string;
  tool_name: string; tool_input: Record<string, any>; tool_use_id?: string;
  tool_response?: any;
}
export function createBudget(sessionId: string, root: string, vod: number,
  warnMiB = 8, limitMiB = 12, flushSeconds = 180): ImageBudget {
  if (![warnMiB,limitMiB,flushSeconds].every(Number.isFinite)
    || warnMiB <= 0 || limitMiB <= warnMiB || limitMiB > 12 || flushSeconds <= 0)
    throw new Error('이미지 한도: 0 < 경고 < 차단 <= 12 MiB, 종료 유예는 양수');
  if (!Number.isSafeInteger(vod) || vod <= 0) throw new Error('VOD 번호 필요');
  return parseBudget({version:1,sessionId,root,vod,warnBytes:Math.floor(warnMiB*MIB),limitBytes:Math.floor(limitMiB*MIB),
    maxImages:60,flushMs:flushSeconds*1000,bytes:0,images:0,warned:false,flushAt:null,
    flushCalls:0,maxFlushCalls:30,reads:{},actualBytes:0,actualImages:0});
}

/** CLI 2.1.285의 정상 JPEG/PNG 경로는 <=2000px, <=3MiB이면 확대/재인코딩하지 않는다.
 * 이후 압축은 입력보다 작은 결과만 선택한다. 지원 범위 밖은 추측하지 않고 거부한다.
 * 원본은 수정하지 않는다. PDF/노트북의 내장 이미지 등 다른 입력 경로도 거부한다. */
export function imageCharge(path: string): number | null {
  const ext=extname(path).toLowerCase();
  if (['.pdf','.ipynb','.gif','.webp','.svg'].includes(ext)) throw new Error('이 백필 이미지 제한은 JPEG/PNG만 검증했다');
  const file=statSync(path);
  if (!file.isFile()) return null;
  const fd=openSync(path,'r'), data=Buffer.alloc(Math.min(file.size,128*1024));
  try {readSync(fd,data,0,data.length,0);} finally {closeSync(fd);}
  const jpeg=data[0]===0xff && data[1]===0xd8;
  const png=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (!jpeg && !png) {
    if (['.jpg','.jpeg','.png'].includes(ext) || data.subarray(0,5).toString()==='%PDF-'
      || data.subarray(0,3).toString()==='GIF' || data.subarray(8,12).toString()==='WEBP')
      throw new Error('이미지 형식 또는 크기 확인 실패');
    return null;
  }
  let width=0,height=0;
  if (png && data.length>=24) {width=data.readUInt32BE(16);height=data.readUInt32BE(20);}
  if (jpeg) {
    let i=2;
    while(i+8<data.length) {
      if(data[i++]!==0xff) break;
      while(data[i]===0xff)i++;
      const marker=data[i++];
      if(marker===0xd9 || marker===0xda) break;
      if(marker===0x01 || (marker>=0xd0 && marker<=0xd7))continue;
      if(i+2>data.length)break;
      const length=data.readUInt16BE(i);
      if(length<2)break;
      if([0xc0,0xc1,0xc2].includes(marker)) {height=data.readUInt16BE(i+3);width=data.readUInt16BE(i+5);break;}
      i+=length;
    }
  }
  if (!width || !height || width>2000 || height>2000 || file.size>3*MIB)
    throw new Error('검증 범위 밖 이미지(2000px/3MiB 초과 또는 헤더 미확인). 원본을 바꾸지 말고 보류한다');
  return 4*Math.ceil(file.size/3);
}

export function admitImage(state: ImageBudget, path: string, bytes: number, now=Date.now()): boolean {
  if(state.flushAt!==null)return false;
  if(state.bytes+bytes>state.limitBytes || state.images+1>state.maxImages) {
    state.flushAt=now;return false;
  }
  state.bytes+=bytes;state.images++;state.reads[path]=(state.reads[path]??0)+1;
  if(state.bytes>=state.warnBytes)state.warned=true;
  return true;
}
export function budgetMessage(state: ImageBudget): string {
  return `[백필 이미지 ${(state.bytes/MIB).toFixed(2)}/${(state.limitBytes/MIB).toFixed(2)} MiB, ${state.images}회] `+
    (state.flushAt!==null?'추가 이미지와 탐색을 중단했다. ':'지금 중간 저장하고 이 세션을 종료하라. ')+
    '읽은 관찰·후보·경기와 남은 질문을 기존 ck:merge에 저장하고 종료하라. 필수 탐색이 남으면 running과 다음 행동을 남긴다. 이미 필수 탐색·교차검증 처리를 마쳤으면 미해결 질문을 보존한 done이 가능하다. '+
    'JSON은 Write/Edit로 작성하고 Bash는 단일 npm run ck:merge/ck:record/ck:who 또는 ck:local --finish 명령을 쓴다. '+
    '모르는 값은 추측하지 말고, 예산 소진을 done으로 처리하지 않는다.';
}

/** 저장 단계에서는 쉘 구문/임의 프로그램 없이 기존 명령 하나만 실행한다. */
export function commandWords(command: string): string[] | null {
  if(/[\n\r;$`|&<>\\]/.test(command))return null;
  const words:string[]=[];let word='',quote='',started=false;
  for(const ch of command.trim()) {
    if(quote) {if(ch===quote)quote='';else word+=ch;started=true;}
    else if(ch==='"' || ch==="'") {quote=ch;started=true;}
    else if(/\s/.test(ch)) {if(started){words.push(word);word='';started=false;}}
    else {word+=ch;started=true;}
  }
  if(quote)return null;if(started)words.push(word);return words;
}
export function isFlushCommand(command: string): boolean {
  const w=commandWords(command);if(!w || w[0]!=='npm' || w[1]!=='run' || w[3]!=='--')return false;
  const args=w.slice(4);
  if(w[2]==='ck:merge')return args[0]==='--result' && Boolean(args[1]) && (args.length===2 || (args.length===3 && args[2]==='--dry-run'));
  if(w[2]==='ck:record')return args[0]==='--lead' && /^vod:\d+$/.test(args[1]??'') && args.length===2;
  if(w[2]==='ck:who')return args.length>0 && !args.some(x=>x.startsWith('--env') || x==='--apply');
  if(w[2]==='ck:local')return args.includes('--finish') && args[args.indexOf('--status')+1]==='running'
    && args.every(x=>!x.startsWith('--') || ['--finish','--vod','--run','--opened','--result-frames','--resolved','--status','--games','--resume','--requested','--note'].includes(x));
  return false;
}
