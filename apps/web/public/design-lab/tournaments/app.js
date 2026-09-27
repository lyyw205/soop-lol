import { data } from "./data.js";
import {
  featuredSlug,
  sources,
  ratings,
  standings,
  palette,
  avatars,
  categories,
} from "./meta.js";
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name, cls = "") =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    {
      trophy:
        '<path d="M8 3h8v6a4 4 0 0 1-8 0zM8 5H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4M12 13v5m-4 3h8m-9 0v-3h10v3"/>',
      arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
      search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
      calendar:
        '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4m10-4v4M3 11h18m-13 4h2m4 0h2"/>',
      users:
        '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/>',
      pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 0 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
      play: '<path d="m9 5 11 7-11 7z"/>',
      external: '<path d="M14 3h7v7m0-7L10 14M10 3H4v17h17v-6"/>',
      chevron: '<path d="m9 5 7 7-7 7"/>',
      close: '<path d="m6 6 12 12M6 18 18 6"/>',
      grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
      spark: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/>',
      check: '<path d="m5 12 4 4L19 6"/>',
      branch: '<path d="M3 4h6v6H3zm0 10h6v6H3zm6-7h5v10H9m5-5h7"/>',
    }[name] || ""
  }</svg>`;
let state;
function getState() {
  const p = new URLSearchParams(location.search);
  return {
    variant: p.get("variant") === "b" ? "b" : "a",
    event: p.get("event") || "",
    tab: p.get("tab") || "overview",
    category: p.get("category") || "all",
    year: p.get("year") || "2026",
    query: p.get("q") || "",
    status: p.get("status") || "all",
    stage: "all",
    team: "all",
  };
}
function href(patch = {}) {
  const s = { ...state, ...patch };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({
    variant: s.variant,
    event: s.event,
    tab: s.event ? s.tab : "",
    category: s.category,
    year: s.year,
    q: s.query,
    status: s.status,
  })) {
    if (v && (v !== "all" || k === "year") && v !== "overview") p.set(k, v);
  }
  return `?${p}`;
}
const link = (label, patch, cls = "") =>
  `<a class="${cls}" href="${esc(href(patch))}">${label}</a>`;
const external = (label, url, cls = "") =>
  `<a class="${cls}" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}${icon("external")}</a>`;
const person = (slug) => data.people[slug]?.name || slug;
const shortName = (slug) => person(slug).replace(/[♥._!#]/g, "");
const date = (value) => (value ? value.replaceAll("-", ".") : "일정 확인 중");
const period = (e) =>
  `${date(e.start)}${e.end && e.end !== e.start ? ` — ${e.end.slice(5).replace("-", ".")}` : ""}`;
const totalSets = (e) => e.series.reduce((s, g) => s + g.sets.length, 0);
const isFeatured = (e) => e.slug === featuredSlug;
const eventStatus = (e) =>
  !e.start
    ? "일정 미정"
    : e.start > data.asOf
      ? "예정"
      : e.end && e.end >= data.asOf
        ? "진행 중"
        : "종료";
const avatar = (slug, size = "") =>
  `<span class="avatar ${size}">${avatars[slug] ? `<img src="${avatars[slug]}" alt="" loading="lazy">` : esc(shortName(slug).slice(0, 2))}</span>`;
function teamColor(name) {
  return palette[
    Math.max(
      0,
      ratings.findIndex((t) => t[0] === name),
    ) % palette.length
  ];
}
const badge = (name) =>
  `<span class="team-badge" style="--team:${teamColor(name)}">${esc(name.replaceAll("TEAM ", "").slice(0, 1))}</span>`;
const heading = (title, sub = "", action = "") =>
  `<div class="section-heading"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ""}</div>${action}</div>`;
function header() {
  return `<div class="review-bar"><span><b>DESIGN LAB</b><span class="review-description">대회 페이지 · 데이터 스냅샷 시안</span></span><div class="variant-switch">${link("A · SPECTACLE", { variant: "a" }, state.variant === "a" ? "selected" : "")}${link("B · ARCHIVE", { variant: "b" }, state.variant === "b" ? "selected" : "")}</div></div>
