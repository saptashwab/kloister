import { mergeProjectSettings, parseProjectSettings, withoutBucket } from './project-settings.js';

const BUCKET_A = '44444444-4444-4444-8444-444444444444';
const BUCKET_B = '55555555-5555-4555-8555-555555555555';

describe('project settings', () => {
  it('defaults everything for empty or malformed JSON', () => {
    for (const raw of [null, [], 'x', {}, { statusToBucket: [] }]) {
      expect(parseProjectSettings(raw)).toEqual({
        membersCanAssignOthers: false,
        statusToBucket: {},
      });
    }
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
