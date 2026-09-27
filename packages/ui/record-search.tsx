"use client";

// Shared presentation only: the host and optional modules supply public search options.
import { useId, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export interface RecordSearchOption {
  slug: string;
  display_name: string;
  aliases: string[];
  channel_id: string | null;
  subtitle?: string;
}
type Selection = { text: string; slug: string };
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
const initial = (options: RecordSearchOption[], slug?: string): Selection => {
  const person = options.find((o) => o.slug === slug);
  return { text: person?.display_name ?? "", slug: person?.slug ?? "" };
};

function PersonField({ label, options, value, onChange, hidden = false }: {
  label: string; options: RecordSearchOption[]; value: Selection;
  onChange: (value: Selection) => void; hidden?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => {
    if (value.slug || !value.text.trim()) return [];
    const q = norm(value.text);
    return options.filter((p) => [p.display_name, p.slug, p.channel_id ?? "", p.subtitle ?? "", ...p.aliases].some((s) => norm(s).includes(q))).slice(0, 8);
  }, [options, value]);
  function pick(person: RecordSearchOption) {
    onChange({text: person.display_name, slug: person.slug});
    setOpen(false);
    input.current?.focus();
  }
  return <div className="record-search-field" hidden={hidden}>
    <label htmlFor={id}>{label}</label>
    <input id={id} ref={input} value={value.text} placeholder="이름 · 별명 · 채널 아이디" autoComplete="off"
      role="combobox" aria-autocomplete="list" aria-expanded={open && hits.length > 0}
      aria-controls={`${id}-options`} aria-activedescendant={open && hits[cursor] ? `${id}-option-${cursor}` : undefined}
      onChange={(e) => { onChange({text:e.currentTarget.value, slug:""});setCursor(0);setOpen(true); }}
      onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === "Escape") { setOpen(false);return; }
        if (!hits.length) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();setOpen(true);setCursor((c) => (c + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
        } else if (e.key === "Enter" && open) { e.preventDefault();pick(hits[cursor] ?? hits[0]); }
      }} />
    <ul id={`${id}-options`} role="listbox" aria-label={`${label} 검색 결과`} className="record-search-options" hidden={!open || !hits.length}>
      {hits.map((person,i) => <li id={`${id}-option-${i}`} key={person.slug} role="option" aria-selected={cursor === i}
        onPointerDown={(e) => { e.preventDefault();pick(person); }} onMouseEnter={() => setCursor(i)}>
        <span>{person.display_name}</span><small>{person.subtitle ?? person.channel_id}</small>
      </li>)}
    </ul>
    {open && value.text.trim() && !value.slug && !hits.length && <p className="record-search-options record-search-no-results">찾는 스트리머가 없습니다.</p>}
  </div>;
}

export function RecordSearch({ options, a, b, mode = "versus", versusPath, personalPathPrefix = "/s", includeOpponentInPersonal = true, category, year, personalHint, versusHint }: {
  options: RecordSearchOption[]; a?: string; b?: string; mode?: "personal" | "versus";
  versusPath?: string | null; personalPathPrefix?: string; includeOpponentInPersonal?: boolean; category?: string; year?: number;
  personalHint?: string; versusHint?: string;
}) {
  const [selectedMode, setMode] = useState(versusPath ? mode : "personal");
  const [left, setLeft] = useState(() => initial(options,a));
  const [right, setRight] = useState(() => initial(options,b));
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const id = useId();
  function changeMode(next: "personal" | "versus") { setMode(next);setError(""); }
  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!left.slug) { setError("스트리머를 검색 결과에서 선택해 주세요.");return; }
    if (selectedMode === "versus" && !right.slug) { setError("비교할 상대 스트리머를 선택해 주세요.");return; }
    if (selectedMode === "versus" && left.slug === right.slug) { setError("서로 다른 스트리머를 선택해 주세요.");return; }
    const query = new URLSearchParams();
    if (category && category !== "all") query.set("category",category);
    if (year) query.set("year",String(year));
    let path: string;
    if (selectedMode === "personal") {
      path = `${personalPathPrefix}/${encodeURIComponent(left.slug)}`;
      if (includeOpponentInPersonal && right.slug && right.slug !== left.slug) query.set("opponent",right.slug);
    } else {
      if (!versusPath) return;
      path = versusPath;query.set("a",left.slug);query.set("b",right.slug);
    }
    startTransition(() => router.push(`${path}${query.size ? `?${query}` : ""}`));
  }
  return <section className="record-search" aria-label="기록 검색">
    <div className="record-search-tabs" role="tablist" aria-label="검색 방식">
      {([['personal','개인 기록'],['versus','상대전적']] as const).filter(([key]) => key === 'personal' || versusPath).map(([key,label]) =>
        <button key={key} id={`${id}-${key}`} type="button" role="tab" aria-selected={selectedMode===key} aria-controls={`${id}-panel`}
          tabIndex={selectedMode===key?0:-1} onClick={() => changeMode(key)} onKeyDown={(e) => {
            if (versusPath && ['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) {
              e.preventDefault();const next=e.key==='Home'?'personal':e.key==='End'?'versus':selectedMode==='personal'?'versus':'personal';
              changeMode(next);document.getElementById(`${id}-${next}`)?.focus();
            }
          }}>{label}</button>)}
    </div>
    <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${selectedMode}`}>
      <p className="record-search-hint">{selectedMode==='personal'
        ? personalHint ?? '한 명의 프로필, 수상 경력과 경기 기록을 살펴보세요.'
        : versusHint ?? '두 스트리머가 맞붙었을 때와 함께했을 때의 기록을 비교하세요.'}</p>
      <form className="record-search-form" onSubmit={submit}>
        <PersonField label="스트리머" options={options} value={left} onChange={(value) => {setLeft(value);setError("");}} />
        <PersonField label="상대 스트리머" options={options} value={right} onChange={(value) => {setRight(value);setError("");}} hidden={selectedMode==='personal'} />
        <button className="record-search-submit" type="submit" disabled={pending}>{pending?'불러오는 중…':selectedMode==='personal'?'개인 기록 보기':'상대전적 보기'}</button>
      </form>
      {error && <p className="record-search-error" role="alert">{error}</p>}
    </div>
  </section>;
}