<header class="site-header"><div class="header-inner"><a class="brand" href="/"><i>S</i>SOOP<span>LOL</span></a><details class="game-select"><summary>LOL <span>⌄</span></summary><div><a href="/">LOL</a><a href="/fc">FC 온라인</a></div></details><nav aria-label="주요 메뉴"><a href="/">전적 검색</a><a href="/streamers">스트리머</a>${link("대회", { event: "", tab: "overview" }, "active")}</nav><span class="header-note">LEAGUE OF LEGENDS · 스트리머 기록실</span></div></header>`;
}
function footer() {
  return `<footer class="footer"><span class="brand small"><i>S</i>SOOP<span>LOL</span></span><p>함께한 경기, 쌓여가는 이야기.</p><span>디자인 시안 · 2026.09.25 데이터 스냅샷<br>경기 기록: 기존 수집 자료 · 대회 정보: ${external("나무위키 미러", sources.mirror)}<br>우승 사진 © SOOP · ${external("자료 제공 기사", sources.news)}</span></footer>`;
}
function mainHero(e, detail = false) {
  if (state.variant === "b")
    return `<section class="quiet-hero"><div class="quiet-copy"><div class="eyebrow">${detail ? "TOURNAMENT ARCHIVE" : "FEATURED TOURNAMENT"} <span class="chip">종료</span></div><h${detail ? "1" : "2"}>2026 LoL 멸망전 <span>with Gen.G</span></h${detail ? "1" : "2"}><p>${icon("calendar")}${period(e)} <span>·</span> SOOP</p><div class="quiet-tags"><span>8팀 · 40명</span><span>더블 엘리미네이션</span><span>총상금 3,100만 원</span></div>${detail ? "" : link("대회 기록 보기 " + icon("arrow"), { event: e.slug }, "primary")}</div><div class="quiet-final"><span class="eyebrow">GRAND FINAL · 08.01</span><div class="quiet-score"><div>${avatar("kimmingyo")}<b>교권보호국</b></div><strong>2 <em>:</em> 1</strong><div>${avatar("leesangho")}<b>고점폭발</b></div></div><p>${icon("trophy")} 교권보호국 우승 <span>·</span> FINAL MVP 김레인</p></div></section>`;
  return `<section class="hero ${detail ? "hero-detail" : ""}"><div class="hero-photo" role="img" aria-label="2026 멸망전 우승 트로피를 함께 들어 올리는 교권보호국"></div><div class="hero-lines" aria-hidden="true"></div><div class="hero-copy"><div class="eyebrow"><span class="season-mark">26</span> SOOP × Gen.G <span class="chip">대회 종료</span></div><p class="hero-kicker">하나의 트로피. 끝까지 남은 이름.</p><h${detail ? "1" : "2"}><span>2026 LoL</span><br>멸망전<span class="hero-with">with Gen.G</span></h${detail ? "1" : "2"}><p class="hero-date">JUL 19 <span>—</span> AUG 01 <span class="hero-year">2026</span></p><div class="hero-actions">${link((detail ? "결승 경기 보기" : "대회 기록 속으로") + icon("arrow"), { event: e.slug, tab: detail ? "matches" : "overview" }, "primary")}${external(icon("play") + "공식 다시보기", sources.vod, "hero-vod")}</div></div><div class="champion-stamp"><span>2026 CHAMPIONS</span><strong>${icon("trophy")}교권보호국</strong><small>패자조를 넘어, 마침내 정상으로.</small></div><div class="hero-bottom"><span>THE RECORDS LIVE ON.</span><span>KINTEX · HOUSE OF GEN.G</span></div></section><div class="stat-strip"><div><span>참가 팀</span><strong>08<small> TEAMS</small></strong></div><div><span>본선 경기</span><strong>14<small> MATCHES</small></strong></div><div><span>기록된 세트</span><strong>36<small> SETS</small></strong></div><div><span>총상금</span><strong>3,100<small> 만 원</small></strong></div></div>`;
}
function listing() {
  const f = data.events.find((e) => isFeatured(e));
  return `<main id="main" class="shell"><div class="page-title"><div><p class="eyebrow">TOURNAMENTS & EVENTS</p><h1>대회<span class="title-dot">.</span></h1><p>멸망전부터 이벤트 매치까지, 함께 만든 승부의 기록.</p></div><span class="archive-count">2014 — 2026 <b>${data.events.length}</b>개의 기록</span></div>${mainHero(f)}<section class="catalog"><div class="section-heading"><h2>모든 대회와 이벤트 <span class="subtle" id="result-count"></span></h2><label class="select-label">연도<select id="year" aria-label="대회 연도"><option value="all">전체 연도</option>${[
    ...new Set(data.events.map((e) => e.start?.slice(0, 4)).filter(Boolean)),
  ]
    .sort()
    .reverse()
    .map((y) => `<option ${state.year === y ? "selected" : ""}>${y}</option>`)
    .join(
      "",
    )}</select></label></div><div class="catalog-toolbar"><div class="category-tabs" aria-label="대회 종류">${Object.entries(
    categories,
  )
    .map(
      ([key, label]) =>
        `<button data-category="${key}" aria-pressed="${state.category === key}">${label}</button>`,
    )
    .join(
      "",
    )}</div><label class="search">${icon("search")}<input id="search" type="search" placeholder="대회, 팀, 스트리머 검색" aria-label="대회, 팀, 스트리머 검색" value="${esc(state.query)}"></label></div><div class="catalog-meta"><p>오래 기억할 승부를 찾아보세요.</p><label class="select-label">진행 상태<select id="status" aria-label="진행 상태">${[
    ["all", "전체 상태"],
    ["종료", "종료"],
    ["진행 중", "진행 중"],
    ["예정", "예정"],
  ]
    .map(
      ([v, l]) =>
        `<option value="${v}" ${state.status === v ? "selected" : ""}>${l}</option>`,
    )
    .join(
      "",
    )}</select></label></div><div id="event-results" aria-live="polite"></div></section><div class="archive-banner"><div>${icon("trophy")}<span>그때의 팀, 그날의 승부.<small>2014년부터 이어진 멸망전의 역사를 만나보세요.</small></span></div><button id="all-years">역대 대회 전체 보기 ${icon("arrow")}</button></div></main>`;
}
function eventCard(e) {
  const winner = Object.entries(e.placements).find(
    ([, p]) => p === "우승",
  )?.[0];
  const main = isFeatured(e);
  const title = e.name.replace("2026 LoL ", "").replace(/ 2026-\d\d-\d\d/, "");
  return `<a class="event-card ${main ? "featured-card" : ""}" href="${esc(href({ event: e.slug, tab: "overview" }))}"><div class="card-art ${e.category}" style="--card-art:url('${main ? "assets/champions.jpg" : e.category === "event" ? "/images/arena/LeeSin.jpg" : e.category === "invitational" ? "/images/arena/Thresh.jpg" : "/images/arena/Ahri.jpg"}')"><span class="chip">${categories[e.category]}</span><span class="card-art-letter" aria-hidden="true">${main ? "Gen.G" : e.category === "event" ? "EVENT" : e.category === "invitational" ? "VIPER" : e.start?.slice(0, 4)}</span><span class="card-status">${eventStatus(e)}</span></div><div class="event-card-body"><div class="card-category">${categories[e.category]} <span>${e.kind === "ck" ? "CK" : esc(e.organizer || "대회 기록")}</span></div><h3>${esc(title)}</h3><p class="card-date">${period(e)}</p><div class="card-detail"><span>${icon("users")}${Object.keys(e.teams).length}팀 기록</span><span>${totalSets(e)}세트</span>${main ? "<span>3,100만 원</span>" : ""}</div><div class="card-bottom"><span>${winner ? `${icon("trophy")} ${esc(winner)}` : e.kind === "ck" ? "함께한 스트리머와 경기 결과" : "참가 팀과 경기 기록"}</span>${icon("arrow")}</div></div></a>`;
}
function renderResults() {
  const q = state.query.toLocaleLowerCase().trim();
  const events = data.events.filter(
    (e) =>
      (state.year === "all" || e.start?.startsWith(state.year)) &&
      (state.category === "all" || e.category === state.category) &&
      (state.status === "all" || eventStatus(e) === state.status) &&
      (!q ||
        [
          e.name,
          ...Object.keys(e.teams),
          ...Object.values(e.teams).flat().map(person),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(q)),
  );
  $("#result-count").textContent = `${events.length}`;
  $("#event-results").innerHTML = events.length
    ? `<div class="event-grid">${events.map(eventCard).join("")}</div>`
    : `<div class="empty">${icon("search")}<h3>조건에 맞는 대회가 없어요</h3><p>다른 이름으로 검색하거나 연도와 분류를 바꿔보세요.</p><button class="secondary" id="reset">필터 초기화</button></div>`;
  if ($("#reset"))
    $("#reset").onclick = () =>
      navigate({ year: "all", category: "all", query: "", status: "all" });
}
const detailTabs = [
  ["overview", "개요"],
  ["matches", "일정·결과"],
  ["bracket", "대진표"],
  ["teams", "참가 팀"],
  ["records", "기록실"],
  ["info", "대회 안내"],
];
function detail(e) {
  return `<main id="main" class="shell detail-shell"><div class="breadcrumb">${link("대회", { event: "" })}${icon("chevron")}<span>${esc(e.name)}</span></div>${isFeatured(e) ? mainHero(e, true) : `<section class="generic-hero"><span class="eyebrow">${categories[e.category]} <span class="chip">${eventStatus(e)}</span></span><h1>${esc(e.name)}</h1><p>${period(e)} · ${esc(e.organizer || "주최 미확인")}</p></section>`}<nav class="detail-tabs" aria-label="대회 상세 메뉴">${detailTabs
    .filter(([key]) => isFeatured(e) || !["bracket", "records"].includes(key))
    .map(([key, label]) =>
      link(
        label +
          (key === "teams"
            ? ` <small>${Object.keys(e.teams).length}</small>`
            : ""),
        { tab: key },
        state.tab === key ? "active" : "",
      ),
    )
    .join(
      "",
    )}</nav><div class="detail-content">${{ overview: () => overview(e), matches: () => matches(e), bracket: () => bracket(e), teams: () => teams(e), records: () => records(e), info: () => info(e) }[state.tab]?.() || overview(e)}</div></main>`;
}
function overview(e) {
  if (!isFeatured(e))
    return `<div class="content-columns"><div>${heading("경기 기록", "확인된 경기와 세트만 표시합니다.")}${matchList(e, e.series)}</div><aside>${overviewInfo(e)}${sourcesPanel(e)}</aside></div>`;
  return `<div class="content-columns"><div>${heading("마지막 승부", "2026.08.01 · 킨텍스 제1전시장", link("전체 경기 " + icon("arrow"), { tab: "matches" }, "text-link"))}${finalCard(e)}<div class="champion-roster"><span>${icon("trophy")} CHAMPIONS</span><div>${e.teams["교권보호국"].map((p, i) => `<a href="/s/${esc(p)}">${avatar(p)}<strong>${esc(shortName(p))}</strong><small>${["TOP", "JGL", "MID", "BOT", "SUP"][i]}</small></a>`).join("")}</div></div><div class="section-space">${heading("우승까지의 여정", "교권보호국 · 패자조에서 결승까지", link("대진표 보기 " + icon("arrow"), { tab: "bracket" }, "text-link"))}<div class="journey">${[
    "g10",
    "g12",
    "g13",
    "g14",
  ]
    .map((id, i) => {
      const s = e.series.find((g) => g.id === id);
      return `<button data-match="${id}"><small>${["패자조 2R", "패자조 3R", "패자조 결승", "최종 결승"][i]}</small><b>2 : ${s.a === "교권보호국" ? s.sb : s.sa}</b><span>${esc(s.a === "교권보호국" ? s.b : s.a)}</span>${icon("check")}</button>`;
    })
    .join(
      "",
    )}</div></div><div class="section-space">${heading("참가 팀", "각자의 색으로 완성한 여덟 팀", link("8팀 모두 보기 " + icon("arrow"), { tab: "teams" }, "text-link"))}<div class="team-preview">${["교권보호국", "고점폭발", "막차타요", "노종뀨뀨낭"].map((t) => `<a href="${esc(href({ tab: "teams" }))}">${badge(t)}<div><b>${t}</b><small>${e.teams[t].map(shortName).join(" · ")}</small></div>${icon("chevron")}</a>`).join("")}</div></div></div><aside>${mvpCard()}${standingsPanel(e)}${overviewInfo(e)}${sourcesPanel(e)}</aside></div>`;
}
function finalCard(e) {
  return `<div class="final-card"><div class="final-top"><span>${icon("trophy")} GRAND FINAL</span><span>BO3 · 경기 종료</span></div><div class="final-score"><a href="/s/kimmingyo">${avatar("kimmingyo", "large")}<strong>교권보호국</strong><span>김민교 팀</span></a><div><small>WINNER</small><b>2<em>:</em><span>1</span></b><p>FINAL SCORE</p></div><a href="/s/leesangho">${avatar("leesangho", "large")}<strong>고점폭발</strong><span>이상호 팀</span></a></div><div class="set-chips">${e.series
    .find((s) => s.id === "g14")
    .sets.map(
      (s) =>
        `<button data-match="g14" data-set="${s.no}"><span>SET ${s.no}</span> ${s.winner} <b>W</b></button>`,
    )
    .join(
      "",
    )}</div><button class="final-link" data-match="g14">세트별 챔피언 · 경기 기록 ${icon("arrow")}</button></div>`;
}
function mvpCard() {
  return `<section class="mvp-card"><div>${icon("spark")} FINAL MVP</div><strong>김레인<span>BOT · 교권보호국</span></strong><p>결승을 빛낸 한 사람.</p><div class="mvp-bottom"><span>개인상 <b>100만 원</b></span><a href="/s/kimrain" aria-label="김레인 기록 보기">${icon("arrow")}</a></div></section>`;
}
function standingsPanel(e) {
  const rows = isFeatured(e)
    ? standings
    : Object.entries(e.placements).map(([name, p]) => [name, p, "—"]);
  return `<section class="panel standings">${heading("최종 순위")}<div class="table-scroll"><table><thead><tr><th>순위</th><th>팀</th><th>상금</th></tr></thead><tbody>${rows.map(([name, p, prize], i) => `<tr><td class="${i === 0 ? "gold" : ""}">${p}</td><td>${esc(name)}</td><td>${prize}</td></tr>`).join("")}</tbody></table></div><p class="footnote">3위 이하 순위는 대진의 탈락 단계 기준입니다.</p></section>`;
}
function overviewInfo(e) {
  return `<section class="panel"><h2>대회 한눈에</h2><dl class="info-list"><div><dt>기간</dt><dd>${period(e)}</dd></div><div><dt>주최</dt><dd>${esc(e.organizer || "확인 중")}</dd></div><div><dt>참가</dt><dd>${Object.keys(e.teams).length}팀 ${isFeatured(e) ? "· 본선 40명" : ""}</dd></div><div><dt>수집 기록</dt><dd>${e.series.length}경기 · ${totalSets(e)}세트</dd></div>${isFeatured(e) ? "<div><dt>방식</dt><dd>더블 엘리미네이션 · BO3</dd></div><div><dt>패치</dt><dd>26.14 → 결승 26.15</dd></div><div><dt>스폰서</dt><dd>페이레터</dd></div>" : ""}</dl>${link("대회 안내 자세히 " + icon("arrow"), { tab: "info" }, "panel-link")}</section>`;
}
function sourcesPanel(e) {
  return `<section class="panel source-panel"><h2>공식 채널 & 출처</h2>${external("경기 기록 출처", e.source)}${isFeatured(e) ? external("공식 방송국 · 다시보기", sources.vod) + external("대회 공식 안내", sources.announcement) + external("티어 산정 안내", sources.ratingGuide) + external("SOOP 제공 결승 결과", sources.news) : ""}<p class="footnote">수기 수집 기록 · 확인되지 않은 값은 표시하지 않습니다.</p></section>`;
}
function matchList(e, items) {
  return `<div class="match-list">${items.length ? items.map((s) => `<button class="match-row" data-match="${esc(s.id)}"><span class="match-date">${s.date?.slice(5).replace("-", ".")}<small>${esc(s.round)}</small></span><span class="match-team ${s.sa > s.sb ? "winner" : ""}">${badge(s.a)}${esc(s.a)}</span><strong class="match-score"><span class="${s.sa > s.sb ? "win" : ""}">${s.sa}</span><em>:</em><span class="${s.sb > s.sa ? "win" : ""}">${s.sb}</span></strong><span class="match-team right ${s.sb > s.sa ? "winner" : ""}">${esc(s.b)}${badge(s.b)}</span><span class="match-action">${s.sets.length}세트 ${icon("chevron")}</span></button>`).join("") : '<div class="empty"><h3>조건에 맞는 경기가 없어요</h3><p>다른 라운드나 팀을 선택해보세요.</p></div>'}</div>`;
}
function matches(e) {
  return `${heading("일정·결과", `${e.series.length}경기 · ${totalSets(e)}세트 · 경기 시간을 확인하지 못한 경우 날짜만 표시합니다.`)}<div class="match-filters"><label>라운드<select id="stage"><option value="all">전체 라운드</option>${[...new Set(e.series.map((s) => s.round.split(" · ")[0]))].map((r) => `<option>${esc(r)}</option>`).join("")}</select></label><label>팀<select id="team"><option value="all">전체 팀</option>${Object.keys(
    e.teams,
  )
    .map((t) => `<option>${esc(t)}</option>`)
    .join(
      "",
    )}</select></label><span class="chip">수기 수집 기록</span></div>${isFeatured(e) ? '<p class="data-note">패자조 1R 명 수–저로듀스lol: 안내 일정은 7/22, 기존 경기 기록은 7/23으로 출처가 달라 확인 중입니다.</p>' : ""}<div id="matches-results">${matchList(e, e.series)}</div>`;
}
function bracket(e) {
  if (!isFeatured(e)) return matches(e);
  const card = (id) => {
    const s = e.series.find((s) => s.id === id);
    return `<button class="bracket-match" data-match="${id}"><small>${s.date.slice(5).replace("-", ".")} · ${id === "g14" ? "GRAND FINAL" : id.toUpperCase()}</small>${[
      [s.a, s.sa],
      [s.b, s.sb],
    ]
      .map(
        ([t, n]) =>
          `<span class="${n === Math.max(s.sa, s.sb) ? "winner" : ""}">${badge(t)}<b>${t}</b><strong>${n}</strong></span>`,
      )
      .join("")}</button>`;
  };
  return `${heading("대진표", "승자조와 패자조를 거쳐, 마지막 한 팀이 남기까지. 모든 경기 BO3.")}<p class="mobile-hint">좌우로 밀어 전체 대진을 볼 수 있어요.</p><div class="bracket-scroll" tabindex="0" role="region" aria-label="승자조와 결승 대진표"><div class="bracket-grid"><div><h3>승자조 1라운드</h3><div class="bracket-stack">${["g01", "g02", "g03", "g04"].map(card).join("")}</div></div><div><h3>승자조 2라운드</h3><div class="bracket-stack spaced">${["g05", "g07"].map(card).join("")}</div></div><div><h3>승자조 결승</h3><div class="bracket-stack">${card("g11")}</div></div><div class="final-column"><h3>${icon("trophy")} 최종 결승</h3><div class="bracket-stack">${card("g14")}<div class="bracket-champion">${icon("trophy")}<small>CHAMPIONS</small><strong>교권보호국</strong></div></div></div></div></div><div class="bracket-scroll" tabindex="0" role="region" aria-label="패자조 대진표"><div class="bracket-grid lower"><div><h3>패자조 1라운드</h3><div class="bracket-stack">${["g06", "g08"].map(card).join("")}</div></div><div><h3>패자조 2라운드</h3><div class="bracket-stack">${["g09", "g10"].map(card).join("")}</div></div><div><h3>패자조 3라운드</h3><div class="bracket-stack">${card("g12")}</div></div><div><h3>패자조 결승 → 최종 결승</h3><div class="bracket-stack">${card("g13")}</div></div></div></div>`;
}
function teams(e) {
  return `${heading("참가 팀", isFeatured(e) ? "본선 8팀 · 투표 순위순 · 티어와 포인트는 대회 참가 당시 기준입니다." : "수집된 로스터 · 미등록 참가자는 경기 상세에서 확인할 수 있습니다.")}<div class="teams-grid">${Object.entries(
    e.teams,
  )
    .map(([name, members], idx) => {
      const meta = ratings.find((r) => r[0] === name);
      return `<section class="roster-card" style="--team:${teamColor(name)}"><header>${badge(name)}<div><h3>${esc(name)}</h3><p>${isFeatured(e) ? `투표 ${idx + 1}위 · ${standings.find((t) => t[0] === name)?.[1] || ""}` : esc(e.placements[name] || "참가 팀")}</p></div>${isFeatured(e) && name === "교권보호국" ? icon("trophy") : ""}</header><div class="roster-labels"><span>포지션 · 스트리머</span><span>${isFeatured(e) ? "대회 티어 / 포인트" : "기록"}</span></div>${members.map((p, i) => `<a class="roster-member" href="/s/${esc(p)}"><span class="position">${{ TOP: "TOP", JUNGLE: "JGL", MIDDLE: "MID", BOTTOM: "BOT", UTILITY: "SUP" }[e.positions[p]] || "—"}</span>${avatar(p)}<b>${esc(person(p))}${isFeatured(e) && meta?.[1] === p ? '<i class="captain" title="주장">C</i>' : ""}</b><span class="rating">${isFeatured(e) ? `${meta?.[2][i]?.[0] || "—"} <strong>${meta?.[2][i]?.[1] ?? "—"}</strong>` : icon("chevron")}</span></a>`).join("")}${isFeatured(e) && name === "막차타요" ? '<p class="roster-note">로스터 변경 · 7/22부터 SUP 라코XD<br>이전 출전: 민준원주민 · Legendary / 47점</p>' : ""}</section>`;
    })
    .join("")}</div>`;
}
function records(e) {
  const players = new Map(),
    champs = new Map();
  let complete = 0;
  for (const s of e.series)
    for (const g of s.sets) {
      for (const [team, ps] of Object.entries(g.lineup || {})) {
        for (const p of ps) {
          const key = p.slug || p.observed_name;
          if (!key) continue;
          const row = players.get(key) || {
            key,
            name: p.slug ? person(p.slug) : p.observed_name,
            games: 0,
            wins: 0,
            k: 0,
            d: 0,
            a: 0,
            known: 0,
          };
          row.games++;
          if (team === g.winner) row.wins++;
          if (
            [p.kills, p.deaths, p.assists].every((n) => typeof n === "number")
          ) {
            row.k += p.kills;
            row.d += p.deaths;
            row.a += p.assists;
            row.known++;
            complete++;
          }
          players.set(key, row);
          if (p.champion) {
            const c = champs.get(p.champion) || {
              name: p.champion,
              picks: 0,
              wins: 0,
            };
            c.picks++;
            if (team === g.winner) c.wins++;
            champs.set(p.champion, c);
          }
        }
      }
    }
  const sorted = [...players.values()].sort(
    (a, b) => b.wins - a.wins || b.games - a.games,
  );
  const cs = [...champs.values()].sort((a, b) => b.picks - a.picks);
  return `${heading("대회 기록실", "대회에서 확인한 출전과 챔피언 기록을 한곳에.")}<div class="record-summary"><div><span>기록된 세트</span><b>${totalSets(e)}</b></div><div><span>확인된 출전 인원</span><b>${players.size}</b></div><div><span>등장한 챔피언</span><b>${champs.size}</b></div><div><span>K/D/A 확인 범위</span><b>${complete}<small> / ${totalSets(e) * 10}</small></b></div></div><p class="data-note">시드 라인업에서 계산한 기록입니다. 결승 3세트처럼 검수가 필요한 K/D/A는 제외하며, 순위는 세트 승수 기준입니다. 밴 기록은 미수집입니다.</p><div class="content-columns records-columns"><section class="panel"><h2>선수 기록 <span class="subtle">세트 승수순</span></h2><div class="table-scroll"><table class="players-table"><thead><tr><th>선수</th><th>출전</th><th>승 / 패</th><th>평균 K / D / A</th><th>확인 세트</th></tr></thead><tbody>${sorted.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.games}</td><td><span class="win">${p.wins}</span> / ${p.games - p.wins}</td><td>${p.known ? [p.k, p.d, p.a].map((n) => (n / p.known).toFixed(1)).join(" / ") : "미수집"}</td><td>${p.known} / ${p.games}</td></tr>`).join("")}</tbody></table></div></section><section class="panel"><h2>많이 선택한 챔피언</h2>${cs
    .slice(0, 15)
    .map(
      (c, i) =>
        `<div class="champ-row"><span>${String(i + 1).padStart(2, "0")}</span>${championIcon(c.name)}<b>${c.name}</b><div>${c.picks}픽<small>${c.wins}승 ${c.picks - c.wins}패</small></div></div>`,
    )
    .join(
      "",
    )}<p class="footnote">픽 수는 수집된 라인업 기준입니다. 밴픽률과 혼용하지 않습니다.</p></section></div>`;
}
function championIcon(name) {
  const c = data.champions.champions.find((c) => c.name === name);
  return c
    ? `<img class="champ-icon" src="/images/champions/${esc(c.en)}.png" alt="" loading="lazy">`
    : '<span class="champ-icon"></span>';
}
function info(e) {
  if (!isFeatured(e))
    return `<div class="content-columns">${overviewInfo(e)}${sourcesPanel(e)}</div>`;
  return `${heading("대회 안내", "처음 보는 사람도, 다시 찾는 사람도 알아두면 좋은 정보.")}<div class="info-grid"><section class="panel"><h2>${icon("trophy")} 운영 & 경기 방식</h2><dl class="info-list"><div><dt>주최 / 운영</dt><dd>SOOP</dd></div><div><dt>스폰서</dt><dd>페이레터</dd></div><div><dt>본선 선발</dt><dd>신청 12팀 중 투표 상위 8팀</dd></div><div><dt>대진 방식</dt><dd>8팀 더블 엘리미네이션</dd></div><div><dt>세트 규칙</dt><dd>전 경기 3판 2선승 (BO3)</dd></div><div><dt>선수 평가</dt><dd>GGA 협업 · 대회 전용 티어 / 포인트</dd></div><div><dt>코칭</dt><dd>참가 팀별 GGA 코칭 지원</dd></div></dl></section><section class="panel"><h2>${icon("pin")} 일정 & 경기장</h2><dl class="info-list"><div><dt>대회 기간</dt><dd>2026.07.19 — 08.01</dd></div><div><dt>본선</dt><dd>개인 스튜디오 · 온라인</dd></div><div><dt>결승</dt><dd>킨텍스 제1전시장 · 대한민국</dd></div><div><dt>연계 행사</dt><dd>House of Gen.G<br>2026 LCK Team Roadshow</dd></div><div><dt>패치</dt><dd>본선 26.14 / 결승 26.15</dd></div></dl></section><section class="panel"><h2>${icon("spark")} 상금 & 시상</h2><div class="prize-total"><span>TOTAL PRIZE POOL</span><strong>3,100<small>만 원</small></strong></div><dl class="info-list"><div><dt>우승</dt><dd>교권보호국 · 2,500만 원</dd></div><div><dt>준우승</dt><dd>고점폭발 · 500만 원</dd></div><div><dt>FINAL MVP</dt><dd>김레인 · 100만 원</dd></div><div><dt>우승 특전</dt><dd>Gen.G 굿즈 · 기인 / 듀로 합동 방송</dd></div></dl></section><section class="panel"><h2>${icon("users")} 중계진</h2><dl class="info-list"><div><dt>캐스터</dt><dd>김규환 · 채민준</dd></div><div><dt>해설</dt><dd>김동준 · 신정현 · 이서행<br>이채환 · 이현우</dd></div><div><dt>합류 시점</dt><dd>이현우: 패자조 3라운드부터</dd></div><div><dt>결승 인터뷰</dt><dd>이은빈</dd></div></dl></section></div><div class="section-space">${sourcesPanel(e)}<div class="data-note"><b>기록 안내</b><p>패자조 1라운드 명 수–저로듀스lol 경기 날짜는 안내 일정(7/22)과 기존 수집 기록(7/23)이 달라 재확인이 필요합니다. 막차타요는 7/22부터 서포터가 변경되었으며, 경기 상세는 해당 세트에서 확인된 출전 선수를 표시합니다.</p><p>결승 3세트 K/D/A는 결과표의 합계 불일치로 표시하지 않습니다. 확인되지 않은 밴, 골드, 피해량은 추가 수집 대상입니다.</p></div></div>`;
}
function openMatch(e, id, setNo) {
  const s = e.series.find((s) => s.id === id);
  if (!s) return;
  const dialog = $("#match-dialog");
  dialog.dataset.match = id;
  dialog.dataset.event = e.slug;
  const g = s.sets.find((g) => g.no === Number(setNo)) || s.sets[0];
  dialog.innerHTML = `<div class="dialog-head"><div><span class="eyebrow">${esc(s.round)} · ${date(s.date)}</span><h2 id="dialog-title">${esc(s.a)} <span>${s.sa} : ${s.sb}</span> ${esc(s.b)}</h2></div><button class="icon-button" id="close-dialog" aria-label="경기 상세 닫기">${icon("close")}</button></div><div class="dialog-tabs">${s.sets.map((x, i) => `<button data-dialog-set="${i}" aria-pressed="${x === g}">${s.orderKnown && x.no ? `${x.no}세트` : `수집 경기 ${i + 1}`}</button>`).join("")}</div><div class="set-summary"><span class="chip">수기</span><b>${esc(g.winner)} 승리</b><span>${g.duration ? `${Math.floor(g.duration / 60)}:${String(g.duration % 60).padStart(2, "0")}` : "경기 시간 미수집"}</span></div>${!s.orderKnown ? '<p class="data-note">세트 순서가 확인되지 않아 수집 순으로 표시합니다.</p>' : ""}<div class="scoreboard-grid">${[g.blue, g.red].map((team, i) => `<section><h3><span class="side-dot side-${i}"></span>${esc(team)} ${g.winner === team ? '<span class="win">WIN</span>' : ""}</h3><div class="table-scroll"><table class="scoreboard"><thead><tr><th>선수 / 챔피언</th><th>포지션</th><th>K / D / A</th></tr></thead><tbody>${(g.lineup?.[team] || []).map((p) => `<tr><td><div>${championIcon(p.champion)}<span><b>${esc(p.slug ? person(p.slug) : p.observed_name || "미확인")}</b><small>${esc(p.champion || "챔피언 미수집")}</small></span></div></td><td>${{ TOP: "TOP", JUNGLE: "JGL", MIDDLE: "MID", BOTTOM: "BOT", UTILITY: "SUP" }[p.position] || "—"}</td><td>${[p.kills, p.deaths, p.assists].every((n) => typeof n === "number") ? `${p.kills} / ${p.deaths} / ${p.assists}` : "미확인"}</td></tr>`).join("") || '<tr><td colspan="3">세트별 라인업을 아직 수집하지 않았습니다.</td></tr>'}</tbody></table></div></section>`).join("")}</div>${isFeatured(e) && id === "g14" && g.no === 3 ? '<p class="data-note">이 세트의 K/D/A는 원문 합계가 일치하지 않아 검수에서 제외했습니다.</p>' : ""}<div class="dialog-footer">${external("경기 결과 출처", g.source)}${isFeatured(e) ? external(icon("play") + "공식 방송국 다시보기", sources.vod) : ""}</div>`;
  $("#close-dialog").onclick = () => dialog.close();
  dialog
    .querySelectorAll("[data-dialog-set]")
    .forEach(
      (b) =>
        (b.onclick = () => openMatchIndex(e, s, Number(b.dataset.dialogSet))),
    );
  if (!dialog.open) dialog.showModal();
}
function openMatchIndex(e, s, index) {
  const g = s.sets[index];
  if (g.no != null) {
    openMatch(e, s.id, g.no);
    return;
  } // Unknown-order fixtures still need independent selection.
  const clone = {
    ...e,
    series: e.series.map((x) =>
      x === s ? { ...s, sets: s.sets.map((g, i) => ({ ...g, no: i + 1 })) } : x,
    ),
  };
  openMatch(clone, s.id, index + 1);
}
// Connect actual winners to the next match, independently of card height or viewport.
function drawBracketConnections() {
  const edges = [
    ["g01", "g05"],
    ["g02", "g05"],
    ["g03", "g07"],
    ["g04", "g07"],
    ["g05", "g11"],
    ["g07", "g11"],
    ["g11", "g14"],
    ["g06", "g09"],
    ["g08", "g10"],
    ["g09", "g12"],
    ["g10", "g12"],
    ["g12", "g13"],
  ];
  document.querySelectorAll(".bracket-grid").forEach((grid) => {
    grid.querySelector(".bracket-connections")?.remove();
    const rect = grid.getBoundingClientRect();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("bracket-connections");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
    for (const [from, to] of edges) {
      const start = grid.querySelector(`[data-match="${from}"]`);
      const end = grid.querySelector(`[data-match="${to}"]`);
      if (!start || !end) continue;
      const a = start.getBoundingClientRect(),
        b = end.getBoundingClientRect();
      const x1 = a.right - rect.left,
        x2 = b.left - rect.left;
      const y1 = a.top + a.height / 2 - rect.top,
        y2 = b.top + b.height / 2 - rect.top;
      const mid = (x1 + x2) / 2;
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", `M ${x1} ${y1} H ${mid} V ${y2} H ${x2}`);
      svg.append(path);
    }
    grid.prepend(svg);
  });
}

