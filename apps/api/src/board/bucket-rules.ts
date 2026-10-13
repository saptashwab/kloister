import { BucketRule, ItemStatus } from '@kloister/shared';
import { invalidField } from '../common/api-exception.js';

/** A bucket's entry rule (SPEC §4.2). */
export interface EntryRule {
  /** What entering the bucket does. */
  onEnterMode: BucketRule;
  /** The status it sets; null for `NONE`. */
  onEnterStatus: ItemStatus | null;
}

/**
 * Works out a bucket's entry rule after a create or update, and validates
 * it: `SET` and `SET_IF_NOT_STARTED` need a status, `NONE` takes none.
 * Switching to `NONE` without naming a status clears the stored one.
 *
 * @param current The stored rule (defaults for a new bucket).
 * @param change Requested mode and status; undefined keeps the current value.
 * @param change.onEnterMode Requested mode.
 * @param change.onEnterStatus Requested status, or null to clear it.
 * @returns The rule to store.
 * @throws 400 `VALIDATION_FAILED` for an inconsistent rule.
 */
export function resolveEntryRule(
  current: EntryRule,
  change: { onEnterMode?: BucketRule; onEnterStatus?: ItemStatus | null },
): EntryRule {
  const onEnterMode = change.onEnterMode ?? current.onEnterMode;
  let onEnterStatus =
    change.onEnterStatus === undefined ? current.onEnterStatus : change.onEnterStatus;
  if (onEnterMode === BucketRule.NONE) {
    if (change.onEnterStatus !== undefined && change.onEnterStatus !== null) {
      throw invalidField('onEnterStatus', 'A bucket without a rule cannot set a status');
    }
    onEnterStatus = null;
  } else if (onEnterStatus === null) {
    throw invalidField('onEnterStatus', 'This rule needs the status it sets');
  }
  return { onEnterMode, onEnterStatus };
}

/**
 * The status a card gets when it is moved into a bucket (SPEC §4.2):
 * `NONE` keeps it, `SET` sets the rule's status, `SET_IF_NOT_STARTED` sets
 * it only when the card has not started yet.
 *
 * @param rule The target bucket's rule.
 * @param status The card's current status.
 * @returns The resulting status.
 */
export function statusOnEnter(rule: EntryRule, status: ItemStatus): ItemStatus {
  if (rule.onEnterStatus === null) return status;
  switch (rule.onEnterMode) {
    case BucketRule.NONE:
      return status;
    case BucketRule.SET:
      return rule.onEnterStatus;
    case BucketRule.SET_IF_NOT_STARTED:
      return status === ItemStatus.NOT_STARTED ? rule.onEnterStatus : status;
  }
}
