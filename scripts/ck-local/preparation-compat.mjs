/** A verified, one-release alias. Any later code/model change invalidates it. */
export function compatiblePreparation(previous, current, migration) {
  return previous === current || Boolean(migration
    && migration.verified_result_equivalence === true
    && migration.current === current && migration.previous === previous);
}
