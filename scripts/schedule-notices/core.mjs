import { createHash } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { FORMATS, allowedFormat } from '../../packages/core/lib/metrics/format.ts';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2)); await rename(`${path}.tmp`, path);
}
export function validateConfig(c) {
  for (const [key, min, max] of [['pollMinutes',30,1440],['lookbackDays',1,30],['maxPages',1,20],['maxRequests',1,30],['batchSize',1,10],['maxImages',1,20]]) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) throw new Error(`Invalid config ${key}`);
  }
  if (!Array.isArray(c.channels) || !c.channels.length || new Set(c.channels.map(x=>x.id)).size !== c.channels.length) throw new Error('Invalid channels');
  for (const x of c.channels) if (!/^[a-zA-Z0-9_]+$/.test(x.id) || !/^\d+$/.test(x.bbsNo) || !x.name) throw new Error('Channel needs id/name/notice bbsNo');
  if (typeof c.model !== 'string' || !c.model) throw new Error('Missing model');
  return c;
}
export function plain(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'')
    .replace(/<\/(p|div)>|<br\s*\/?>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&nbsp;/g,' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"')
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_,v)=>{ const n=v[0].toLowerCase()==='x'?parseInt(v.slice(1),16):Number(v); return n<=0x10ffff?String.fromCodePoint(n):''; }).trim();
}
export function normalizePost(raw, channel) {
  if (!/^\d+$/.test(String(raw.titleNo)) || raw.userId !== channel.id) return null;
  const html = raw.content?.content;
  if (typeof html !== 'string') throw new Error(`Missing full body: ${raw.titleNo}`);
  const photos = [...new Set([...(raw.photos ?? []).map(x=>x.url), ...Array.from(html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi),m=>m[1])])].filter(Boolean);
  const value = { key: `${channel.id}-${raw.titleNo}`, channel: channel.id, author: channel.name,
    title: String(raw.titleName ?? ''), postedAt: String(raw.regDate ?? ''), timezone: 'unverified',
    url: `https://www.sooplive.com/station/${channel.id}/post/${raw.titleNo}`, text: plain(html), html, photos };
  return { ...value, revision: hash(value) };
}
export function boardRows(data) {
  if (!Array.isArray(data.contents) || !Array.isArray(data.noticeData) || !Number.isFinite(data.meta?.totalPages)) throw new Error('Unexpected SOOP board response');
  return [...new Map([...data.noticeData, ...data.contents].map(p=>[String(p.titleNo),p])).values()];
}
export function stage(state, post, now = Date.now()) {
  const previous = state.posts[post.key];
  if (previous?.revision === post.revision) return false;
  state.posts[post.key] = { revision: post.revision, channel: post.channel, postedAt: post.postedAt, observedAt: now, status:'pending', attempts:0, nextAttemptAt:0 };
  return true;
}
const str={type:'string'}; const nullable={type:['string','null']};
const object = properties => ({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const array = items => ({type:'array',items});
export const schema = object({results:array(object({
  key:str,revision:str,decision:{enum:['candidate','ignore','review']},reason:str,
  events:array(object({action:{enum:['new','update','cancel','postpone']},title:str,game:{enum:['lol','fconline',null]},
    // ★ 분류는 행사 진행 방식과 같은 어휘(metrics/format.ts) — 모르면 unclassified 하나로만(null 을 두지 않는다).
    format:{enum:[...FORMATS]},date:nullable,startsAt:nullable,timeNote:str,
    participants:array(str),relatedScheduleIds:array(str),evidence:array(str),unknowns:array(str)}))
}))});
export function validateSchema(value, shape, path='result') {
  if (shape.enum && !shape.enum.includes(value)) throw new Error(`${path}: enum`);
  const type=value===null?'null':Array.isArray(value)?'array':typeof value;
  if (shape.type && !(Array.isArray(shape.type)?shape.type:[shape.type]).includes(type)) throw new Error(`${path}: type`);
  if (type==='object' && shape.properties) {
    for(const k of shape.required) if (!(k in value)) throw new Error(`${path}.${k}: missing`);
    for(const k of Object.keys(value)) { if(!shape.properties[k]) throw new Error(`${path}.${k}: unknown`); validateSchema(value[k],shape.properties[k],`${path}.${k}`); }
  }
  if (type==='array' && shape.items) value.forEach((v,i)=>validateSchema(v,shape.items,`${path}[${i}]`));
}
export function validateResult(value, posts, schedules=[]) {
  validateSchema(value,schema);
  const wanted=new Map(posts.map(p=>[p.key,p.revision])); const seen=new Set(); const ids=new Set(schedules.map(s=>s.id));
  for(const r of value.results) {
    if(wanted.get(r.key)!==r.revision || seen.has(r.key)) throw new Error('Missing/duplicate/stale post result'); seen.add(r.key);
    if(r.decision==='ignore' && r.events.length || r.decision==='candidate' && !r.events.length) throw new Error('Decision/events conflict');
    for(const e of r.events) {
      if(!e.title.trim() || !e.evidence.some(x=>x.trim())) throw new Error('Event needs title/evidence');
      if(e.date!==null && (!/^\d{4}-\d{2}-\d{2}$/.test(e.date) || Number.isNaN(Date.parse(e.date)) || new Date(e.date).toISOString().slice(0,10)!==e.date)) throw new Error('Invalid date');
      if(e.startsAt!==null && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\+09:00$/.test(e.startsAt) || !Number.isFinite(Date.parse(e.startsAt)) || e.startsAt.slice(0,10)!==e.date)) throw new Error('Invalid KST time');
      if(e.relatedScheduleIds.some(id=>!ids.has(id))) throw new Error('Invented schedule ID');
      if(e.game && !allowedFormat(e.game,e.format)) throw new Error('Format not allowed for game');
      if(!e.game || !e.date || e.unknowns.length) r.decision='review';
    }
  }
  if(seen.size!==wanted.size) throw new Error('Incomplete batch');
  return value;
}
