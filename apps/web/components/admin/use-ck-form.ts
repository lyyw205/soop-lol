'use client';
import { useActionState, useRef, useState } from 'react';
import type { CkActionState, CkFormValues } from '@/lib/ck-review-form';

/** props가 갱신돼도 편집 기준을 바꾸지 않는다. 성공/명시적 불러오기만 새 기준을 채택한다. */
export function useCkForm(initial: CkFormValues, save: (prev: CkActionState, form: FormData) => Promise<CkActionState>) {
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const submitting = useRef(false);
  const [state, action, pending] = useActionState(async (prev: CkActionState, form: FormData) => {
    if (submitting.current) return prev;
    submitting.current = true;
    try {
      const result = await save(prev, form);
      if (result.ok && result.saved) { setBase(result.saved); setDraft(result.saved); }
      return result;
    } finally { submitting.current = false; }
  }, { ok: true, message: '' });
  const field = (name: string) => ({
    value: draft[name] ?? '',
    onChange: (event: { target: { value: string } }) => setDraft(old => ({ ...old, [name]: event.target.value })),
  });
  const reload = () => {
    const next = state.latest ?? initial;
    setBase(next); setDraft(next);
  };
  return { base, draft, setDraft, field, state, action, pending, reload };
}
