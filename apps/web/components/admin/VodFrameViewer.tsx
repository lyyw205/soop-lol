"use client";

/**
 * VOD 프레임 뷰어 — FC 검수 작업대 두 곳(맥락 검수 단위·화면 경기)이 **같이 쓰는** 한 부품.
 *
 * 무엇을 넘겨 보나 (아래 「간격」으로 고른다):
 *   근거   이 경기(또는 묶음)에 조사가 근거로 건 프레임만. 여러 VOD(다른 시점)가 섞일 수 있다.
 *   원본   지금 보는 프레임의 VOD 에 디스크로 받아 둔 원본(1920×1080) 전부 — 결과 화면 앞뒤 원본(npm run fco:frames) 포함
 *   3초 … 5분  그 VOD 의 시간을 그 간격으로. 원본이 그 초(±1)에 있으면 원본, 없으면 썸네일 시트의 3초 칸(저해상도)
 * 키보드: ← → 만 쓴다(↑↓ 는 작업대의 큐 이동이 쓴다). 입력칸에서는 가로채지 않는다.
 *
 * ★ 두 작업대가 뷰어를 따로 들고 있으면 한쪽에만 고친 것이 생긴다(실제로 그랬다 — 2026-10-02). 뷰어는 이것 하나다.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { VodFrame } from "@/lib/vod-frames";

/** 조사가 건 근거 프레임 하나. */
export interface ViewerEvidence {
  key: string;
  path: string;
  sec: number | null;
  vod: string | null;
  /** 장면 이름(결과·시작…) */
  label?: string | null;
  result?: boolean;
  /** 본 것 / 판단 */
  observed?: string | null;
  why?: string | null;
}
/** VOD 하나에서 넘겨 볼 수 있는 것 — 디스크 원본 목록과 썸네일 칸 길이(시트가 없으면 null). */
export interface ViewerVod { url: string; frames: VodFrame[]; lengthSec: number | null }

const frameUrl = (path: string) => `/admin/ck/frame/${path.split("/").map(encodeURIComponent).join("/")}`;
const cellUrl = (vod: string, sec: number) => `/admin/fco/screen/cell/${vod}/${sec}`;
const hms = (sec: number | null) => {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
};
const offsetLabel = (sec: number) => `${sec < 0 ? "−" : "+"}${String(Math.floor(Math.abs(sec) / 60)).padStart(2, "0")}:${String(Math.abs(sec) % 60).padStart(2, "0")}`;

/** -1 = 근거, 0 = 원본, 나머지 = 초 간격(썸네일 칸, 원본이 있으면 원본) */
const STEPS = [-1, 0, 3, 10, 30, 60, 300] as const;
const STEP_LABEL: Record<number, string> = { [-1]: "근거", 0: "원본", 3: "3초", 10: "10초", 30: "30초", 60: "1분", 300: "5분" };
const STRIP_SIDE = 12;
const ORIGINAL_WINDOW = 900;

