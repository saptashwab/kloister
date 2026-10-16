import { ErrorCode } from '@kloister/shared';
import { ApiException } from './api-exception.js';
import { mapTransactionConflict } from './prisma-errors.js';

describe('transaction conflict errors', () => {
  it.each(['40001', '40P01'])(
    'maps raw PostgreSQL %s from the driver adapter to 409',
    (sqlState) => {
      const error = Object.assign(new Error('raw query failed'), {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: sqlState } } },
      });
      const mapped = mapTransactionConflict(error);
      expect(mapped).toBeInstanceOf(ApiException);
      expect((mapped as ApiException).getStatus()).toBe(409);
      expect((mapped as ApiException).getResponse()).toMatchObject({ code: ErrorCode.CONFLICT });
    },
  );

  it.each(['40001', '40P01'])('maps raw PostgreSQL %s from legacy metadata to 409', (code) => {
    const mapped = mapTransactionConflict({ code: 'P2010', meta: { code } });
    expect(mapped).toBeInstanceOf(ApiException);
    expect((mapped as ApiException).getStatus()).toBe(409);
  });

  it('keeps ordinary Prisma serialization conflicts retryable', () => {
    const mapped = mapTransactionConflict({ code: 'P2034' });
    expect(mapped).toBeInstanceOf(ApiException);
    expect((mapped as ApiException).getStatus()).toBe(409);
  });

  it.each([
    undefined,
    null,
    new Error('unrelated failure'),
    { code: 'P2010' },
    { code: 'P2010', meta: { code: '42601' } },
    { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '23505' } } } },
    { code: 'P2003', meta: { code: '40001' } },
  ])('preserves unrelated errors unchanged (%j)', (error) => {
    expect(mapTransactionConflict(error)).toBe(error);
  });
});
