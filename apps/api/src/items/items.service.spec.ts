import { jest } from '@jest/globals';
import {
  DEFAULT_PROJECT_SETTINGS,
  permissionsFor,
  type ProjectRole,
  Visibility,
} from '@kloister/shared';
import { fakeAudit, makeProject, makeUser } from '../../test/support/fakes.js';
import type { ApiException } from '../common/api-exception.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { type ProjectAccess, ProjectAccessService } from '../projects/project-access.service.js';
import type { ListItemsQueryDto } from './items.dto.js';
import { ItemsService } from './items.service.js';

// Database-free checks that every item query carries the caller's visibility
// filter (SPEC §3.3, §3.4) and that permission refusals happen before any
// write. Full flows run against Postgres in test/db/items.db-spec.ts.

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const TEAM = '66666666-6666-4666-8666-666666666666';

type Fn = jest.Mock<(...args: unknown[]) => Promise<unknown>>;
const fn = (): Fn => jest.fn<(...args: unknown[]) => Promise<unknown>>();

/**
 * Builds the service over a fake Prisma whose item queries return nothing.
 *
 * @returns The service and the fake.
 */
function setup() {
  const fake = {
    workItem: { findFirst: fn(), findMany: fn(), create: fn(), update: fn(), deleteMany: fn() },
    project: { update: fn(), findUniqueOrThrow: fn() },
    $transaction: fn(),
  };
  fake.workItem.findFirst.mockResolvedValue(null);
  fake.workItem.findMany.mockResolvedValue([]);
  fake.$transaction.mockImplementation((callback: unknown) =>
    (callback as (tx: typeof fake) => Promise<unknown>)(fake),
  );
  const prisma = fake as unknown as PrismaService;
  const audit = fakeAudit();
  const access = new ProjectAccessService(prisma, audit.service);
  return { service: new ItemsService(prisma, audit.service, access), fake };
}

/**
 * Builds a caller's access directly.
 *
 * @param role Project role.
 * @param visibility Effective visibility.
 * @param teams The caller's teams.
 * @returns The access.
 */
function accessFor(
  role: ProjectRole,
  visibility: Visibility = Visibility.ALL,
  teams: ProjectAccess['teams'] = [],
): ProjectAccess {
  return {
    project: makeProject({ id: PROJECT_ID }),
    settings: DEFAULT_PROJECT_SETTINGS,
    userId: ME,
    role,
    isSystemAdmin: false,
    visibility,
    allowedBucketIds: [],
    teams,
    permissions: new Set(permissionsFor(role, DEFAULT_PROJECT_SETTINGS)),
  };
}

/**
 * Awaits a promise expected to reject with an ApiException.
 *
 * @param promise The call.
 * @returns Status and code.
 */
async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as ApiException;
    return { status: e.getStatus(), code: (e.getResponse() as { code: string }).code };
  }
  throw new Error('expected rejection');
}

const OWN_FILTER = { OR: [{ createdById: ME }, { assignees: { some: { userId: ME } } }] };

describe('ItemsService', () => {
  it('answers 404 for malformed item refs without querying', async () => {
    const { service, fake } = setup();
    for (const ref of ['abc', '0', 'KLO-1']) {
      expect(await rejection(service.get(accessFor('PM'), ref))).toEqual({
        status: 404,
        code: 'NOT_FOUND',
      });
    }
    expect(fake.workItem.findFirst).not.toHaveBeenCalled();
  });

  it('looks items up through the scope filter and answers 404 when it hides them', async () => {
    const { service, fake } = setup();
    const access = accessFor('MEMBER', Visibility.OWN);
    expect(await rejection(service.get(access, '7'))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(fake.workItem.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { AND: [{ projectId: PROJECT_ID }, OWN_FILTER, { number: 7 }] },
    });
  });

  it('applies the scope filter, widened by led teams, to list queries', async () => {
    const { service, fake } = setup();
    const access = accessFor('MEMBER', Visibility.OWN, [{ teamId: TEAM, role: 'LEAD' }]);
    const query: ListItemsQueryDto = { sprintId: 'none', type: 'TASK' };
    await service.list(access, query);
    const where = (fake.workItem.findMany.mock.calls[0]?.[0] as { where: { AND: unknown[] } })
      .where;
    expect(where.AND[0]).toEqual({ projectId: PROJECT_ID });
    expect(where.AND[1]).toEqual({ OR: [OWN_FILTER, { teamId: { in: [TEAM] } }] });
    expect(where.AND[2]).toMatchObject({ sprintId: null, type: 'TASK' });
  });

  it('applies the scope filter to child lists after finding the parent', async () => {
    const { service, fake } = setup();
    expect(
      await rejection(service.children(accessFor('VIEWER', Visibility.TEAMS), '3', {})),
    ).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(fake.workItem.findFirst.mock.calls[0]?.[0]).toMatchObject({
      where: { AND: [{ projectId: PROJECT_ID }, { teamId: { in: [] } }, { number: 3 }] },
    });
  });

  it('refuses assigning others before touching the database', async () => {
    const { service, fake } = setup();
    const auth = { user: makeUser({ id: ME }), sessionId: 's' };
    const res = await rejection(
      service.create(auth, accessFor('MEMBER'), {
        type: 'TASK',
        title: 'x',
        assigneeIds: [OTHER],
      }),
    );
    expect(res).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(fake.$transaction).not.toHaveBeenCalled();
  });

  it('refuses putting an item into a team the caller does not belong to', async () => {
    const { service, fake } = setup();
    const auth = { user: makeUser({ id: ME }), sessionId: 's' };
    const res = await rejection(
      service.create(auth, accessFor('MEMBER'), { type: 'TASK', title: 'x', teamId: TEAM }),
    );
    expect(res).toEqual({ status: 403, code: 'FORBIDDEN' });
    expect(fake.$transaction).not.toHaveBeenCalled();
  });
});
