import { BadRequestException, ForbiddenException, HttpStatus } from '@nestjs/common';
import { ErrorCode } from '@kloister/shared';
import { toErrorResponse } from './all-exceptions.filter.js';
import { ApiException } from './api-exception.js';
import { toPage, pageArgs } from './pagination.js';
import { flattenValidationErrors } from './validation.js';

describe('toErrorResponse', () => {
  it('passes ApiException bodies through', () => {
    const e = new ApiException(HttpStatus.CONFLICT, ErrorCode.LAST_ADMIN, 'nope', { a: 1 });
    expect(toErrorResponse(e)).toEqual({
      status: 409,
      body: { code: ErrorCode.LAST_ADMIN, message: 'nope', details: { a: 1 } },
    });
  });

  it('maps plain Nest exceptions by status', () => {
    expect(toErrorResponse(new ForbiddenException('no')).body.code).toBe(ErrorCode.FORBIDDEN);
    expect(toErrorResponse(new BadRequestException('bad')).body.code).toBe(
      ErrorCode.VALIDATION_FAILED,
    );
  });

  it('maps Fastify 4xx errors', () => {
    const e = Object.assign(new Error('Body is too large'), { statusCode: 413 });
    expect(toErrorResponse(e)).toEqual({
      status: 413,
      body: { code: ErrorCode.VALIDATION_FAILED, message: 'Body is too large' },
    });
  });

  it('hides details of unexpected errors', () => {
    expect(toErrorResponse(new Error('connection string leaked'))).toEqual({
      status: 500,
      body: { code: ErrorCode.INTERNAL, message: 'Internal server error' },
    });
  });
});

describe('pagination helpers', () => {
  it('fetches one extra row and skips the cursor row', () => {
    expect(pageArgs({})).toEqual({ take: 51 });
    expect(pageArgs({ limit: 2, cursor: 'c' })).toEqual({ take: 3, cursor: { id: 'c' }, skip: 1 });
  });

  it('sets nextCursor only when more rows exist', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(toPage(rows, { limit: 2 }, (r) => r.id)).toEqual({ items: ['a', 'b'], nextCursor: 'b' });
    expect(toPage(rows, { limit: 3 }, (r) => r.id)).toEqual({
      items: ['a', 'b', 'c'],
      nextCursor: null,
    });
  });
});

describe('flattenValidationErrors', () => {
  it('flattens nested errors into dotted paths', () => {
    expect(
      flattenValidationErrors([
        {
          property: 'a',
          constraints: { isString: 'a must be a string' },
          children: [{ property: 'b', constraints: { min: 'too small' }, children: [] }],
        },
      ]),
    ).toEqual([
      { field: 'a', messages: ['a must be a string'] },
      { field: 'a.b', messages: ['too small'] },
    ]);
  });
});
