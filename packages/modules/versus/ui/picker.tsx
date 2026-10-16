"use client";

import { RecordSearch, type RecordSearchOption } from "../../../ui/record-search.tsx";
import { versusHref } from "./paths.ts";
export type PickerOption = RecordSearchOption;

export function VersusPicker({ options, a, b, scope }: {
  options: PickerOption[]; a?: string; b?: string; scope?: { map?: string; format?: string; year?: number };
}) {
  return <RecordSearch options={options} a={a} b={b} mode="versus" versusPath={versusHref()} scope={scope} />;
}
