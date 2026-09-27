import { toKstInputValue } from '@soop-lol/core/lib/time';
import type { ActionState } from './action-state';

/** CK 폼이 편집을 시작할 때 본 값. DB 값과 입력값의 왕복에 같은 매퍼를 쓴다. */
export type CkFormValues = Record<string, string>;
export interface CkActionState extends ActionState {
  saved?: CkFormValues;
  latest?: CkFormValues;
  conflict?: { field: string; mine: unknown; theirs: unknown };
}
export const META_FORM_FIELDS = ['winning_team','event_id','series_id','series_game_no','best_of','best_of_evidence','game_creation','game_duration','game_creation_precision','set_order_known'] as const;
export const PARTICIPANT_FORM_FIELDS = ['streamer_id','puuid','observed_name','team_id','team_position','champion_id','champion_name','kills','deaths','assists'] as const;
function strings(value: object, fields: readonly string[]): CkFormValues {
  const row = value as Record<string, unknown>;
  return Object.fromEntries(fields.map(k => [k, row[k] == null ? '' : String(row[k])]));
}
export function metaFormValues(value: object): CkFormValues {
  const result = strings(value, META_FORM_FIELDS);
  const date = (value as { game_creation: Date | string }).game_creation;
  result.game_creation = date instanceof Date ? toKstInputValue(date) : date;
  return result;
}
export function participantFormValues(value: object, slug: string): CkFormValues {
  return { ...strings(value, PARTICIPANT_FORM_FIELDS), streamer_slug: slug, clear_puuid: '' };
}
