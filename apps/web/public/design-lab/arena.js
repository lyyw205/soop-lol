// Standalone design prototype. All match and career records below are fictional.
const PEOPLE = {
  sangho: { name: '이상호', image: 'lshooooo', position: '서포터' },
  mingyo: { name: '김민교', image: 'phonics1', position: '미드' },
  jeora: { name: '저라뎃', image: 'joey1114', position: '정글' },
  mansik: { name: '강만식', image: 'rkdakstlr911', position: '미드' },
  imani: { name: '임아니', image: '1004suna', position: '원딜' },
};
const PAIRS = [
  ['sangho', 'mingyo', 18, 12], ['jeora', 'mansik', 9, 7],
  ['imani', 'mingyo', 6, 8], ['sangho', 'jeora', 11, 9],
  ['sangho', 'mansik', 8, 6], ['sangho', 'imani', 7, 5],
  ['mingyo', 'jeora', 8, 10], ['mingyo', 'mansik', 12, 9],
  ['jeora', 'imani', 5, 7], ['mansik', 'imani', 6, 4],
];
const params = new URLSearchParams(location.search);
const state = {
  page: ['versus', 'profile', 'directory', 'rank'].includes(params.get('page')) ? params.get('page') : 'versus',
  a: 'sangho', b: 'mingyo', person: 'sangho', relation: 'opponent', year: 'all', showAll: false,
};
const $ = (s) => document.querySelector(s);
const name = (id) => PEOPLE[id].name;
const icon = (type) => {
  const shapes = {
    trophy: '<path d="M8 3h8v5a4 4 0 0 1-8 0V3Zm0 2H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4M12 12v6m-4 3v-3h8v3M6 21h12"/>',
    game: '<path d="M7 7h10a4 4 0 0 1 4 4l1 6a2 2 0 0 1-3 2l-4-3H9l-4 3a2 2 0 0 1-3-2l1-6a4 4 0 0 1 4-4Z"/><path d="M7 10v5m-2.5-2.5h5M16 11h.1M18 14h.1"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  };
  return '<svg viewBox="0 0 24 24" aria-hidden="true">' + shapes[type] + '</svg>';
};
function avatar(id) {
  return `<span class="avatar"><img src="assets/${PEOPLE[id].image}.jpg" alt="${name(id)} 공개 프로필"></span>`;
}
function head() {
  return `<header class="topbar"><div class="header-inner"><button class="brand" data-page="versus" aria-label="SOOP LOL 상대전적"><span class="brandmark">S</span>SOOP<i>LOL</i></button><nav class="nav" aria-label="주요 메뉴">${[['versus','상대전적'],['directory','스트리머'],['rank','리더보드']].map(([id,label]) => `<button data-page="${id}" class="${state.page===id || (id==='directory' && state.page==='profile')?'active':''}">${label}</button>`).join('')}</nav><span class="header-label">${icon('game')} 스트리머 롤 기록실</span></div></header>`;
}
function pageTitle(title, sub) {
  return `<div class="page-title"><div><h1>${title}</h1><p>${sub}</p></div><span class="sample-tag">샘플 데이터</span></div>`;
}
function fullRecord(a,b) {
  const row = PAIRS.find(([x,y]) => (a===x && b===y) || (a===y && b===x));
  return row[0]===a ? row.slice(2) : [row[3],row[2]];
}
function games(a,b,relation='opponent',year='all') {
  const canonical=PAIRS.find(([x,y]) => (a===x && b===y) || (a===y && b===x));
  const [wins,losses] = relation==='ally' ? [14,6] : canonical.slice(2);
  // Generate deterministic sample matches; filters and the headline share these rows.
  const total = wins+losses;
  return Array.from({length:total},(_,i) => {
    const canonicalWin = Math.floor((i+1)*wins/total)>Math.floor(i*wins/total);
    const win = relation==='ally' || canonical[0]===a ? canonicalWin : !canonicalWin;
    const playedYear = i<Math.ceil(total*.65) ? 2026 : 2025;
    const month = 9-Math.floor(i/5)%5;
    const day = 18-i%5*3;
    return {
      id:i, win, lane:i%3===0, year:playedYear,
      date:`${playedYear}.${String(month).padStart(2,'0')}.${String(day).padStart(2,'0')}`,
      event:i%3===0?'멸망전 · 예시 대회':'스트리머 내전',
      stage:i%3===0?'본선 · 3판 2선승':'내전 · 3판 2선승',
      champion:['Talon','Sylas','LeeSin','Ahri','Thresh','Orianna'][i%6],
      loserSets:i%2,
    };
  }).filter(x => (year==='all' || x.year===Number(year)) && (relation!=='lane' || x.lane))
    .sort((x,y)=>y.date.localeCompare(x.date));
}
function summary(rows) {
  const w=rows.filter(g=>g.win).length;
  return {w,l:rows.length-w,n:rows.length,pct:rows.length?Math.round(w/rows.length*100):0};
}
function participant(id, note='', clickable=true) {
  return `<div class="contestant"><span class="portrait-disc">${avatar(id)}</span>${clickable?`<button class="contestant-name" data-profile="${id}">${name(id)}</button>`:`<span class="contestant-name">${name(id)}</span>`}${note?`<span class="contestant-note">${note}</span>`:''}</div>`;
}
function heroCard(rows) {
  const {w,l,n,pct}=summary(rows), ally=state.relation==='ally';
  const period=state.year==='all'?'전체 기간':`${state.year}년`;
  const title=ally?'같은 팀 전적':state.relation==='lane'?'맞라인 전적':'상대전적';
  return `<section class="fixture fixture-large" aria-label="${title} 요약"><div class="fixture-top">${title}<span class="dot">·</span><small>${period}</small><button class="card-menu" data-explain aria-label="집계 기준 보기" aria-expanded="false" aria-controls="count-note">ⓘ</button></div><div class="duel">${participant(state.a,ally?'함께 플레이':`승률 ${pct}%`)}<span class="duel-separator" aria-hidden="true"></span>${participant(state.b,ally?'함께 플레이':`승률 ${100-pct}%`)}</div><div class="score-area"><div class="score-unit">${ally?'공동 전적':`${n}번의 맞대결`}</div><div class="score" aria-label="${ally?`${w}승 ${l}패`:`${name(state.a)} ${w}승, ${name(state.b)} ${l}승`}">${w}<span class="dash">–</span>${l}</div><p class="score-caption">${ally?`${n}경기 · ${w}승 ${l}패 · 승률 ${pct}%`:'경기 승수 기준 · 세트 전적은 아래에서 확인'}</p></div><div class="fixture-bottom"><button data-records>${icon('list')} 경기별 기록 보기 <span aria-hidden="true">↓</span></button></div></section><p class="message" id="count-note" hidden>한 경기는 3판 2선승으로 구성한 가상 샘플입니다. 경기 승수와 세트 승수를 구분합니다. 같은 팀은 두 사람의 공동 승패입니다.</p><div class="score-meta"><span>${ally?'함께한 경기':state.relation==='lane'?'같은 포지션에서 만난 경기':'서로 다른 팀에서 만난 경기'}</span><strong>${n}경기${n<10?' · 적은 표본':''}</strong></div>`;
}
function pairCard(a,b,color,label='상대전적') {
  const [w,l]=fullRecord(a,b);
  return `<button class="fixture fixture-small ${color}" data-pair="${a},${b}" aria-label="${name(a)} 대 ${name(b)} 상대전적 ${w} 대 ${l} 보기"><span class="fixture-top">${label} · ${w+l}경기</span><span class="duel">${participant(a,'',false)}<span class="duel-separator" aria-hidden="true"></span>${participant(b,'',false)}</span><span class="score-area" style="display:block"><span class="mini-score">${w}<span class="dash">–</span>${l}</span></span><span class="fixture-bottom">전적 확인하기 <span aria-hidden="true">　›</span></span></button>`;
}
function alternatives(person) {
  const total=(a,b)=>fullRecord(a,b).reduce((sum,n)=>sum+n,0);
  const pairs = person ? Object.keys(PEOPLE).filter(id=>id!==person).sort((a,b)=>total(person,b)-total(person,a)).slice(0,3).map(id=>[person,id]) : [['jeora','mansik'],['imani','mingyo'],['sangho','jeora']];
  return `<div class="compact-pairs">${pairs.map(([a,b],i)=>pairCard(a,b,['blue','green','plum'][i])).join('')}</div>`;
}
function careerItem(i, detailed=false) {
  return `<div class="career-small"><span class="medal ${i===1?'silver':''}">${icon('trophy')}</span><div><b>${i===1?'준우승':'우승'} · 멸망전 ${i===1?'시즌 2':'시즌 1'}</b><small>${i===0?'2026': '2025'} · 시안용 대회 기록</small></div>${detailed?`<time>${['2026.06','2025.10','2025.05'][i]}</time>`:''}</div>`;
}
function rail(person=state.a) {
  return `<aside class="rail"><section class="panel"><div class="panel-body"><h2 class="panel-heading">스트리머 정보 <small>프로필</small></h2><div class="profile-mini">${avatar(person)}<div><button data-profile="${person}">${name(person)}</button><small>SOOP · ${PEOPLE[person].position}</small></div></div><div class="mini-stats"><div><b class="gold">3</b><small>우승</small></div><div><b>2</b><small>준우승</small></div><div><b>12</b><small>참가 대회</small></div></div></div><button class="panel-footer" data-profile="${person}">프로필 · 수상 경력 보기　›</button></section><section class="panel"><div class="panel-body"><h2 class="panel-heading">최근 수상 경력 <small>샘플</small></h2>${careerItem(0)}${careerItem(1)}</div></section><section class="panel champ-panel"><div class="panel-body"><h2 class="panel-heading">챔피언 기록 <small>이미지 예시</small></h2><div class="champions">${['Talon','LeeSin','Thresh','Sylas'].map((c,i)=>`<img src="assets/${c}.png" alt="${['탈론','리 신','쓰레쉬','사일러스'][i]}">`).join('')}</div><p class="champion-note">경기별 챔피언 이미지를 사용하는 예시입니다.</p></div></section><p class="rail-note">이 페이지의 경기·커리어는 디자인 검토용 가상 데이터입니다. 실제 스트리머 기록과 다릅니다.</p></aside>`;
}
function picker() {
  const opts=selected=>Object.keys(PEOPLE).map(id=>`<option value="${id}" ${id===selected?'selected':''}>${name(id)}</option>`).join('');
  return `<form class="picker"><div class="pick"><label for="left">스트리머</label><select id="left">${opts(state.a)}</select></div><button class="swap" type="button" aria-label="두 스트리머 순서 바꾸기">⇄</button><div class="pick"><label for="right">상대 스트리머</label><select id="right">${opts(state.b)}</select></div><button class="primary" type="submit">전적 보기</button></form><div class="filters"><div class="tabs" aria-label="관계 필터">${[['opponent','상대 팀'],['ally','같은 팀'],['lane','맞라인']].map(([id,label])=>`<button data-relation="${id}" aria-pressed="${state.relation===id}" class="${state.relation===id?'active':''}">${label}</button>`).join('')}</div><select class="year" aria-label="기간">${[['all','전체 기간'],['2026','2026년'],['2025','2025년'],['2024','2024년']].map(([id,label])=>`<option value="${id}" ${state.year===id?'selected':''}>${label}</option>`).join('')}</select></div>`;
}
function matchList(rows) {
  const shown = state.showAll ? rows : rows.slice(0,4);
  const ally = state.relation==='ally';
  return `<div class="sectionhead" id="records"><h2>경기 기록</h2><small>${rows.length}경기 · 최신순</small></div><div class="match-list">${shown.map(g=>{
    const winner=ally?'같은 팀':name(g.win?state.a:state.b);
    const result=ally?(g.win?'함께 승리':'함께 패배'):winner;
    const sets=g.loserSets?[true,false,true]:[true,true];
    return `<details class="match-row"><summary><span class="match-date">${g.date.slice(5)}<small>${g.year}</small></span><span class="match-event"><img class="champ" src="assets/${g.champion}.png" alt="예시 경기의 챔피언"><span><b>${g.event}</b><small>${g.stage}</small></span></span><span class="match-result"><span class="winner">${result}</span><b>${ally&&!g.win?`${g.loserSets} : 2`:`2 : ${g.loserSets}`}</b></span><span class="expand" aria-hidden="true">⌄</span></summary><div class="match-detail">${sets.map((won,j)=>`<div class="set-line"><span>${j+1}세트</span><span>${ally?(won===g.win?'공동 승리':'공동 패배'):(won?winner:name(g.win?state.b:state.a))+' 승'}</span><span>기록 예시</span></div>`).join('')}<p>가상 경기입니다. 실제 서비스에서는 라인업과 기록 출처가 연결됩니다.</p></div></details>`;
  }).join('')}</div>${rows.length>4?`<button class="all-records" data-more aria-expanded="${state.showAll}">${state.showAll?'최근 4경기만 보기':`경기 ${rows.length}개 모두 보기`}　${state.showAll?'−':'+'}</button>`:''}`;
}
function versus() {
  const rows=games(state.a,state.b,state.relation,state.year);
  return `${pageTitle('상대전적','내전부터 멸망전까지, 두 스트리머의 경기 기록을 모았습니다.')}<div class="workspace"><div class="maincol">${picker()}${rows.length?heroCard(rows):'<div class="empty">이 기간에 기록된 경기가 없습니다.<br>다른 기간을 선택해 보세요.</div>'}<div class="sectionhead"><h2>다른 매치업</h2><small>카드를 누르면 상대전적으로 이동합니다</small></div>${alternatives()}${rows.length?matchList(rows):''}</div>${rail()}</div>`;
}
function profilePage() {
  const id=state.person;
  return `${pageTitle('스트리머 프로필','상대전적과 대회에서 남긴 기록을 함께 확인하세요.')}<div class="workspace"><div class="maincol"><section class="profile-hero">${avatar(id)}<div><h1>${name(id)}</h1><p>SOOP 스트리머 · ${PEOPLE[id].position}</p></div><button class="primary" data-compare="${id}">상대전적 비교</button></section><div class="profile-totals"><div><small>통산 우승</small><strong class="stat-value">3<small> 회</small></strong></div><div><small>통산 준우승</small><strong class="stat-value">2<small> 회</small></strong></div><div><small>참가 대회</small><strong class="stat-value">12<small> 회</small></strong></div></div><nav class="profile-tabs" aria-label="프로필 섹션"><a href="#opponents">상대전적</a><a href="#career">수상 경력</a></nav><div class="sectionhead" id="opponents"><h2>자주 만난 상대</h2><small>전체 기간 · 경기 승수</small></div>${alternatives(id)}<div class="sectionhead" id="career"><h2>수상 경력</h2><small>최신순 · 샘플</small></div><div class="career-list">${[0,1,2].map(i=>careerItem(i,true)).join('')}</div><p class="message">프로필 수치는 레이아웃 검토를 위한 가상 예시입니다.</p></div>${rail(id)}</div>`;
}
function directory() {
  return `${pageTitle('스트리머','이름을 선택하면 상대전적과 커리어로 이어집니다.')}<label class="sr-only" for="streamer-search">스트리머 이름 검색</label><input class="search" id="streamer-search" type="search" placeholder="스트리머 이름 검색" autocomplete="off"><div class="directory-grid">${Object.keys(PEOPLE).map(id=>`<button class="directory-person" data-profile="${id}" data-name="${name(id)}">${avatar(id)}<span><b>${name(id)}</b><small>SOOP · ${PEOPLE[id].position}　›</small></span></button>`).join('')}</div><p class="empty" id="search-empty" hidden>검색한 스트리머가 없습니다.</p>`;
}
function rankPage() {
  return `${pageTitle('리더보드','기능 모듈이 같은 탐색 구조 안에 들어오는 예시입니다.')}<div class="panel">${['jeora','mansik','mingyo','sangho','imani'].map((id,i)=>`<div class="rank-row"><span>${i+1}</span>${avatar(id)}<button data-profile="${id}">${name(id)}</button><strong>${[1250,980,650,410,230][i]} LP</strong></div>`).join('')}</div><p class="message">솔로랭크 수치는 모두 가상 샘플입니다.</p>`;
}
function render() {
  $('#app').innerHTML = head()+`<main class="shell">${state.page==='profile'?profilePage():state.page==='directory'?directory():state.page==='rank'?rankPage():versus()}<footer class="foot"><span>SOOP LOL · 스트리머 롤 기록실<br>디자인 검토용 · 모든 전적·수상 내역은 가상 데이터입니다.</span><span>Riot Games가 보증하는 서비스가 아닙니다.<br>게임 이미지: Riot Games · 인물 이미지: SOOP 공개 프로필</span></footer></main>`;
  bind();
}
function go(page) {state.page=page;state.showAll=false;render();window.scrollTo(0,0);}
function bind() {
  document.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>go(b.dataset.page));
  document.querySelectorAll('[data-profile]').forEach(b=>b.onclick=()=>{state.person=b.dataset.profile;go('profile');});
  document.querySelectorAll('[data-compare]').forEach(b=>b.onclick=()=>{state.a=b.dataset.compare;state.b=Object.keys(PEOPLE).find(id=>id!==state.a);state.relation='opponent';state.year='all';go('versus');});
  document.querySelectorAll('[data-pair]').forEach(b=>b.onclick=()=>{[state.a,state.b]=b.dataset.pair.split(',');state.relation='opponent';state.year='all';go('versus');});
  document.querySelectorAll('[data-relation]').forEach(b=>b.onclick=()=>{state.relation=b.dataset.relation;state.showAll=false;render();});
  if($('.picker')) {
    $('.picker').onsubmit=e=>{e.preventDefault();const a=$('#left'),b=$('#right');b.setCustomValidity('');if(a.value===b.value){b.setCustomValidity('서로 다른 스트리머를 선택해 주세요.');b.reportValidity();return;}state.a=a.value;state.b=b.value;state.showAll=false;render();};
    $('#left').onchange=$('#right').onchange=()=>$('#right').setCustomValidity('');
    $('.swap').onclick=()=>{[state.a,state.b]=[state.b,state.a];render();};
    $('.year').onchange=e=>{state.year=e.target.value;state.showAll=false;render();};
  }
  if($('[data-explain]')) $('[data-explain]').onclick=e=>{const note=$('#count-note');note.hidden=!note.hidden;e.currentTarget.setAttribute('aria-expanded',String(!note.hidden));};
  if($('[data-records]')) $('[data-records]').onclick=()=>$('#records').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
  if($('[data-more]')) $('[data-more]').onclick=()=>{const y=window.scrollY;state.showAll=!state.showAll;render();window.scrollTo(0,y);};
  if($('#streamer-search')) $('#streamer-search').oninput=e=>{const q=e.target.value.trim();let n=0;document.querySelectorAll('[data-name]').forEach(b=>{b.hidden=!b.dataset.name.includes(q);if(!b.hidden)n++;});$('#search-empty').hidden=n>0;};
}
render();
