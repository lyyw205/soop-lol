"use client";
import { useId, useState } from "react";

export function PersonPicker({ name, people, value, onChange, required = false }: {
  name?: string; people: { slug: string; display_name: string }[];
  value: string; onChange: (value: string) => void; required?: boolean;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const choices = people.filter(p => p.slug === value || `${p.display_name} ${p.slug}`.toLowerCase().includes(query.toLowerCase()));
  const visible = choices.slice(0, 30);
  const selected = choices.find(p => p.slug === value);
  if (selected && !visible.includes(selected)) visible.unshift(selected);
  return <div className="grid min-w-0 gap-1">
    <label htmlFor={`${id}-search`} className="text-xs text-ink-400">스트리머 찾기</label>
    <input id={`${id}-search`} type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="이름·아이디 검색" className="admin-input" />
    <select aria-label="연결할 스트리머" name={name} value={value} onChange={e => onChange(e.target.value)} required={required} className="admin-input">
      <option value="">스트리머 선택</option>
      {visible.map(p => <option key={p.slug} value={p.slug}>{p.display_name} · {p.slug}</option>)}
    </select>
    {choices.length > 30 && <span className="text-xs text-ink-400">{choices.length}명 중 30명 표시 · 이름으로 검색하세요.</span>}
    {choices.length === 0 && <span className="text-xs text-ink-400">검색 결과가 없습니다.</span>}
  </div>;
}
