"use client";
import { useRef, useState } from 'react';
import { attachmentUploadUrl, attachmentCompleteUrl, ATTACHMENT_MAX, UPLOAD_MIMES, uploadInputError, attachmentUrl, type AttachmentView } from '@soop-lol/core/lib/contract/community-client';

export function AttachmentGallery({files}:{files:AttachmentView[]}) {
  return <div className="cm-attachments">{files.map(file=><figure key={file.id}>
    {file.mime==='video/mp4' ? <video controls playsInline preload="none" width={file.width} height={file.height} src={attachmentUrl(file.id)} aria-label={file.name} />
      : <img src={attachmentUrl(file.id)} alt={file.name} loading="lazy" width={file.width} height={file.height} />}
    <figcaption>{file.name} · {(file.bytes/1_000_000).toFixed(1)}MB</figcaption>
  </figure>)}</div>;
}
async function api(path:string,data:unknown) {
  const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const body=await r.json();if(!r.ok)throw new Error(body.error??'업로드 요청에 실패했습니다.');return body;
}
function put(url:string,file:File,progress:(n:number)=>void) {
  return new Promise<void>((resolve,reject)=>{
    const xhr=new XMLHttpRequest();xhr.open('PUT',url);xhr.setRequestHeader('Content-Type',file.type);xhr.timeout=180000;
    xhr.upload.onprogress=e=>{if(e.lengthComputable)progress(Math.round(e.loaded/e.total*100));};
    xhr.onload=()=>xhr.status>=200&&xhr.status<300?resolve():reject(new Error('업로드에 실패했습니다. 다시 시도해 주세요.'));
    xhr.onerror=()=>reject(new Error('연결이 끊겼습니다. 다시 시도해 주세요.'));xhr.ontimeout=()=>reject(new Error('업로드 시간이 초과되었습니다.'));
    xhr.send(file);
  });
}
export function AttachmentPicker({files,onChange,onBusy,disabled}:{files:AttachmentView[];onChange:(f:AttachmentView[])=>void;onBusy:(v:boolean)=>void;disabled:boolean}) {
  const input=useRef<HTMLInputElement>(null),busyRef=useRef(false),filesRef=useRef(files);filesRef.current=files;
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[progress,setProgress]=useState(0),[error,setError]=useState('');
  const retry=useRef<File[]|null>(null);
  async function upload(selected:File[]) {
    if(busyRef.current||disabled||!selected.length)return;
    if(filesRef.current.length+selected.length>ATTACHMENT_MAX){setError('첨부파일은 글당 최대 10개까지 가능합니다.');return;}
    for(const file of selected){const issue=uploadInputError(file.type,file.size);if(issue){setError(`${file.name}: ${issue}`);return;}}
    busyRef.current=true;setBusy(true);onBusy(true);setError('');retry.current=null;
    let done=0;
    try {
      for(const file of selected){
        setMessage(`${file.name} 업로드 중`);setProgress(0);
        const reservation=await api(attachmentUploadUrl(),{name:file.name,mime:file.type,bytes:file.size});
        await put(reservation.url,file,setProgress);setMessage(`${file.name} 파일 검사 중`);
        const ready:AttachmentView=await api(attachmentCompleteUrl(),{id:reservation.id});
        const next=[...filesRef.current,ready];filesRef.current=next;onChange(next);done++;
      }
      setMessage('파일을 첨부했습니다. 글을 등록하면 함께 공개됩니다.');
    }catch(e){retry.current=selected.slice(done);setError(e instanceof Error?e.message:'첨부하지 못했습니다.');setMessage('');}
    finally{busyRef.current=false;setBusy(false);onBusy(false);if(input.current)input.current.value='';}
  }
  return <section className="cm-upload" aria-label="파일 첨부" onDragOver={e=>{e.preventDefault();}} onDrop={e=>{e.preventDefault();void upload(Array.from(e.dataTransfer.files));}}
    onPaste={e=>{if(e.clipboardData.files.length){e.preventDefault();void upload(Array.from(e.clipboardData.files));}}}>
    <div className="cm-upload-heading"><h2>사진·움짤·영상 첨부 <small>{files.length}/{ATTACHMENT_MAX}</small></h2>
      <button type="button" className="cm-secondary" disabled={disabled||busy||files.length>=ATTACHMENT_MAX} onClick={()=>input.current?.click()}>파일 선택</button></div>
    <input ref={input} type="file" aria-label="첨부파일 선택" multiple accept={UPLOAD_MIMES.join(',')} hidden onChange={e=>void upload(Array.from(e.target.files??[]))}/>
    <p className="cm-field-help">파일을 여기로 끌어놓거나 이미지를 붙여넣으세요. 이미지·GIF 10MB, MP4 30MB·60초 이하. 하루 총 100MB까지.</p>
    {busy&&<progress max={100} value={progress} aria-label="파일 업로드 진행률"/>}
    <p role="status" className="cm-field-help">{message}</p>
    {error&&<p role="alert" className="cm-error">{error} {retry.current&&<button type="button" disabled={busy||disabled} onClick={()=>void upload(retry.current!)}>다시 시도</button>}</p>}
    <ol className="cm-upload-list">{files.map((file,i)=><li key={file.id}><span>{file.name}</span><small>{(file.bytes/1_000_000).toFixed(1)}MB</small>
      <button type="button" disabled={disabled||busy||i===0} aria-label={`${file.name} 위로`} onClick={()=>{const next=[...files];[next[i-1],next[i]]=[next[i],next[i-1]];onChange(next);}}>↑</button>
      <button type="button" disabled={disabled||busy} aria-label={`${file.name} 첨부 취소`} onClick={()=>onChange(files.filter(f=>f.id!==file.id))}>삭제</button>
    </li>)}</ol>
  </section>;
}
