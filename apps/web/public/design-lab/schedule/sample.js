const data = await fetch('./data.json').then(response => {
  if (!response.ok) throw new Error('시안 데이터를 불러오지 못했습니다.');
  return response.json();
});
const design = document.body.dataset.design;
const state = { day: data.today, start: '2026-10-12', game: 'fconline', kind: '', search: '' };
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 12h15m-6-6 6 6-6 6"/></svg>';
const diagonal = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M6 18 18 6M6 6h12v12"/></svg>';
const searchIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="10" cy="10" r="6.5"/><path d="m15 15 5 5"/></svg>';
const dateAt = day => new Date(day + 'T12:00:00+09:00');
const addDays = (day, n) => new Date(dateAt(day).getTime() + n * 86400000).toISOString().slice(0,10);
const dayName = day => ['일','월','화','수','목','금','토'][dateAt(day).getUTCDay()];
const shortDate = day => day.slice(5).replace('-', '.');
const weekNumber = () => 42 + Math.round((dateAt(state.start)-dateAt('2026-10-12')) / (7*86400000));
const days = () => Array.from({length:7}, (_,i) => addDays(state.start, i));
const kindName = e => ({ck:'CK',tournament:'대회',showmatch:'매치'})[e.kind];
const gameName = e => e.game === 'fconline' ? 'FC ONLINE' : 'LOL';
const filtered = () => data.events.filter(e => (!state.game || e.game === state.game) && (!state.kind || e.kind === state.kind) && (!state.search || [e.title,e.stage,...e.people].join(' ').toLowerCase().includes(state.search.toLowerCase()))).sort((a,b) => (a.date+a.time).localeCompare(b.date+b.time));
const inWeek = () => filtered().filter(e => e.date >= state.start && e.date <= addDays(state.start,6));
const onDay = day => filtered().filter(e => e.date === day);
const featured = () => onDay(state.day).find(e => e.kind === 'tournament') ?? onDay(state.day)[0] ?? inWeek()[0];
const avatar = name => `<span class="avatar"><img src="../fc-home/assets/${esc(data.people[name])}" alt="${esc(name)}" loading="eager"></span>`;
const people = (e, limit=4) => `<span class="avatar-stack">${e.people.slice(0,limit).map(avatar).join('')}</span>`;
const status = e => `<span class="status ${e.status === '시간 변경' ? 'changed' : e.status === '종료' ? 'ended' : ''}">${e.status === '예정' ? '<i></i>' : ''}${esc(e.status)}</span>`;
const tag = e => `<span class="kind" data-tone="${e.tone}">${kindName(e)}</span>`;
const empty = '<div class="empty"><span>—</span><p>등록된 일정이 없습니다.</p><button data-reset>이번 주 전체 일정 보기 '+arrow+'</button></div>';
function switcher() {
  return `<div class="design-bar"><a href="index.html">편성표 시안 ${diagonal}</a><nav aria-label="시안 선택">${[['a','A','MATCHDAY'],['b','B','MATCH PAPER'],['c','C','WEEK BOARD']].map(([id,code,label])=>`<a href="${id}.html" ${design===id?'aria-current="page"':''}>${code}<span>${label}</span></a>`).join('')}</nav><span>디자인 시안 · 예시 일정</span></div>`;
}
function header() {
  return `<header class="site-header"><div class="header-inner"><a href="/fc" class="brand"><b class="brand-symbol">S</b><strong>SOOP <span>FC 온라인</span></strong></a><nav class="site-nav" aria-label="주요 메뉴"><a href="/fc/search">전적 검색</a><a href="/fc/tournaments">대회</a><a href="/fc/club-value">구단가치</a><i></i><a href="${design}.html" aria-current="page">편성표</a><a href="/community?site=fconline&game=fconline">커뮤니티</a></nav><a class="actual" href="/schedule?site=fconline&game=fconline">현재 편성표 ${diagonal}</a></div></header>`;
}
function dateControl() {
  return `<div class="date-control"><button data-week="-1" aria-label="이전 주">‹</button><label><span>${shortDate(state.start)} — ${shortDate(addDays(state.start,6))}</span><input type="date" id="date-input" aria-label="날짜 선택" value="${state.day}"></label><button data-week="1" aria-label="다음 주">›</button><button data-today class="today-button">오늘</button></div>`;
}
function filters() {
  return `<div class="filters"><div class="filter-group" role="group" aria-label="게임 필터">${[['','전체'],['fconline','FC 온라인'],['lol','LOL']].map(([game,label])=>`<button data-game="${game}" aria-pressed="${game===state.game}">${label}</button>`).join('')}</div><span class="filter-divider"></span><div class="filter-group kind-filter" role="group" aria-label="일정 유형">${[['','전체 일정'],['tournament','대회'],['ck','CK']].map(([kind,label])=>`<button data-kind="${kind}" aria-pressed="${kind===state.kind}">${label}</button>`).join('')}</div><label class="search">${searchIcon}<input id="search" aria-label="스트리머·일정 검색" value="${esc(state.search)}" placeholder="스트리머 · 일정 검색" type="search"></label></div>`;
}
function weekStrip() {
  return `<nav class="week-strip" aria-label="날짜 선택">${days().map(day=>`<button data-day="${day}" aria-pressed="${state.day===day}" class="${day === data.today ? 'is-today' : ''}"><span>${dayName(day)}${day === data.today ? '<small>오늘</small>' : ''}</span><b>${day.slice(-2)}</b><span class="day-dots">${onDay(day).slice(0,4).map(e=>`<i data-tone="${e.tone}"></i>`).join('') || '<i class="no-dot"></i>'}</span></button>`).join('')}</nav>`;
}
function sectionHead(title, side='') { return `<div class="section-heading"><h2>${title}</h2><span>${side}</span></div>`; }
function eventRows() {
  const events=onDay(state.day);
  return events.length ? `<div class="event-rows">${events.map(e=>`<button class="event-row" data-open="${e.id}" data-tone="${e.tone}"><time>${e.time}<small>${esc(e.status)}</small></time><div class="event-copy"><div>${tag(e)}<span>${gameName(e)}</span></div><h3>${esc(e.title)}</h3><p>${esc(e.stage)} · ${esc(e.host)} 주최</p></div>${people(e)}<span class="row-arrow">${diagonal}</span></button>`).join('')}</div>` : empty;
}
function competitions() {
  const series=[...new Set(inWeek().filter(e=>e.series).map(e=>e.series))];
  return series.length ? series.map(id=>{
    const events=filtered().filter(e=>e.series===id);
    const e=events[0];
    return `<button class="competition" data-open="${e.id}" data-tone="${e.tone}"><div class="competition-top"><span>${kindName(e)}</span><span>${shortDate(events[0].date)} — ${shortDate(events.at(-1).date)}</span></div><h3>${esc(e.title)}</h3><div class="competition-line">${events.map((slot,i)=>`<span class="${slot.date===state.day?'current':''}"><i></i><b>${slot.date.slice(-2)}</b><small>${i===events.length-1?'결승':esc(slot.stage.replace('조별리그 ',''))}</small></span>`).join('')}</div><span class="competition-bottom">${esc(e.host)} 주최 ${arrow}</span></button>`;
  }).join('') : '<p class="muted no-competitions">이 기간에 등록된 대회가 없습니다.</p>';
}
function footer() {
  return `<footer class="footer"><b>SOOP <span>FC ONLINE</span></b><span>예시 일정 · 실제 경기 일정이 아닙니다.</span><a href="index.html">시안 비교 ${arrow}</a></footer>`;
}
function headlineMatch(e, className='') {
  if(!e) return `<div class="feature-empty ${className}"><span>FC ONLINE</span><p>이번 주 일정을 확인하세요.</p></div>`;
  return `<button class="headline-match ${className}" data-open="${e.id}" data-tone="${e.tone}"><div class="headline-top"><span>${gameName(e)} / ${kindName(e)}</span>${status(e)}</div><h2>${esc(e.title)}</h2><p>${esc(e.stage)}</p><div class="headline-bottom">${people(e)}<span class="headline-time"><small>${shortDate(e.date)} ${dayName(e.date)}요일</small><b>${e.time}</b></span><span class="match-link">${diagonal}</span></div></button>`;
}
function stadium() {
  const e=featured();
  return `<main class="stadium"><section class="a-hero"><div class="stadium-image"></div><div class="stadium-beam"></div><div class="container a-hero-inner"><div class="a-title"><div class="eyebrow"><i></i> FC ONLINE / SCHEDULE</div><h1>편성표</h1><div class="display-title">MATCH<span>DAY.</span></div><p>대회부터 CK까지.</p><span class="hero-coordinate">2026 / OCTOBER</span></div>${headlineMatch(e,'a-headline')}</div><div class="a-hero-baseline container"><span>이번 주 <b>${inWeek().length}</b>경기</span>${dateControl()}</div></section><div class="container a-content">${weekStrip()}${filters()}<div class="a-main-grid"><section>${sectionHead(`${shortDate(state.day)} <small>${dayName(state.day)}요일</small>`,`${onDay(state.day).length}경기`)}${eventRows()}<div class="next-days">${sectionHead('다음 일정', 'UP NEXT')}${upcoming()}</div></section><aside>${sectionHead('대회 일정','TOURNAMENTS')}<div class="competitions">${competitions()}</div></aside></div>${footer()}</div></main>`;
}
function upcoming() {
  const events=inWeek().filter(e=>e.date>state.day).slice(0,3);
  return events.length ? `<div class="upcoming">${events.map(e=>`<button data-open="${e.id}" data-tone="${e.tone}"><time><b>${e.date.slice(-2)}</b><small>${dayName(e.date)}요일</small></time><span><small>${e.time} · ${kindName(e)}</small><b>${esc(e.title)}</b><em>${esc(e.stage)}</em></span>${arrow}</button>`).join('')}</div>` : '<p class="muted no-competitions">이번 주 남은 일정이 없습니다.</p>';
}
function editorial() {
  return `<main class="editorial container"><section class="b-hero"><div class="b-edition"><span>THE WEEK IN FC ONLINE</span><span>OCTOBER 2026 / VOL. 42</span></div><div class="b-hero-grid"><div class="b-title"><span class="eyebrow">대회 · CK · 매치</span><h1>편성표<span>.</span></h1><div class="b-week-type">MATCH<br><span>WEEK</span><sup>42</sup></div><div class="b-caption"><span>${shortDate(state.start)} — ${shortDate(addDays(state.start,6))}</span><span>이번 주 ${inWeek().length}경기 ${arrow}</span></div></div><div class="b-art"><img src="../fc-home/assets/chrome-ball.png" alt="" class="chrome-ball"><span class="b-art-orbit"></span><span class="b-art-label">FC<br>ONLINE</span>${headlineMatch(featured(),'b-ticket')}</div></div></section><div class="b-content-head"><h2>주간 일정 <span>WEEKLY FIXTURES</span></h2>${dateControl()}</div>${filters()}<div class="b-agenda"><aside class="b-date"><span>OCTOBER</span><b>${state.day.slice(-2)}</b><p>${dayName(state.day)}요일${state.day===data.today?' · 오늘':''}</p><span class="b-date-count">${onDay(state.day).length}경기</span><div class="b-mini-dates">${days().map(day=>`<button data-day="${day}" aria-pressed="${day===state.day}"><span>${dayName(day)}</span><b>${day.slice(-2)}</b><i>${onDay(day).length}</i></button>`).join('')}</div></aside><section class="b-fixtures">${eventRows()}<div class="next-days">${sectionHead('다음 일정','COMING UP')}${upcoming()}</div></section></div><section class="b-competitions">${sectionHead('대회 일정','TOURNAMENT CALENDAR')}<div class="competitions">${competitions()}</div></section>${footer()}</main>`;
}
function weekBoard() {
  const week=days();
  return `<div class="board-scroll" tabindex="0" role="region" aria-label="주간 일정, 좌우로 스크롤"><div class="week-board"><div class="board-dates">${week.map(day=>`<button data-day="${day}" aria-pressed="${state.day===day}" class="${day===data.today?'is-today':''}"><span>${dayName(day)}요일${day===data.today?'<small>오늘</small>':''}</span><b>${day.slice(-2)}</b><span class="board-count">${onDay(day).length}경기</span></button>`).join('')}</div><div class="board-series"><span class="series-label">대회 기간</span><button class="series-bar" data-tone="green" data-open="league-1" style="grid-column:2 / 8"><b>FC 스트리머 리그</b><span>조별리그 → 결승 ${arrow}</span></button><button class="series-bar" data-tone="violet" data-open="weekend-1" style="grid-column:6 / 8"><b>위켄드 컵</b>${diagonal}</button></div><div class="board-columns">${week.map(day=>`<div class="board-column ${day===state.day?'selected':''}" data-date="${day}">${onDay(day).map(e=>`<button class="board-event" data-tone="${e.tone}" data-open="${e.id}"><div><time>${e.time}</time><small>${kindName(e)}</small></div><h3>${esc(e.title)}</h3><p>${esc(e.stage)}</p><div class="board-event-bottom">${people(e,2)}<span>${e.status==='시간 변경'?'시간 변경':e.status}</span></div></button>`).join('') || '<span class="board-empty">—</span>'}</div>`).join('')}</div></div></div>`;
}
function pitch() {
  return '<svg class="pitch" viewBox="0 0 660 380" fill="none" stroke="currentColor" aria-hidden="true"><path d="M30 30h600v320H30zM330 30v320M30 90h90v200H30m600-200h-90v200h90M30 135h35v110H30m600-110h-35v110h35"/><circle cx="330" cy="190" r="60"/><circle cx="330" cy="190" r="3"/><path d="M120 143a60 60 0 0 1 0 94m420-94a60 60 0 0 0 0 94"/></svg>';
}
function control() {
  return `<main class="control container"><section class="c-heading"><div><span class="eyebrow"><i></i> FC ONLINE / OCTOBER 2026</span><h1>편성표<span>↘</span></h1></div><div class="c-week-number"><span>WEEK 42</span><strong>${state.start.slice(-2)}<i>—</i>${addDays(state.start,6).slice(-2)}</strong></div><div class="c-week-summary"><b>${inWeek().length}<span>경기</span></b>${dateControl()}</div></section><div class="c-toolbar">${filters()}<span class="board-view-label"><i></i> 주간 보기</span></div>${weekBoard()}<div class="c-board-foot"><span><i data-tone="green"></i>대회 <i data-tone="blue"></i>CK <i data-tone="amber"></i>매치</span><span>한국 시간 기준 · 일정을 눌러 상세 보기 ${diagonal}</span></div><div class="c-lower-grid"><section class="c-day-list">${sectionHead(`${shortDate(state.day)} <small>${dayName(state.day)}요일</small>`,`${onDay(state.day).length}경기`)}${eventRows()}</section><aside class="c-spotlight">${pitch()}<div class="c-spotlight-mark">FC<span>26</span></div><div class="c-spotlight-inner"><span class="eyebrow">THIS WEEK'S TOURNAMENT</span><h2>FC 스트리머 리그</h2><p>10.13 — 10.18 · 조별리그부터 결승까지</p><button data-open="league-1">대회 일정 ${arrow}</button></div></aside></div>${footer()}</main>`;
}
function updateBoardSeries() {
  // 대회 기간도 날짜·게임·검색 필터에 맞춰 표시한다.
  if(design!=='c') return;
  const series=$('.board-series');
  const ids=[...new Set(inWeek().filter(e=>e.series).map(e=>e.series))];
  series.innerHTML='<span class="series-label">대회 기간</span>'+ids.map(id=>{
    const events=filtered().filter(e=>e.series===id),e=events[0];
    const start=Math.max(0,days().indexOf(events[0].date));
    const end=days().indexOf(events.at(-1).date);
    const stages=events.length>1?`${e.stage.replace(/ [AB]조$/,'')} → ${events.at(-1).stage}`:e.stage;
    return `<button class="series-bar" data-tone="${e.tone}" data-open="${e.id}" style="grid-column:${start+1} / ${end<0?8:end+2}"><b>${esc(e.title)}</b><span>${esc(stages)} ${diagonal}</span></button>`;
  }).join('');
  if(!ids.length) series.innerHTML='<p class="series-none">등록된 대회가 없습니다.</p>';
  const spotlight=$('.c-spotlight');
  const e=inWeek().find(e=>e.kind==='tournament');
  if(e) {
    spotlight.querySelector('h2').textContent=e.title;
    spotlight.querySelector('p').textContent=e.series ? `${shortDate(filtered().find(x=>x.series===e.series).date)} — ${shortDate(filtered().filter(x=>x.series===e.series).at(-1).date)}` : `${shortDate(e.date)} · ${e.stage}`;
    spotlight.querySelector('button').dataset.open=e.id;
  } else {
    spotlight.querySelector('h2').textContent='다음 대회를 기다리며';
    spotlight.querySelector('p').textContent='이 기간에 등록된 대회가 없습니다.';
    spotlight.querySelector('button').hidden=true;
  }
}
function render() {
  const focus=document.activeElement?.id;
  const cursor=focus==='search' ? $('#search').selectionStart : null;
  const boardScroll=$('.board-scroll')?.scrollLeft ?? 0;
  $('#app').innerHTML=switcher()+header()+(design==='a'?stadium():design==='b'?editorial():control());
  const weekLabel=$('.c-week-number>span');if(weekLabel)weekLabel.textContent=`WEEK ${weekNumber()}`;
  updateBoardSeries();
  if($('.board-scroll'))$('.board-scroll').scrollLeft=boardScroll;
  if(focus==='search') {$('#search').focus({preventScroll:true});if(cursor!==null)$('#search').setSelectionRange(cursor,cursor);}
}
function reset() {Object.assign(state,{day:data.today,start:'2026-10-12',game:'fconline',kind:'',search:''});render();}
let returnFocus=null;
function openDetail(id, trigger) {
  const e=data.events.find(e=>e.id===id); if(!e)return;
  if(!$('#detail').open)returnFocus=trigger;
  const series=e.series?data.events.filter(x=>x.series===e.series):[e];
  $('#detail').innerHTML=`<div class="dialog-top"><span>일정 상세</span><button data-close aria-label="일정 상세 닫기">×</button></div><div class="dialog-content"><div class="dialog-tags">${tag(e)}<span>${gameName(e)}</span>${status(e)}</div><h2 id="detail-title">${esc(e.title)}</h2><p class="dialog-stage">${esc(e.stage)}</p><div class="dialog-when"><div><small>날짜</small><b>${shortDate(e.date)} <span>${dayName(e.date)}요일</span></b></div><div><small>시작 시간</small><b>${e.time}<span> KST</span></b></div></div><div class="dialog-people"><h3>참가 스트리머</h3><div>${e.people.map(name=>`<span>${avatar(name)}<b>${esc(name)}</b></span>`).join('')}</div></div><div class="dialog-schedule"><h3>${e.series?'대회 일정':'경기 일정'}</h3>${series.map(slot=>`<button data-open="${slot.id}" class="${slot.id===e.id?'active':''}"><span>${shortDate(slot.date)}</span><b>${esc(slot.stage)}</b><time>${slot.time}</time>${arrow}</button>`).join('')}</div><p class="dialog-note">디자인 시안용 예시 일정입니다.</p></div>`;
  if(!$('#detail').open) $('#detail').showModal();
  document.body.classList.add('dialog-open');
}
document.addEventListener('click',event=>{
  const button=event.target.closest('button');if(!button)return;
  if(button.hasAttribute('data-open')){openDetail(button.dataset.open,button);return;}
  if(button.hasAttribute('data-close')){$('#detail').close();return;}
  if(button.hasAttribute('data-reset')){reset();return;}
  if(button.hasAttribute('data-day'))state.day=button.dataset.day;
  else if(button.hasAttribute('data-game'))state.game=button.dataset.game;
  else if(button.hasAttribute('data-kind'))state.kind=button.dataset.kind;
  else if(button.hasAttribute('data-week')){state.start=addDays(state.start,Number(button.dataset.week)*7);state.day=state.start;}
  else if(button.hasAttribute('data-today')){state.day=data.today;state.start='2026-10-12';}
  else return;
  const identifier=button.hasAttribute('data-day')?'data-day':button.hasAttribute('data-game')?'data-game':button.hasAttribute('data-kind')?'data-kind':button.hasAttribute('data-week')?'data-week':'data-today';
  const value=button.getAttribute(identifier);
  render();
  document.querySelector(`button[${identifier}="${CSS.escape(value)}"]`)?.focus({preventScroll:true});
});
document.addEventListener('input',event=>{if(event.target.id==='search'){state.search=event.target.value;render();}});
document.addEventListener('change',event=>{
  if(event.target.id!=='date-input'||!event.target.value)return;
  state.day=event.target.value;
  const weekday=dateAt(state.day).getUTCDay();state.start=addDays(state.day,-((weekday+6)%7));render();
});
$('#detail').addEventListener('click',event=>{if(event.target===$('#detail')){$('#detail').close();}});
$('#detail').addEventListener('close',()=>{document.body.classList.remove('dialog-open');if(returnFocus?.isConnected)returnFocus.focus({preventScroll:true});});
render();
