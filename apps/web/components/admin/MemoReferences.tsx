"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import type { MemoGroup, MemoReferences as References, MemoVerdict } from "@/lib/ck-memo";
import { markMemo } from "@/app/admin/ck/memo/actions";

const frame = (path: string) => `/admin/ck/frame/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Viewing a memo never goes through evidence linking or review-completion actions. */
export function useMemoReferences(vodUrl?: string | null) {
  const vod = vodUrl?.match(/\/player\/(\d{1,12})(?:[/?#]|$)/)?.[1];
  const [data, setData] = useState<References | null>(null);
  const [picked, setPicked] = useState<MemoGroup | null>(null);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const [loadedImage, setLoadedImage] = useState("");
  const [saving, startSaving] = useTransition();
  const [message, setMessage] = useState("");
  useEffect(() => {
    setData(null); setPicked(null);
    if (!vod) return;
    const abort = new AbortController();
    fetch(`/admin/ck/memo/${vod}`, { signal: abort.signal, cache: "no-store" })
      .then(r => r.ok ? r.json() as Promise<References> : null)
      .then(result => { if (!abort.signal.aborted) setData(result); })
      .catch(() => { /* Optional local references must not block match review. */ });
    return () => abort.abort();
  }, [vod]);
  useEffect(() => { setFailed(false); setMessage(""); }, [picked, index]);
  const at = picked?.frames[index]?.at ?? 0;
  const mark = (label: MemoVerdict) => startSaving(async () => {
    if (!data || !vod) return;
    try {
      const result = await markMemo({ vod, at, label, model: data.model_sha256, source: data.source_sha256 });
      if (result.ok) {
        setData(previous => previous?.source_sha256 === data.source_sha256
          ? { ...previous, feedback: { ...previous.feedback, [String(at)]: label } } : previous);
        setMessage("이 화면의 학습용 표시를 저장했습니다.");
      } else setMessage(result.message);
    } catch { setMessage("표시를 저장하지 못했습니다. 연결을 확인하고 다시 눌러 주세요."); }
  });
  const representative = picked?.representative_at === at;
  const image = picked ? representative
    ? frame(picked.original ?? picked.thumbnail)
    : `/admin/ck/cell/${vod}/${Math.ceil(at)}` : "";
  const open = (group: MemoGroup) => {
    setIndex(group.frames.findIndex(f => f.at === group.representative_at));
    setPicked(group);
  };
  const frameCount = picked?.frames.length ?? 1;
  const step = useCallback((direction: number) => setIndex(i => Math.max(0, Math.min(frameCount - 1, i + direction))), [frameCount]);
  return { data, picked, index, at, image, representative, failed, loadedImage, saving, message,
    active: Boolean(picked && data && vod), open, clear: () => setPicked(null),
    setIndex, mark, setLoadedImage, setFailed, step };
}

export type MemoReferenceState = ReturnType<typeof useMemoReferences>;

export function MemoReferenceControls({ memo }: { memo: MemoReferenceState }) {
  const { picked, data, index, at, representative, image } = memo;
  if (!memo.active || !picked || !data) return null;
  return <div className="ck-memo-inline" aria-label="메모장 참고 화면">
    <div className="ck-memo-controls">
      <button type="button" disabled={index === 0} onClick={() => memo.step(-1)}>이전</button>
      <input aria-label="메모장 후보 시점" type="range" min={0} max={picked.frames.length - 1} value={index} onChange={e => memo.setIndex(Number(e.target.value))} />
      <button type="button" disabled={index === picked.frames.length - 1} onClick={() => memo.step(1)}>다음</button>
      <span>{index + 1}/{picked.frames.length}</span>
    </div>
    <div className="flex items-center justify-between gap-2">
      <span>{representative && picked.original ? "보관된 원본" : "썸네일"}</span>
      <button type="button" onClick={memo.clear}>경기 프레임으로 돌아가기</button>
    </div>
    <div className="ck-memo-controls" aria-label="이 화면의 메모장 여부">
      {([["memo", "메모장 맞음"], ["not_memo", "메모장 아님"], ["unknown", "모르겠음"]] as const).map(([label, title]) =>
        <button type="button" key={label} disabled={memo.saving || memo.failed || memo.loadedImage !== image}
          aria-pressed={data.feedback[String(at)] === label} onClick={() => memo.mark(label)}>{title}</button>)}
    </div>
    <p role="status">{memo.message || "현재 화면 한 장에만 표시합니다. 경기 검수 상태는 바뀌지 않습니다."}</p>
  </div>;
}
