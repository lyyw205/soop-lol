"use client";

import { RecordSearch, type RecordSearchOption } from "../../../ui/record-search.tsx";
import { versusHref } from "./paths.ts";
export type PickerOption = RecordSearchOption;

export function VersusPicker({ options, a, b, category, year }: {
  options: PickerOption[]; a?: string; b?: string; category?: string; year?: number;
}) {
  return <RecordSearch options={options} a={a} b={b} mode="versus" versusPath={versusHref()} category={category} year={year} />;
}
