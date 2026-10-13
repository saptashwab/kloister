import {
  ItemStatus,
  ItemType,
  BucketRule,
  isAllowedParent,
  requiresBucket,
} from '@kloister/shared';
import type { ApiException } from '../common/api-exception.js';
import { resolveEntryRule, statusOnEnter } from '../board/bucket-rules.js';
import { assertChildrenFit, assertParentType, closesCycle, parseItemRef } from './hierarchy.js';

// Hierarchy rules (SPEC §4.1) and bucket entry rules (SPEC §4.2). The
// expected tables are transcribed from SPEC.md, independently of the shared
// constants the implementation uses.

const TYPES = Object.values(ItemType);

/** SPEC §4.1: FEATURE→EPIC; STORY→FEATURE; TASK→STORY|FEATURE; BUG→STORY|FEATURE. */
const SPEC_PARENTS: Record<ItemType, ItemType[]> = {
  EPIC: [],
  FEATURE: ['EPIC'],
  STORY: ['FEATURE'],
  TASK: ['STORY', 'FEATURE'],
  BUG: ['STORY', 'FEATURE'],
};

/**
 * Runs a call expected to throw an ApiException.
 *
 * @param call The call.
 * @returns Status and the first detail field.
 */
function thrown(call: () => void) {
  try {
    call();
  } catch (error) {
    const e = error as ApiException;
    const body = e.getResponse() as { code: string; details?: { field: string }[] };
    return { status: e.getStatus(), code: body.code, field: body.details?.[0]?.field };
  }
  throw new Error('expected throw');
}

describe('hierarchy (SPEC §4.1)', () => {
  for (const child of TYPES) {
    for (const parent of TYPES) {
      const allowed = SPEC_PARENTS[child].includes(parent);
      it(`${child} under ${parent}: ${allowed ? 'allowed' : 'rejected'}`, () => {
        expect(isAllowedParent(child, parent)).toBe(allowed);
        if (allowed) {
          expect(() => assertParentType(child, parent)).not.toThrow();
        } else {
          expect(thrown(() => assertParentType(child, parent))).toEqual({
            status: 400,
            code: 'VALIDATION_FAILED',
            field: 'parentId',
          });
        }
      });
    }
  }

  it('rejects a type change that no longer fits the children', () => {
    expect(() =>
      assertChildrenFit(ItemType.FEATURE, [ItemType.STORY, ItemType.TASK]),
    ).not.toThrow();
    expect(thrown(() => assertChildrenFit(ItemType.STORY, [ItemType.STORY]))).toMatchObject({
      status: 400,
      field: 'type',
    });
    expect(() => assertChildrenFit(ItemType.TASK, [])).not.toThrow();
  });

  it('detects cycles through the parent chain', () => {
    expect(closesCycle('a', ['b', 'c'])).toBe(false);
    expect(closesCycle('a', ['a'])).toBe(true);
    expect(closesCycle('a', ['b', 'a'])).toBe(true);
  });

  it('requires a bucket for Stories, Tasks and Bugs only (SPEC §4)', () => {
    expect(TYPES.filter(requiresBucket).sort()).toEqual(['BUG', 'STORY', 'TASK']);
  });

  it('parses item refs as uuid or number', () => {
    expect(parseItemRef('42')).toEqual({ number: 42 });
    expect(parseItemRef('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA')).toEqual({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    for (const bad of ['0', '-1', '01', '1.5', 'KLO-1', '', '1234567890']) {
      expect(parseItemRef(bad)).toBeNull();
    }
  });
});

describe('bucket entry rules (SPEC §4.2)', () => {
  const S = ItemStatus;
  it.each([
    [BucketRule.NONE, null, S.NOT_STARTED, S.NOT_STARTED],
    [BucketRule.NONE, null, S.BLOCKED, S.BLOCKED],
    [BucketRule.SET, S.DONE, S.NOT_STARTED, S.DONE],
    [BucketRule.SET, S.DONE, S.IN_PROGRESS, S.DONE],
    [BucketRule.SET, S.IN_PROGRESS, S.DONE, S.IN_PROGRESS],
    [BucketRule.SET_IF_NOT_STARTED, S.IN_PROGRESS, S.NOT_STARTED, S.IN_PROGRESS],
    [BucketRule.SET_IF_NOT_STARTED, S.IN_PROGRESS, S.BLOCKED, S.BLOCKED],
    [BucketRule.SET_IF_NOT_STARTED, S.IN_PROGRESS, S.DONE, S.DONE],
  ] as const)('%s → %s turns %s into %s', (mode, ruleStatus, from, to) => {
    expect(statusOnEnter({ onEnterMode: mode, onEnterStatus: ruleStatus }, from)).toBe(to);
  });

  const none = { onEnterMode: BucketRule.NONE, onEnterStatus: null };

  it('validates rules on create and update', () => {
    expect(resolveEntryRule(none, {})).toEqual(none);
    expect(resolveEntryRule(none, { onEnterMode: BucketRule.SET, onEnterStatus: S.DONE })).toEqual({
      onEnterMode: BucketRule.SET,
      onEnterStatus: S.DONE,
    });
    expect(thrown(() => resolveEntryRule(none, { onEnterMode: BucketRule.SET }))).toMatchObject({
      status: 400,
      field: 'onEnterStatus',
    });
    expect(thrown(() => resolveEntryRule(none, { onEnterStatus: S.DONE }))).toMatchObject({
      status: 400,
    });
  });

  it('keeps the stored status when only the mode changes, and clears it for NONE', () => {
    const set = { onEnterMode: BucketRule.SET, onEnterStatus: S.DONE };
    expect(resolveEntryRule(set, { onEnterMode: BucketRule.SET_IF_NOT_STARTED })).toEqual({
      onEnterMode: BucketRule.SET_IF_NOT_STARTED,
      onEnterStatus: S.DONE,
    });
    expect(resolveEntryRule(set, { onEnterMode: BucketRule.NONE })).toEqual(none);
    expect(thrown(() => resolveEntryRule(set, { onEnterStatus: null }))).toMatchObject({
      status: 400,
    });
  });
});
