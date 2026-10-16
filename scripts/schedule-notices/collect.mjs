import { mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { soopFetch } from '../lib/soop-http.mjs';
import { boardRows, normalizePost, stage, readJson, writeJson, hash } from './core.mjs';
const API='https://api-channel.sooplive.com/v1.1/channel';
const headers={'user-agent':'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',referer:'https://www.sooplive.com/',accept:'application/json'};
export async function collect(base, config, {request=soopFetch, now=Date.now()}={}) {
  const file=join(base,'state.json');
  const state=await readJson(file,{version:1,posts:{},channels:{}});
  let requests=0, changed=0; const errors=[];
  const get=async url=>{
    if(requests>=config.maxRequests) throw new Error('Request budget reached; next run will resume');
    requests++; const r=await request(url,{headers});
    if(!r.ok) throw new Error(`SOOP HTTP ${r.status}`); return r.json();
  };
  // Oldest checked channel first prevents starvation when the request budget is exhausted.
  const channels=[...config.channels].sort((a,b)=>(state.channels[a.id]?.checkedAt??0)-(state.channels[b.id]?.checkedAt??0));
  for(const channel of channels) {
    if(now-(state.channels[channel.id]?.checkedAt??0)<config.pollMinutes*60000) continue;
    let complete=false; const previous=state.channels[channel.id]??{};
    // Full rolling window, not only new IDs: catches body corrections and pin/unpin changes.
    const cutoff=new Date(now+9*3600000-config.lookbackDays*86400000).toISOString().slice(0,10);
    let page=previous.resumePage??1;
    const seen=new Set();
    try {
      for(let n=0;n<config.maxPages;n++,page++) {
        const q=new URLSearchParams({perPage:'20',page:String(page),bbsNo:channel.bbsNo,orderBy:'reg_date',type:'all',startDate:cutoff,endDate:'',field:'title,contents,user_nick,user_id,hashtags',keyword:''});
        const data=await get(`${API}/${channel.id}/board?${q}`);
        const pinned=new Set((data.noticeData??[]).map(p=>String(p.titleNo)));
        for(let raw of boardRows(data)) {
          if(raw.userId!==channel.id) continue;
          if(!pinned.has(String(raw.titleNo)) && /^\d{4}-\d{2}-\d{2}/.test(raw.regDate??'') && raw.regDate.slice(0,10)<cutoff) continue;
          if(typeof raw.content?.content!=='string') raw=await get(`${API}/${channel.id}/post/${raw.titleNo}`);
          const post=normalizePost(raw,channel); if(!post) continue; seen.add(post.key);
          await writeJson(join(base,'posts',`${post.revision}.json`),post);
          if(stage(state,post,now)) changed++;
          state.posts[post.key].checkedAt=now;
        }
        state.channels[channel.id]={...previous,resumePage:page+1};
        await writeJson(file,state);
        if(page>=data.meta.totalPages || data.contents.length===0 || data.contents.every(p=>/^\d{4}-\d{2}-\d{2}/.test(p.regDate??'') && p.regDate.slice(0,10)<cutoff)) { complete=true; break; }
      }
      // Future events may have old, unpinned source posts outside the rolling window.
      // Recheck up to two oldest such sources per channel; rotate using checkedAt.
      const tracked=[];
      for(const [key,job] of Object.entries(state.posts)) {
        if(job.channel!==channel.id || seen.has(key) || job.status!=='done') continue;
        const result=await readJson(join(base,'results',`${job.revision}.json`));
        const today=new Date(now+9*3600000).toISOString().slice(0,10);
        if(result.events.some(e=>e.date && e.date>=today)) tracked.push([key,job]);
      }
      tracked.sort((a,b)=>(a[1].checkedAt??0)-(b[1].checkedAt??0));
      for(const [key,job] of tracked.slice(0,2)) {
        const raw=await get(`${API}/${channel.id}/post/${key.slice(channel.id.length+1)}`);
        const post=normalizePost(raw,channel);
        if(!post) throw new Error('Tracked post owner changed');
        await writeJson(join(base,'posts',`${post.revision}.json`),post);
        if(stage(state,post,now)) changed++;
        state.posts[key].checkedAt=now;
      }
      state.channels[channel.id]={checkedAt:complete?now:(previous.checkedAt??0),resumePage:complete?1:page,partial:!complete,lastError:null};
    } catch(e) {
      errors.push({channel:channel.id,message:e.message});
      state.channels[channel.id]={...state.channels[channel.id],lastError:e.message,failedAt:now};
      await writeJson(file,state);
      // No continued probing after any failure: preserve queue, try on the next timer tick.
      break;
    }
  }
  state.lastPoll={at:now,requests,changed,errors}; await writeJson(file,state);
  return state.lastPoll;
}
export async function cacheImages(base, post, maxImages, request=soopFetch) {
  if(post.photos.length>maxImages) throw new Error(`Image limit exceeded (${post.photos.length}); manual review required`);
  const assets=[];
  for(const url of post.photos) {
    const u=new URL(url);
    if(u.protocol!=='https:' || !['stimg.sooplive.com','stimg.afreecatv.com'].includes(u.hostname) || u.username || u.password || u.port) throw new Error('Unsupported attachment host; manual review required');
    const path=join(base,'assets',`${hash(url)}${/\.(png|jpe?g|webp|gif)$/i.exec(u.pathname)?.[0] ?? '.png'}`);
    try { await access(path); } catch {
      const r=await request(url,{redirect:'error'});
      if(!r.ok || !/^image\/(png|jpeg|webp|gif)(;|$)/i.test(r.headers.get('content-type')??'')) throw new Error(`Image fetch failed ${r.status}`);
      const bytes=Buffer.from(await r.arrayBuffer()); if(bytes.length>10*1024*1024) throw new Error('Image exceeds 10MiB');
      await mkdir(join(base,'assets'),{recursive:true}); await writeFile(path,bytes);
    }
    assets.push(path);
  }
  return assets;
}