function navigate(patch) {
  history.pushState({}, "", href(patch));
  state = getState();
  render();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function render() {
  requestAnimationFrame(drawBracketConnections);
  document.fonts.ready.then(drawBracketConnections);
  document.body.dataset.variant = state.variant;
  const e = data.events.find((e) => e.slug === state.event);
  document.title = `${e ? e.name : "대회"} · SOOP LOL | ${state.variant === "a" ? "A SPECTACLE" : "B ARCHIVE"}`;
  $("#app").innerHTML = header() + (e ? detail(e) : listing()) + footer();
  if (!e) {
    $("#year").value = state.year;
    renderResults();
    $("#search").oninput = (ev) => {
      state.query = ev.target.value;
      history.replaceState({}, "", href());
      renderResults();
    };
    $("#year").onchange = (ev) => navigate({ year: ev.target.value });
    $("#status").onchange = (ev) => navigate({ status: ev.target.value });
    $("#all-years").onclick = () =>
      navigate({ year: "all", category: "all", query: "", status: "all" });
    document
      .querySelectorAll("[data-category]")
      .forEach(
        (b) => (b.onclick = () => navigate({ category: b.dataset.category })),
      );
  }
  if (e && $("#stage")) {
    const filter = () => {
      $("#matches-results").innerHTML = matchList(
        e,
        e.series.filter(
          (s) =>
            ($("#stage").value === "all" ||
              s.round.split(" · ")[0] === $("#stage").value) &&
            ($("#team").value === "all" ||
              [s.a, s.b].includes($("#team").value)),
        ),
      );
    };
    $("#stage").onchange = filter;
    $("#team").onchange = filter;
  }
}
document.addEventListener("click", (ev) => {
  const button = ev.target.closest("[data-match]");
  if (button && button.tagName === "BUTTON") {
    const e = data.events.find((e) => e.slug === state.event);
    if (e) openMatch(e, button.dataset.match, button.dataset.set);
    return;
  }
  const a = ev.target.closest('a[href^="?"]');
  if (a && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey) {
    ev.preventDefault();
    history.pushState({}, "", a.href);
    state = getState();
    render();
    window.scrollTo({ top: 0, behavior: "instant" });
  }
});
$("#match-dialog").addEventListener("click", (ev) => {
  if (ev.target === $("#match-dialog")) {
    const r = ev.target.getBoundingClientRect();
    if (
      ev.clientX < r.left ||
      ev.clientX > r.right ||
      ev.clientY < r.top ||
      ev.clientY > r.bottom
    )
      ev.target.close();
  }
});
window.addEventListener("popstate", () => {
  state = getState();
  $("#match-dialog").close();
  render();
});
state = getState();
render();

window.addEventListener("resize", drawBracketConnections);
