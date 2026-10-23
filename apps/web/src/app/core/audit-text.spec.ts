import { auditDetails } from './audit-text';

describe('auditDetails (M8.5)', () => {
  it('shows changed fields, known keys and other keys in words', () => {
    expect(
      auditDetails({
        changes: { title: { from: 'Old', to: 'New' }, dueTime: { from: null, to: '17:00' } },
        via: 'GET /api/v1/projects/:id',
        sessionId: '12345678-aaaa-4bbb-8ccc-1234567890ab',
        userId: 'hidden',
        allowedBucketIds: [],
        otherSessionsEnded: true,
      }),
    ).toEqual([
      { label: 'Changed title', value: 'Old → New' },
      { label: 'Changed due time', value: '— → 17:00' },
      { label: 'Request', value: 'GET /api/v1/projects/:id' },
      { label: 'Session', value: '12345678…' },
      { label: 'Allowed bucket ids', value: '—' },
      { label: 'Other sessions ended', value: 'Yes' },
    ]);
  });
});
