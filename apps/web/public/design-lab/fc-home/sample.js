const data = await fetch('./data.json').then(r=>r.json());
const design = document.body.dataset.design || 'a';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 12h14M12 5l7 7-7 7"/></svg>';
const diagonal = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 18 18 6M6 6h12v12"/></svg>';
const searchIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>';
const avatar = (p,cls='') => `<span class="avatar ${cls}">${p.image?`<img src="${esc(p.image)}" alt="" loading="eager"/>`:`<b>${esc(p.name.slice(0,2))}</b>`}</span>`;
const fmt = n => (n/1e8).toLocaleString('ko-KR',{maximumFractionDigits:0});
const pct = p => `${p.change?.pct<0?'−':'+'}${Math.abs(p.change?.pct??0).toFixed(1)}`;
const date = d => new Date(d).toLocaleDateString('en-CA',{timeZone:'Asia/Seoul'});
const shortDate = d => date(d).slice(5).replace('-','.');
const clubs = data.clubs;
const ups = clubs.filter(p=>p.change?.pct>0).sort((a,b)=>b.change.pct-a.change.pct);
const downs = clubs.filter(p=>p.change?.pct<0).sort((a,b)=>a.change.pct-b.change.pct);
const picks = [ups[0],downs[0],clubs[0]];
const moveLabel = i => ['상승률 1위','하락률 1위','구단가치 1위'][i];
let graphId=0;
function graph(p,{area=true,grid=true}={}){
 const h=p.history.filter(d=>d.day>=(p.change?.since??p.history[0].day));
 const min=Math.min(...h.map(p=>p.value)),max=Math.max(...h.map(p=>p.value));
 const start=new Date(h[0].day).getTime(),duration=new Date(h.at(-1).day)-start||1;
 const points=h.map(p=>[5+(new Date(p.day)-start)/duration*590,135-(p.value-min)/(max-min||1)*115]);
 const line=points.map((p,i)=>`${i?'L':'M'}${p[0]},${p[1]}`).join(' ');
 const id='chart-'+graphId++;
 return `<svg class="graph" viewBox="0 0 600 155" preserveAspectRatio="none" aria-label="${esc(p.name)} 구단가치 변화"><defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1"><stop stop-color="currentColor" stop-opacity=".28"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs>${grid?'<path d="M0 25h600M0 85h600M0 145h600" stroke="currentColor" opacity=".1" stroke-dasharray="4 6"/>':''}${area?`<path d="${line} L595,155 L5,155 Z" fill="url(#${id})"/>`:''}<path d="${line}" stroke="currentColor" stroke-width="3" fill="none" stroke-linejoin="round" vector-effect="non-scaling-stroke"/><circle cx="${points.at(-1)[0]}" cy="${points.at(-1)[1]}" r="4" fill="currentColor"/></svg>`;
}
function switcher(){return `<div class="sample-switch"><a href="./index.html" class="sample-home">FC 메인 시안</a><nav aria-label="시안 선택">${[['a','A','STADIUM'],['b','B','EDITORIAL'],['c','C','CONTROL']].map(([key,code,label])=>`<a href="./${key}.html" ${design===key?'aria-current="page"':''}><b>${code}</b><span>${label}</span></a>`).join('')}</nav><span class="sample-note">실제 데이터 · 디자인 비교</span></div>`;}
function header(){return `<header class="header"><div class="header-inner"><a class="brand" href="./${design}.html" aria-label="FC 온라인 홈"><span class="brand-symbol">FC</span><span>SOOP<small>ONLINE</small></span></a><nav aria-label="주요 메뉴"><a href="/fc/search">전적 검색</a><a href="/fc/tournaments">대회</a><a href="/fc/club-value">구단가치</a><i></i><a href="/schedule?game=fconline">편성표</a><a href="/community?game=fconline">커뮤니티</a></nav><a class="game-menu" href="/">FC ONLINE <span>⌄</span></a></div></header>`;}
function search(){return `<div class="search-wrap"><form class="search-box" role="search"><label for="streamer-search">${searchIcon}<span class="sr-only">스트리머 전적 검색</span></label><input id="streamer-search" placeholder="스트리머명 · 감독명 검색" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="results"/><button aria-label="전적 검색">${arrow}</button><ul id="results" role="listbox" hidden></ul></form></div>`;}
function quickPeople(){return `<div class="quick-people">${[clubs[2],clubs[1],clubs[4],clubs[0]].map(p=>`<a href="${p.profile}">${avatar(p)}<span>${esc(p.name)}</span></a>`).join('')}</div>`;}
function heading(title,number,href,label='전체 보기'){return `<div class="section-heading"><h2><span>${number}</span>${title}</h2><a href="${href}">${label}${arrow}</a></div>`;}
function source(){return `<div class="source"><span>10.13 수집 · 등록 스트리머 기준</span><span>등락 비교 ${shortDate(picks[0].change.since)}—${shortDate(picks[0].history.at(-1).day)}</span></div>`;}
function footer(){return `<footer class="footer"><b>SOOP <span>FC ONLINE</span></b><span>Data based on NEXON Open API.</span><span class="footer-mark">●</span></footer>`;}
function matchup(e,style='') {return `<div class="matchup ${style}">${e.sides.map((p,i)=>`${i?'<span class="match-divider">:</span>':''}<div class="match-person">${avatar(p)}<span>${esc(p.name)}</span><b>${p.score??'–'}</b>${p.outcome==='win'?'<small>승</small>':''}</div>`).join('')}</div>`;}
function eventCards(){return data.events.slice(0,3).map((e,i)=>`<a class="event-card" href="${e.href}"><div class="event-top"><span>${e.kind==='ck'?'CK':'TOURNAMENT'}</span><time>${shortDate(e.date)}</time>${i===0?'<small>LATEST</small>':''}</div><h3>${esc(e.name)}</h3><div class="event-score-label">최근 경기</div>${matchup(e)}<div class="event-bottom"><span>${e.count}경기</span>${arrow}</div></a>`).join('');}
function ranked(){return clubs.slice(0,4).map((p,i)=>`<a class="rank-row" href="${p.href}"><span class="rank-number">${String(i+1).padStart(2,'0')}</span>${avatar(p)}<span class="rank-name">${esc(p.name)}<small>${esc(p.nickname)}</small></span><b>${fmt(p.value)}<small>억</small></b>${diagonal}</a>`).join('');}
function ticker(){return `<div class="ticker"><b>CLUB VALUE</b>${clubs.slice(0,4).map(p=>`<a href="${p.href}"><span>${esc(p.name)}</span><strong>${fmt(p.value)}억</strong><small class="${p.change?.pct<0?'down':'up'}">${pct(p)}%</small></a>`).join('')}<a href="/fc/club-value" class="ticker-all">${arrow}</a></div>`;}
function stadium(){return `${switcher()}${header()}<main><section class="a-hero"><div class="a-hero-inner"><div class="a-hero-rule"><span>SOOP / FOOTBALL</span><span>2026 ARCHIVE</span></div><div class="a-hero-title"><h1>FC <span>ONLINE</span></h1><span class="a-side-label">STREAMER RECORDS</span></div><div class="a-search-label">스트리머 전적 검색</div>${search()}${quickPeople()}<div class="a-hero-stat"><b>${data.people.length}<small>STREAMERS</small></b><span class="a-target">＋</span></div></div><div class="a-hero-bottom"><span>FC ONLINE</span><span>전적 · 구단가치 · CK · 대회</span><span>01 — 03</span></div></section><div class="page-width">${ticker()}<section class="a-market">${heading('구단가치','01','/fc/club-value')}<div class="a-market-grid"><article class="a-chart-panel"><div class="a-chart-top"><div class="segment" aria-label="구단 변화 선택"><button data-mover="up" aria-pressed="true">급상승</button><button data-mover="down" aria-pressed="false">급하락</button></div><span>최근 변화</span></div><div id="a-mover"></div></article><aside class="a-ranking"><div class="a-ranking-title"><h3>구단가치 TOP 4</h3><span>BP</span></div>${ranked()}</aside></div>${source()}</section><section class="a-history">${heading('최근 CK · 대회','02','/fc/tournaments')}<div class="event-grid">${eventCards()}</div></section>${footer()}</div></main>`;}
function aMover(p){return `<a class="a-mover-person" href="${p.href}">${avatar(p)}<span><b>${esc(p.name)}</b><small>${esc(p.nickname)}</small></span>${diagonal}</a><div class="a-mover-figure"><strong>${pct(p)}<small>%</small></strong><span>${fmt(p.value)}억 <small>BP</small></span></div>${graph(p)}<div class="a-chart-axis"><span>${shortDate(p.change.since)}</span><span>${shortDate(p.history.at(-1).day)}</span></div>`;}
function editorial(){return `${switcher()}${header()}<main class="page-width"><section class="b-hero"><div class="b-edition"><span>THE STREAMER FOOTBALL INDEX</span><span>2026 / 10.13</span></div><div class="b-hero-type"><h1>FC<span>ONLINE<span class="b-dot">.</span></span></h1><span class="b-vertical">SOOP FOOTBALL ARCHIVE</span></div><img class="b-ball" src="assets/chrome-ball.png" alt="크롬 축구공과 파란 궤도"/><span class="b-hero-count">${data.people.length}<small>STREAMERS</small></span><div class="b-search"><span class="b-search-caption">전적 검색${diagonal}</span>${search()}</div></section><div class="b-quick">${quickPeople()}<a href="/fc/search">모든 스트리머 ${arrow}</a></div><section class="b-market">${heading('구단가치','01','/fc/club-value')}<div class="b-market-grid">${picks.map((p,i)=>`<a href="${p.href}" class="b-value b-value-${i}"><div class="b-value-label"><span>${moveLabel(i)}</span>${diagonal}</div><div class="b-value-person">${avatar(p)}<span>${esc(p.name)}<small>${esc(p.nickname)}</small></span></div><div class="b-value-number">${i===2?fmt(p.value):pct(p)}<small>${i===2?'억':'%'}</small></div>${graph(p,{area:false,grid:false})}<div class="b-value-bottom"><span>${i===2?'총 구단가치':`${fmt(p.value)}억 BP`}</span><span>${shortDate(p.change.since)} — ${shortDate(p.history.at(-1).day)}</span></div></a>`).join('')}</div>${source()}</section><section class="b-history">${heading('최근 CK · 대회','02','/fc/tournaments')}<div class="b-event-list">${data.events.slice(0,3).map((e,i)=>`<a class="b-event" href="${e.href}"><time><b>${date(e.date).slice(-2)}</b><span>${new Date(e.date).toLocaleDateString("en-US",{timeZone:"Asia/Seoul",month:"short",year:"numeric"}).toUpperCase()}</span></time><div class="b-event-name"><span>${e.kind==='ck'?'CK':'대회'}${i===0?' · LATEST':''}</span><h3>${esc(e.name)}</h3><small>확인된 ${e.count}경기</small></div><div class="b-event-score"><small>최근 경기</small>${matchup(e)}</div>${diagonal}</a>`).join('')}</div></section>${footer()}</main>`;}
function playerCard(p,i){return `<a href="${p.profile}" class="c-player c-player-${i}"><span class="c-player-number">${String(p.rank).padStart(2,'0')}</span>${avatar(p)}<span class="c-player-info"><b>${esc(p.name)}</b><span>${fmt(p.value)}억 <small>BP</small></span></span><span class="c-player-label">CLUB VALUE</span></a>`;}
function control(){return `${switcher()}${header()}<main class="page-width"><section class="c-hero"><div class="c-hero-left"><div class="c-index"><span>FC ONLINE</span><span>INDEX / 2026</span></div><h1>FC<span>ONLINE</span></h1><div class="c-search-title"><span>스트리머 전적 검색</span><b>${data.people.length} <small>PLAYERS</small></b></div>${search()}<a href="/fc/search" class="c-all-players">모든 스트리머 ${arrow}</a></div><div class="c-player-wall"><span class="c-wall-grid"></span>${[clubs[2],clubs[0],clubs[1]].map(playerCard).join('')}<span class="c-wall-footer">STREAMER SQUAD<span>01 / ${data.people.length}</span></span></div></section><div class="c-divider"><span>FC ONLINE</span><span>CLUB / VALUE / MATCH</span><span>↓</span></div><section class="c-market">${heading('구단가치','01','/fc/club-value')}<div class="c-value-list">${picks.map((p,i)=>`<a class="c-value-row c-value-${i}" href="${p.href}"><div class="c-value-index"><b>${String(i+1).padStart(2,'0')}</b><span>${moveLabel(i)}</span></div><div class="c-value-person">${avatar(p)}<span><b>${esc(p.name)}</b><small>${esc(p.nickname)}</small></span></div><div class="c-value-chart">${graph(p,{area:false,grid:false})}<span>${shortDate(p.change.since)}—${shortDate(p.history.at(-1).day)}</span></div><div class="c-value-number"><b>${i===2?fmt(p.value):pct(p)}<small>${i===2?'억':'%'}</small></b><span>${i===2?'총 구단가치':`${fmt(p.value)}억 BP`}</span></div><span class="c-value-arrow">${diagonal}</span></a>`).join('')}</div>${source()}</section><section class="c-history">${heading('최근 CK · 대회','02','/fc/tournaments')}<div class="event-grid">${eventCards()}</div></section>${footer()}</main>`;}
$('#app').innerHTML=design==='a'?stadium():design==='b'?editorial():control();
if(design==='a'){
 $('#a-mover').innerHTML=aMover(ups[0]);
 document.querySelectorAll('[data-mover]').forEach(button=>button.addEventListener('click',()=>{
   document.querySelectorAll('[data-mover]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
   $('#a-mover').innerHTML=aMover(button.dataset.mover==='up'?ups[0]:downs[0]);
   $('.a-chart-panel').classList.toggle('is-down',button.dataset.mover==='down');
 }));
}
let hits=[], cursor=0;
const input=$('#streamer-search'), results=$('#results');
function close(){results.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
function show(){
 const q=input.value.trim().replace(/\s/g,'').toLowerCase();
 hits=q?data.people.filter(p=>[p.name,p.nickname,p.slug].some(s=>s.replace(/\s/g,'').toLowerCase().includes(q))).slice(0,6):[];
 if(!q){close();return;}
 results.innerHTML=hits.length?hits.map((p,i)=>`<li role="option" id="result-${i}" aria-selected="${i===cursor}"><a href="${p.href}" tabindex="-1">${avatar(p)}<span>${esc(p.name)}<small>${esc(p.nickname)}</small></span>${arrow}</a></li>`).join(''):'<li class="no-results" role="status">검색 결과가 없습니다.</li>';
 results.hidden=false;input.setAttribute('aria-expanded','true');
 if(hits.length)input.setAttribute('aria-activedescendant','result-'+cursor);
 else input.removeAttribute('aria-activedescendant');
}
input.addEventListener('input',()=>{cursor=0;show();});
input.addEventListener('focus',show);
input.addEventListener('keydown',e=>{
 if(e.key==='Escape')close();
 if(['ArrowDown','ArrowUp'].includes(e.key)&&hits.length){e.preventDefault();cursor=(cursor+(e.key==='ArrowDown'?1:-1)+hits.length)%hits.length;show();}
});
$('.search-box').addEventListener('submit',e=>{e.preventDefault();if(hits.length)location.href=hits[cursor].href;else{input.focus();show();}});
document.addEventListener('pointerdown',e=>{if(!e.target.closest('.search-wrap'))close();});
document.querySelectorAll('img').forEach(img=>img.addEventListener('error',()=>{img.hidden=true;}));
document.body.classList.add('ready');
