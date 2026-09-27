import { actualProfile } from './profile-card-data.js';

const sampleProfile = {
  name: '샘플 스트리머', slug: null, aliases: ['수상·챔피언 기록이 풍부한 가상 예시'], avatar: null,
  channels: [{name:'SOOP', id:'sample_channel', url:null}, {name:'YouTube',id:'샘플 채널',url:null}],
  champions: [{name:'리 신',games:42,image:'assets/LeeSin.png'}, {name:'탈론',games:31,image:'assets/Talon.png'}, {name:'오리아나',games:24,image:'assets/Orianna.png'}],
  awards: [{placement:'우승',title:'2026 스트리머 컵',year:2026}, {placement:'준우승',title:'2025 시즌 파이널',year:2025}],
  accounts:[{name:'SamplePlayer',tag:'KR1',tier:'다이아몬드'}, {name:'SampleSecond',tag:'KR2',tier:'에메랄드'}, {name:'SamplePractice',tag:'KR3',tier:'언랭'}], games:128,wins:76,draws:4,losses:48,sets:284,setWins:163,
};
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let variant = location.hash === '#b' ? 'b' : 'a';
const activeModel = () => document.querySelector('#dataset').value==='sample' ? sampleProfile : actualProfile;
function recordLink(profile,tab,label,className='') {
  return profile.slug ? `<a class="${className}" href="/s/${encodeURIComponent(profile.slug)}?tab=${tab}">${label}</a>` : `<span class="${className}">${label}</span>`;
}
function portrait(profile) {
  const channel=profile.channels.find(c=>c.name==='SOOP');
  const url=profile.avatar ?? (profile.slug && channel ? `https://stimg.sooplive.co.kr/LOGO/${channel.id.slice(0,2)}/${channel.id}/${channel.id}.jpg` : null);
  return `<div class="portrait"><div class="portrait-frame"><span>${profile.slug ? escape(profile.name.slice(-2)) : 'S'}</span>${url ? `<img src="${escape(url)}" alt="${escape(profile.name)} 프로필" referrerpolicy="no-referrer">` : ''}</div></div>`;
}
function identity(profile) {
  return `<header class="identity"><p class="record-scope">개인 기록 <span>전체 기간 · 전체 경기</span></p><div class="name-line"><h2>${escape(profile.name)}</h2></div></header>`;
}
function stats(profile) {
  const rate=profile.wins+profile.losses ? (profile.wins/(profile.wins+profile.losses)*100).toFixed(1) : '—';
  return `<section class="stats" aria-label="전적 요약"><div><small>경기</small><strong>${profile.games}<span>경기</span></strong><p>${profile.sets}세트</p></div><div><small>승 · 무 · 패</small><strong class="wdl">${profile.wins}<i>/</i>${profile.draws}<i>/</i>${profile.losses}</strong><p>세트 ${profile.setWins}승 ${profile.sets-profile.setWins}패</p></div><div><small>경기 승률</small><strong>${rate}<span>${rate==='—'?'':'%'}</span></strong><p>무승부 제외</p></div></section>`;
}
function channels(profile) {
  return `<section class="channels info-section"><h3>방송 채널</h3><div class="channel-list">${profile.channels.map(c=>{
    const inner=`<span class="channel-mark ${c.name==='YouTube'?'youtube':''}">${c.name==='YouTube'?'▶':'S'}</span><b>${escape(c.name)}</b><span class="arrow">↗</span>`;
    return c.url && /^https:\/\//.test(c.url) ? `<a href="${escape(c.url)}" target="_blank" rel="noopener noreferrer">${inner}</a>` : `<span class="sample-channel">${inner}</span>`;
  }).join('')}</div>${accounts(profile)}</section>`;
}
function accounts(profile) {
  return `<div class="accounts"><h3>게임 계정</h3><ul class="account-list">${profile.accounts.map(account=>`<li><span class="account-name" title="${escape(account.name)}#${escape(account.tag)}">${escape(account.name)}<span>#${escape(account.tag)}</span></span><span class="tier">${escape(account.tier)}</span></li>`).join('')}</ul></div>`;
}
function champions(profile) {
  return `<section class="champions info-section"><h3>모스트 챔피언 <span>통산</span></h3><div class="champion-list">${profile.champions.map((c,i)=>recordLink(profile,'champions',`<span class="champion-image"><img src="${escape(c.image)}" alt=""><b>${i+1}</b></span><span><strong>${escape(c.name)}</strong><small>${c.games}판</small></span>`,'champion')).join('')}</div></section>`;
}
function awards(profile) {
  return `<section class="awards info-section"><h3>수상 경력 <span>통산</span></h3>${profile.awards.length ? `<div class="award-list">${profile.awards.map(a=>recordLink(profile,'events',`<span class="award-rank" data-place="${escape(a.placement)}">${escape(a.placement)}</span><span><strong>${escape(a.title)}</strong><small>${a.year} 시즌</small></span>`,'award')).join('')}</div>` : `<p class="empty-awards">등록된 수상 경력이 없습니다.</p>${recordLink(profile,'events','대회 참여 기록 보기 →','subtle-link')}`}</section>`;
}
function render() {
  const profile=activeModel();
  document.querySelector('#preview').innerHTML=`<article class="profile-card variant-${variant}" aria-label="${variant.toUpperCase()}안 프로필 카드">${portrait(profile)}${identity(profile)}${stats(profile)}${channels(profile)}${champions(profile)}${awards(profile)}<footer class="card-footer"><span>${profile.slug?'통합 프로필 · 전적과 커리어를 한곳에서':'가상 인물·가상 기록을 사용한 레이아웃 예시'}</span>${recordLink(profile,'games','매치 히스토리 보기 <span>↓</span>')}</footer></article>`;
  for(const image of document.querySelectorAll('#preview img')) image.addEventListener('error',()=>image.hidden=true);
  for(const button of document.querySelectorAll('[data-variant]')) button.setAttribute('aria-pressed',String(button.dataset.variant===variant));
  document.querySelector('#variant-description').textContent=variant==='a'?'A / 프로필 이미지를 크게, 정보는 오른쪽으로 차곡차곡.':'B / 프로필을 작게 묶고 전적을 같은 줄에 배치해 높이를 줄였습니다.';
  document.querySelector('#data-note').textContent=profile.slug?'실제 공개 기록 · 2026.09.22 기준':'가상 예시 데이터 · 실제 스트리머 전적이 아닙니다';
  document.querySelector('#data-note').classList.toggle('sample-note',!profile.slug);
}
for(const button of document.querySelectorAll('[data-variant]')) button.addEventListener('click',()=>{variant=button.dataset.variant;history.replaceState(null,'',`#${variant}`);render();});
document.querySelector('#dataset').addEventListener('change',render);
render();
