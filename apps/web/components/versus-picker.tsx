"use client";

/**
 * 상대전적 선택기 — 치면 아래에 후보가 뜬다.
 *
 * ★ 왜 select 가 아닌가
 *   스트리머가 419명이다. 드롭다운은 그 길이를 감당 못 한다 — 스크롤로 찾는 건
 *   목록이 20개쯤일 때 이야기고, 400개가 넘으면 이름을 아는 사람도 못 찾는다.
 *
 * ★ 419명을 통째로 들고 필터한다
 *   글자마다 서버에 묻지 않는다. 이름·slug·별칭까지 다 합쳐도 20KB 남짓이라
 *   한 번 받아 두는 편이 낫다 — 왕복이 없으니 즉시 반응하고, 디바운스나
 *   경쟁 상태(늦게 온 응답이 최신 입력을 덮는 것)를 신경 쓸 일이 아예 없다.
 *
 * ★ 고른 것과 친 것을 구분한다
 *   보이는 입력칸은 **찾기용**이고, 실제로 넘어가는 건 hidden 의 slug 다.
 *   고른 뒤에 글자를 고치면 slug 를 지운다 — 안 그러면 '김민교' 를 고르고 이름만
 *   바꿔 놓은 채 엉뚱한 사람의 전적으로 넘어간다.
 */

import { useMemo, useRef, useState } from "react";

export interface PickerOption {
  slug: string;
  display_name: string;
  aliases: string[];
}

/** 띄어쓰기는 무시한다 — '항상#킴성태' 같은 이름을 사람마다 다르게 띄운다. */
const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();

function matches(o: PickerOption, q: string): boolean {
  const n = norm(q);
  return norm(o.display_name).includes(n)
    || norm(o.slug).includes(n)
    || o.aliases.some((a) => norm(a).includes(n));
}

const MAX_SUGGESTIONS = 8;

function OneField({
  name, label, options, initialSlug,
}: { name: string; label: string; options: PickerOption[]; initialSlug?: string }) {
  const initial = options.find((o) => o.slug === initialSlug);
  const [text, setText] = useState(initial?.display_name ?? "");
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const hits = useMemo(() => {
    const q = text.trim();
    if (!q || slug) return [];               // 이미 골랐으면 목록을 닫는다
    return options.filter((o) => matches(o, q)).slice(0, MAX_SUGGESTIONS);
  }, [text, slug, options]);

  const pick = (o: PickerOption) => {
    setText(o.display_name);
    setSlug(o.slug);
    setOpen(false);
  };

  return (
    <div className="relative min-w-[220px] flex-1">
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-ink-400">{label}</span>
        <input
          ref={inputRef}
          type="text"
          autoComplete="off"
          placeholder="이름을 입력하세요"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setSlug("");                     // 글자가 바뀌면 고른 것은 무효다
            setOpen(true);
            setCursor(0);
          }}
          onFocus={() => setOpen(true)}
          // ★ blur 를 곧바로 닫으면 목록 클릭이 먹지 않는다 (클릭 전에 blur 가 먼저 온다).
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (hits.length === 0) return;
            if (e.key === "ArrowDown") { e.preventDefault(); setOpen(true); setCursor((c) => (c + 1) % hits.length); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + hits.length) % hits.length); }
            else if (e.key === "Enter" && open) { e.preventDefault(); pick(hits[cursor] ?? hits[0]); }
            else if (e.key === "Escape") setOpen(false);
          }}
          className="w-full rounded-lg border border-ink-700 bg-ink-800 px-3 py-2 text-sm text-ink-200
                     placeholder:text-ink-400/60 outline-none focus:border-accent-600"
        />
      </label>
      {/* 서버로 넘어가는 건 이것뿐이다. 보이는 칸은 찾기용. */}
      <input type="hidden" name={name} value={slug} />

      {open && hits.length > 0 && (
        <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-ink-700 bg-ink-900 shadow-lg">
          {hits.map((o, i) => (
            <li key={o.slug}>
              <button
                type="button"
                // onMouseDown 이라야 blur 보다 먼저 잡힌다.
                onMouseDown={(e) => { e.preventDefault(); pick(o); }}
                onMouseEnter={() => setCursor(i)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm
                            ${i === cursor ? "bg-ink-800 text-ink-100" : "text-ink-300"}`}
              >
                <span className="truncate">{o.display_name}</span>
                <span className="ml-auto shrink-0 text-[11px] text-ink-400">{o.slug}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && text.trim() && hits.length === 0 && !slug && (
        <p className="absolute z-10 mt-1 w-full rounded-lg border border-ink-800 bg-ink-900 px-3 py-2 text-[11px] text-ink-400">
          찾는 스트리머가 없습니다. 아직 등록되지 않았을 수 있어요.
        </p>
      )}
    </div>
  );
}

export function VersusPicker(
  { options, a, b }: { options: PickerOption[]; a?: string; b?: string },
) {
  return (
    <form method="get" action="/vs" className="mt-6 flex flex-wrap items-end gap-3">
      <OneField name="a" label="누가" options={options} initialSlug={a} />
      <OneField name="b" label="누구와" options={options} initialSlug={b} />
      <button
        type="submit"
        className="rounded-lg border border-ink-700 bg-ink-800 px-4 py-2 text-sm text-ink-200 hover:border-ink-600"
      >
        보기
      </button>
    </form>
  );
}
