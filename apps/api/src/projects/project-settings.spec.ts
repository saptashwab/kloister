import { mergeProjectSettings, parseProjectSettings, withoutBucket } from './project-settings.js';

const BUCKET_A = '44444444-4444-4444-8444-444444444444';
const BUCKET_B = '55555555-5555-4555-8555-555555555555';

describe('project settings', () => {
  it('defaults everything for empty or malformed JSON', () => {
    for (const raw of [null, [], 'x', {}, { statusToBucket: [] }]) {
      expect(parseProjectSettings(raw)).toEqual({
        membersCanAssignOthers: false,
        statusToBucket: {},
        labelStyle: 'SOLID',
        autoMoveDependents: false,
        useInstanceHolidays: true,
        holidaysReviewedAt: null,
        planLeadsOnly: true,
      });
    }
  });

  it('reads automatic moving only when it is a boolean (M9)', () => {
    expect(parseProjectSettings({ autoMoveDependents: true }).autoMoveDependents).toBe(true);
    expect(parseProjectSettings({ autoMoveDependents: 'yes' }).autoMoveDependents).toBe(false);
  });

  it('keeps the schedule to PMs and Leads unless explicitly off (M9.2)', () => {
    expect(parseProjectSettings({ planLeadsOnly: false }).planLeadsOnly).toBe(false);
    expect(parseProjectSettings({ planLeadsOnly: 'no' }).planLeadsOnly).toBe(true);
  });

  it('reads a known label style and defaults an unknown one', () => {
    expect(parseProjectSettings({ labelStyle: 'COVER' }).labelStyle).toBe('COVER');
    expect(parseProjectSettings({ labelStyle: 'tinted' }).labelStyle).toBe('SOLID');
    expect(parseProjectSettings({ labelStyle: 3 }).labelStyle).toBe('SOLID');
  });

  it('keeps only well-formed statusToBucket entries', () => {
    expect(
      parseProjectSettings({
        statusToBucket: {
          DONE: BUCKET_A.toUpperCase(),
          IN_PROGRESS: 'not-a-uuid',
          LATER: BUCKET_B,
          BLOCKED: 7,
        },
      }).statusToBucket,
    ).toEqual({ DONE: BUCKET_A });
  });

  it('merges changes and keeps unknown keys', () => {
    expect(
      mergeProjectSettings(
        { ado: { area: 'x' }, membersCanAssignOthers: true },
        {
          statusToBucket: { DONE: BUCKET_A },
        },
      ),
    ).toEqual({
      ado: { area: 'x' },
      membersCanAssignOthers: true,
      statusToBucket: { DONE: BUCKET_A },
    });
  });

  it('drops a deleted bucket from the map', () => {
    const raw = { ado: 1, statusToBucket: { DONE: BUCKET_A, BLOCKED: BUCKET_B } };
    expect(withoutBucket(raw, BUCKET_A)).toEqual({ ado: 1, statusToBucket: { BLOCKED: BUCKET_B } });
    expect(withoutBucket(raw, '66666666-6666-4666-8666-666666666666')).toBeNull();
  });
});