export function VodFrameViewer({ evidence, vods, resultSecs = {}, headerExtra, emptyText }: {
  evidence: ViewerEvidence[];
  vods: Record<string, ViewerVod>;
  /** VOD 별 결과 화면 초 — 띠에 ★ 로 표시(다른 경기 것 포함) */
  resultSecs?: Record<string, number[]>;
  headerExtra?: ReactNode;
  emptyText: string;
}) {
  // 근거 중 처음 보여 줄 것 — 결과 화면이 있으면 그것(검수자는 스코어부터 대조한다)
  const firstEvidence = evidence.find((e) => e.result) ?? evidence[0] ?? null;
  const [evidenceKey, setEvidenceKey] = useState<string | null>(null);
  const [view, setView] = useState<{ vod: string; sec: number } | null>(null); // 근거가 아닌 지점을 볼 때
  const [stepPick, setStepPick] = useState<number | null>(null);
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const stripRef = useRef<HTMLDivElement>(null);

  const ev = evidence.find((e) => e.key === evidenceKey) ?? firstEvidence;
  const vod = view?.vod ?? ev?.vod ?? null;
  const vodInfo = vod ? vods[vod] ?? null : null;
  const originals = vodInfo?.frames ?? [];
  const cellsOk = vodInfo?.lengthSec != null;
  const sec = view?.sec ?? ev?.sec ?? null;
  const center = ev?.sec ?? null; // 띠의 ±표시 기준: 지금 고른 근거

  // 기본 간격 — 근거가 둘 이상이면 근거, 아니면 원본이 근처에 있으면 원본, 그것도 아니면 30초
  const nearOriginals = center != null && originals.filter((f) => Math.abs(f.sec - center) <= 300).length >= 3;
  const step = stepPick ?? (evidence.length >= 2 ? -1 : nearOriginals ? 0 : 30);

  // 지금 크게 보는 것
  const onEvidence = view == null && ev != null;
  const fullRes = onEvidence ? { path: ev!.path, sec: ev!.sec }
    : sec != null ? originals.find((f) => Math.abs(f.sec - sec) <= 1) ?? null : null;
  const src = fullRes ? frameUrl(fullRes.path) : vod && sec != null && cellsOk ? cellUrl(vod, sec) : null;
  const results = (vod && resultSecs[vod]) || [];
  const isResultAt = (t: number, tol: number) => results.some((r) => Math.abs(r - t) <= tol);

  const goEvidence = (key: string) => { setEvidenceKey(key); setView(null); };
  const goSec = (t: number) => {
    if (!vod) return;
    // 근거 프레임 자리면 근거로 본다(메모가 같이 보인다)
    const hit = evidence.find((e) => e.vod === vod && e.sec != null && Math.abs(e.sec - t) <= 1);
    if (hit) goEvidence(hit.key); else setView({ vod, sec: t });
  };
  const clamp = (t: number) => Math.max(0, cellsOk ? Math.min(t, Math.floor(vodInfo!.lengthSec! - 1)) : t);
  const move = (dir: -1 | 1) => {
    if (step === -1) {
      if (!evidence.length) return;
      const i = ev ? evidence.findIndex((e) => e.key === ev.key) : -1;
      const next = evidence[Math.min(Math.max((onEvidence ? i : i) + dir, 0), evidence.length - 1)];
      if (next) goEvidence(next.key);
      return;
    }
    if (sec == null) return;
    if (step === 0) {
      const next = dir === 1 ? originals.find((f) => f.sec > sec + 1) : [...originals].reverse().find((f) => f.sec < sec - 1);
      if (next) goSec(next.sec);
      return;
    }
    goSec(clamp(sec + dir * step));
  };

  // 띠
  const strip = useMemo((): { key: string; sec: number | null; src: string; label: string; current: boolean; star: boolean; onClick: () => void }[] => {
    if (step === -1) {
      return evidence.map((e) => ({
        key: e.key, sec: e.sec, src: frameUrl(e.path), current: onEvidence && e.key === ev?.key, star: !!e.result,
        label: `${e.label ? `${e.label} ` : ""}${hms(e.sec)}`, onClick: () => goEvidence(e.key),
      }));
    }
    if (sec == null || !vod) return [];
    const points: number[] = step === 0
      ? originals.filter((f) => Math.abs(f.sec - sec) <= ORIGINAL_WINDOW).map((f) => f.sec)
      : cellsOk ? Array.from({ length: STRIP_SIDE * 2 + 1 }, (_, k) => sec + (k - STRIP_SIDE) * step).filter((t) => t >= 0 && t < vodInfo!.lengthSec!) : [];
    return points.map((t) => {
      const orig = originals.find((f) => Math.abs(f.sec - t) <= 1);
      return {
        key: `${vod}@${t}`, sec: t, src: orig ? frameUrl(orig.path) : cellUrl(vod, t),
        current: Math.abs(t - sec) <= (step === 0 ? 1 : 0), star: isResultAt(t, Math.max(1, step / 2)),
        label: center != null ? offsetLabel(t - center) : hms(t), onClick: () => goSec(t),
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, evidence, ev?.key, onEvidence, sec, vod, originals, cellsOk, vodInfo?.lengthSec, center, results]);

  // ← → — 입력칸에서는 가로채지 않는다. ↑↓ 는 건드리지 않는다(작업대 큐 이동).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const t = e.target as HTMLElement | null;
      if (t?.matches("input, textarea, select, [contenteditable=true]")) return;
      e.preventDefault();
      move(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    stripRef.current?.querySelector<HTMLElement>('[data-current="true"]')?.scrollIntoView({ inline: "center", block: "nearest" });
  }, [sec, step, ev?.key]);

  const kindLabel = onEvidence
    ? (ev!.result ? "결과 화면 — 조사가 근거로 건 프레임" : `근거 프레임${ev!.label ? ` · ${ev!.label}` : ""}`)
    : fullRes ? (isResultAt(fullRes.sec ?? -1, 1) ? "다른 경기의 결과 화면" : "원본 프레임")
    : "썸네일(3초 칸·저해상도) — 원본은 아직 뽑지 않았습니다";

  return (
    <section className="ck-review-preview">
      <header className="flex items-center justify-between gap-3 border-b border-ink-800 px-4 py-2">
        <div className="min-w-0 text-xs text-ink-400">
          {sec != null && src ? <>
            <span className="font-mono text-accent-400">{hms(sec)}</span>
            {center != null && sec !== center && <span className="ml-1.5 font-mono text-ink-200">(근거 {offsetLabel(sec - center)})</span>}
            {vod && Object.keys(vods).length > 1 && <span className="ml-2 text-ink-500">VOD {vod}</span>}
            <span className="mx-2 text-ink-600">·</span>{kindLabel}
            {headerExtra}
          </> : emptyText}
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs">
          {vodInfo && <a href={`${vodInfo.url}${sec != null ? `?change_second=${sec}` : ""}`} target="_blank" rel="noreferrer" className="text-accent-400">이 시점 VOD ↗</a>}
          {src && <>
            <button type="button" onClick={() => setZoom((z) => !z)} className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200">{zoom ? "맞추기" : "원본 크기"}</button>
            <a href={src} target="_blank" rel="noreferrer" className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200">새 탭 ↗</a>
          </>}
        </div>
      </header>

      {/* 원본 크기에서는 스크롤로 닉네임 칸을 들여다본다 — 오독은 확대해야 보인다. */}
      <div data-zoom={zoom} className={`ck-review-frame bg-ink-950 ${zoom ? "max-h-[75vh] overflow-auto" : ""}`}>
        {src && !failed.has(src) ? (
          // eslint-disable-next-line @next/next/no-img-element -- out/ 밖의 로컬 파일이라 next/image 로 최적화하지 않는다
          <img src={src} alt={`${hms(sec)} 프레임`} onError={() => setFailed((p) => new Set(p).add(src))}
            className={`ck-review-frame-image ${zoom ? "max-w-none" : "w-full"}`} />
        ) : src ? (
          <div className="grid gap-2 px-6 py-14 text-center text-sm text-ink-400">
            <p className="text-ink-200">{hms(sec)} 의 {fullRes ? "원본 프레임 파일" : "썸네일 칸"}을 불러오지 못했습니다.</p>
            <p className="text-xs">다른 근거 프레임을 선택하거나 위의 ‘이 시점 VOD’에서 확인하세요.</p>
            {vod && <details className="text-xs"><summary className="cursor-pointer">프레임 복구 방법</summary><code className="mt-2 block rounded bg-ink-800 px-2 py-1">npm run ck:probe -- --vod {vod} --at {sec}</code></details>}
          </div>
        ) : <p className="px-4 py-16 text-center text-sm text-ink-400">{emptyText}</p>}
      </div>

      {(evidence.length > 0 || vod) && (
        <footer className="grid gap-2 border-t border-ink-800 px-4 py-2 text-xs text-ink-400">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => move(-1)} className="rounded border border-ink-700 px-2 py-1 text-ink-200 hover:border-accent-400">← {step <= 0 ? `이전 ${STEP_LABEL[step]}` : `${STEP_LABEL[step]} 전`}</button>
            <button type="button" onClick={() => move(1)} className="rounded border border-ink-700 px-2 py-1 text-ink-200 hover:border-accent-400">{step <= 0 ? `다음 ${STEP_LABEL[step]}` : `${STEP_LABEL[step]} 후`} →</button>
            <button type="button" onClick={() => setView(null)} disabled={view == null} className="rounded border border-ink-700 px-2 py-1 text-ink-400 hover:text-ink-200 disabled:opacity-40">근거로</button>
            <span className="ml-auto flex flex-wrap items-center gap-1 text-[11px]">
              간격
              {STEPS.map((n) => (
                <button key={n} type="button" onClick={() => setStepPick(n)}
                  disabled={(n === -1 && !evidence.length) || (n > 0 && !cellsOk) || (n === 0 && !originals.length)}
                  className={`rounded border px-1.5 py-0.5 disabled:opacity-30 ${n === step ? "border-accent-600 text-accent-400" : "border-ink-700 hover:text-ink-200"}`}>{STEP_LABEL[n]}</button>
              ))}
            </span>
          </div>
          {strip.length > 0 && (
            <div ref={stripRef} className="flex gap-1.5 overflow-x-auto pb-1" aria-label="앞뒤 프레임">
              {strip.map((s) => (
                <button key={s.key} type="button" data-current={s.current} onClick={s.onClick} title={hms(s.sec)}
                  className={`relative shrink-0 overflow-hidden rounded border ${s.current ? "border-accent-600" : s.star ? "border-amber-400/60" : "border-ink-700 hover:border-ink-500"}`}>
                  {failed.has(s.src)
                    ? <span className="grid h-[68px] w-[120px] place-items-center bg-ink-900 text-[10px] text-ink-500">없음</span>
                    // eslint-disable-next-line @next/next/no-img-element -- 로컬 파일
                    : <img src={s.src} alt="" loading="lazy" onError={() => setFailed((p) => new Set(p).add(s.src))} className="block h-[68px] w-[120px] object-cover" />}
                  <span className="absolute inset-x-0 bottom-0 bg-ink-950/80 px-1 text-center font-mono text-[10px] text-ink-200">{s.star ? "★ " : ""}{s.label}</span>
                </button>
              ))}
            </div>
          )}
          {step > 0 && !cellsOk && <p className="text-[11px] text-amber-400">미리보기가 없습니다. 원본이나 근거 프레임을 선택하세요.</p>}
          {onEvidence && ev!.observed && (
            <div className="grid gap-1">
              <p className="text-[13px] text-ink-200"><b className="text-ink-400">근거 내용</b> — {ev!.observed}</p>
              {ev!.why && <p className="text-ink-400">판단: {ev!.why}</p>}
            </div>
          )}
          <details className="text-[11px]"><summary className="cursor-pointer">프레임 조작 도움말</summary>
            <p className="mt-1">← →로 이동합니다. 닉네임·점수는 원본 크기로 확인하세요. ‘원본’은 저장된 원본 프레임만 표시합니다.</p>
          </details>
        </footer>
      )}
    </section>
  );
}
