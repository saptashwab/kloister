import { AuditAction, ErrorCode, ProjectPermission, type ProjectRole } from '@kloister/shared';
import { fakeAudit, fakePrisma, makeProject, makeUser } from '../../test/support/fakes.js';
import type { ApiException } from '../common/api-exception.js';
import {
  type ItemFacts,
  type ProjectAccess,
  ProjectAccessService,
  parseProjectRef,
} from './project-access.service.js';

// Full permission matrix (SPEC §3.2, §3.3, §3.4). The expected table below is
// transcribed from SPEC.md independently of the implementation's own table,
// so a drift in either is caught.

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const BUCKET_A = '44444444-4444-4444-8444-444444444444';
const BUCKET_B = '55555555-5555-4555-8555-555555555555';

type Cell = boolean | 'setting';
const ROLES = ['PM', 'LEAD', 'MEMBER', 'VIEWER'] as const;

/** SPEC §3.2, one row per line: PM, Lead, Member, Viewer. */
const SPEC_TABLE: [ProjectPermission, Cell, Cell, Cell, Cell][] = [
  [ProjectPermission.VIEW_ITEMS, true, true, true, true],
  [ProjectPermission.CREATE_ITEMS, true, true, true, false],
  [ProjectPermission.EDIT_ANY_ITEM, true, true, false, false],
  [ProjectPermission.EDIT_OWN_ITEMS, true, true, true, false],
  [ProjectPermission.ASSIGN_OTHERS, true, true, 'setting', false],
  [ProjectPermission.MOVE_ANY_ITEM, true, true, false, false],
  [ProjectPermission.MOVE_OWN_ITEMS, true, true, true, false],
  [ProjectPermission.DELETE_ANY_ITEM, true, true, false, false],
  [ProjectPermission.DELETE_OWN_ITEMS, true, true, true, false],
  [ProjectPermission.ANNOTATE_ITEMS, true, true, true, false],
  [ProjectPermission.MANAGE_BOARD, true, true, false, false],
  [ProjectPermission.MANAGE_MEMBERS, true, false, false, false],
  [ProjectPermission.MANAGE_PROJECT, true, false, false, false],
  [ProjectPermission.EXPORT_ADO, true, true, false, false],
];

/**
 * Builds a fake membership row for the access resolver.
 *
 * @param role Project role.
 * @param visibility Stored visibility.
 * @param allowedBucketIds Stored bucket list.
 * @returns The row.
 */
function member(role: ProjectRole, visibility = 'ALL', allowedBucketIds: string[] = []) {
  return { id: 'm1', projectId: PROJECT_ID, userId: ME, role, visibility, allowedBucketIds };
}

/**
 * Builds a resolver whose database returns one project with the given
 * membership for the caller.
 *
 * @param members Memberships of the caller (empty for none).
 * @param settings Stored project settings.
 * @param project Overrides for the project row.
 * @returns The service, its captured audit records and the Prisma fake.
 */
function setup(
  members: ReturnType<typeof member>[] = [],
  settings: object = {},
  project: Parameters<typeof makeProject>[0] = {},
) {
  const { fake, prisma } = fakePrisma();
  const audit = fakeAudit();
  fake.project.findUnique.mockResolvedValue({
    ...makeProject({ id: PROJECT_ID, settings, ...project }),
    members,
  });
  return { service: new ProjectAccessService(prisma, audit.service), audit, fake };
}

/**
 * Resolves access for a user with the given system role.
 *
 * @param service The service under test.
 * @param systemRole System role of the caller.
 * @returns The access.
 */
function resolveAs(service: ProjectAccessService, systemRole: 'ADMIN' | 'USER' = 'USER') {
  return service.resolve(
    { user: makeUser({ id: ME, systemRole }), sessionId: 's' },
    PROJECT_ID,
    'GET /test',
  );
}

/**
 * Awaits a promise expected to reject with an ApiException.
 *
 * @param promise The call under test.
 * @returns The exception's status and code.
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

/**
 * Runs a synchronous call expected to throw an ApiException.
 *
 * @param call The call under test.
 * @returns The exception's status and code.
 */
function thrown(call: () => void) {
  try {
    call();
  } catch (error) {
    const e = error as ApiException;
    return { status: e.getStatus(), code: (e.getResponse() as { code: string }).code };
  }
  throw new Error('expected throw');
}

/**
 * Builds item facts.
 *
 * @param overrides Fields to change.
 * @returns The item.
 */
function item(overrides: Partial<ItemFacts> = {}): ItemFacts {
  return {
    createdById: OTHER,
    assigneeIds: [],
    bucketId: BUCKET_A,
    hasChildren: false,
    ...overrides,
  };
}

describe('ProjectAccessService', () => {
  describe('role permission matrix (SPEC §3.2)', () => {
    for (const [permission, ...cells] of SPEC_TABLE) {
      ROLES.forEach((role, index) => {
        const cell = cells[index];
        if (cell === 'setting') {
          it(`${role} ${permission}: follows membersCanAssignOthers`, async () => {
            const off = await resolveAs(setup([member(role)], {}).service);
            expect(off.permissions.has(permission)).toBe(false);
            const on = await resolveAs(
              setup([member(role)], { membersCanAssignOthers: true }).service,
            );
            expect(on.permissions.has(permission)).toBe(true);
          });
        } else {
          it(`${role} ${permission}: ${cell ? 'allowed' : 'denied'}`, async () => {
            // The setting must not widen anyone else's rights.
            const { service } = setup([member(role)], { membersCanAssignOthers: true });
            const access = await resolveAs(service);
            expect(service.has(access, permission)).toBe(cell);
          });
        }
      });
    }

    it('covers every permission name', () => {
      expect(SPEC_TABLE.map(([p]) => p).sort()).toEqual(Object.values(ProjectPermission).sort());
    });

    it('treats a malformed stored setting as off', async () => {
      const access = await resolveAs(
        setup([member('MEMBER')], { membersCanAssignOthers: 'yes' }).service,
      );
      expect(access.permissions.has(ProjectPermission.ASSIGN_OTHERS)).toBe(false);
    });
  });

  describe('resolve', () => {
    it('returns 404 to non-members without revealing the project', async () => {
      const { service, audit } = setup([]);
      expect(await rejection(resolveAs(service))).toEqual({
        status: 404,
        code: ErrorCode.NOT_FOUND,
      });
      expect(audit.records).toHaveLength(0);
    });

    it('returns 404 for unknown projects and malformed references', async () => {
      const { service, fake } = setup();
      fake.project.findUnique.mockResolvedValue(null);
      expect((await rejection(resolveAs(service, 'ADMIN'))).status).toBe(404);
      const auth = { user: makeUser({ systemRole: 'ADMIN' }), sessionId: 's' };
      expect((await rejection(service.resolve(auth, 'not a key!', 'x'))).status).toBe(404);
    });

    it('gives non-member admins read-only access and audits it (SPEC §3.1)', async () => {
      const { service, audit } = setup([]);
      const access = await resolveAs(service, 'ADMIN');
      expect(access.role).toBeNull();
      expect(access.visibility).toBe('ALL');
      expect([...access.permissions]).toEqual([ProjectPermission.VIEW_ITEMS]);
      expect(audit.records).toEqual([
        expect.objectContaining({
          action: AuditAction.ADMIN_CROSS_PROJECT_ACCESS,
          actorId: ME,
          entityId: PROJECT_ID,
          meta: { via: 'GET /test' },
        }),
      ]);
    });

    it('binds admins who are members to their membership, without an audit entry', async () => {
      const { service, audit } = setup([member('VIEWER', 'OWN')]);
      const access = await resolveAs(service, 'ADMIN');
      expect(access.role).toBe('VIEWER');
      expect(access.visibility).toBe('OWN');
      expect(audit.records).toHaveLength(0);
    });

    it('forces ALL visibility for PM and Lead whatever is stored (SPEC §3.3)', async () => {
      for (const role of ['PM', 'LEAD'] as const) {
        const access = await resolveAs(setup([member(role, 'OWN', [BUCKET_A])]).service);
        expect(access.visibility).toBe('ALL');
        expect(access.allowedBucketIds).toEqual([]);
      }
    });

    it('looks projects up by uuid or case-insensitive key', () => {
      expect(parseProjectRef(PROJECT_ID.toUpperCase())).toEqual({ id: PROJECT_ID });
      expect(parseProjectRef('klo')).toEqual({ key: 'KLO' });
      expect(parseProjectRef('K')).toBeNull();
      expect(parseProjectRef('TOOLONGKEY')).toBeNull();
      expect(parseProjectRef('KL0')).toBeNull();
    });
  });

  describe('assert', () => {
    it('answers 403 when the role lacks the permission', async () => {
      const { service } = setup([member('LEAD')]);
      const access = await resolveAs(service);
      expect(thrown(() => service.assert(access, ProjectPermission.MANAGE_MEMBERS, false))).toEqual(
        { status: 403, code: ErrorCode.FORBIDDEN },
      );
    });

    it('refuses writes but not reads on archived projects', async () => {
      const { service } = setup([member('PM')], {}, { archivedAt: new Date() });
      const access = await resolveAs(service);
      expect(thrown(() => service.assert(access, ProjectPermission.MANAGE_PROJECT, true))).toEqual({
        status: 409,
        code: ErrorCode.PROJECT_ARCHIVED,
      });
      expect(() => service.assert(access, ProjectPermission.MANAGE_MEMBERS, false)).not.toThrow();
    });

    it('checks the role before the archived state', async () => {
      const { service } = setup([member('VIEWER')], {}, { archivedAt: new Date() });
      const access = await resolveAs(service);
      expect(
        thrown(() => service.assert(access, ProjectPermission.MANAGE_PROJECT, true)).status,
      ).toBe(403);
    });
  });

  describe('visibility scopes (SPEC §3.3)', () => {
    /**
     * Resolves access for a Member or Viewer with a scope.
     *
     * @param role Member or Viewer.
     * @param visibility Scope.
     * @param buckets Allowed buckets.
     * @returns The service and access.
     */
    async function scoped(role: 'MEMBER' | 'VIEWER', visibility: string, buckets: string[] = []) {
      const { service } = setup([member(role, visibility, buckets)]);
      return { service, access: await resolveAs(service) };
    }

    for (const role of ['MEMBER', 'VIEWER'] as const) {
      it(`${role} ALL: sees every item; filter is empty`, async () => {
        const { service, access } = await scoped(role, 'ALL');
        expect(service.canViewItem(access, item())).toBe(true);
        expect(service.canViewItem(access, item({ bucketId: null }))).toBe(true);
        expect(service.itemScopeFilter(access)).toEqual({});
        expect(service.ancestorsAreTitleOnly(access)).toBe(false);
      });

      it(`${role} BUCKETS: sees only items in selected buckets`, async () => {
        const { service, access } = await scoped(role, 'BUCKETS', [BUCKET_A]);
        expect(service.canViewItem(access, item({ bucketId: BUCKET_A }))).toBe(true);
        expect(service.canViewItem(access, item({ bucketId: BUCKET_B }))).toBe(false);
        expect(service.canViewItem(access, item({ bucketId: null }))).toBe(false);
        // Own items in other buckets stay hidden: the scope is buckets only.
        expect(service.canViewItem(access, item({ bucketId: BUCKET_B, createdById: ME }))).toBe(
          false,
        );
        expect(service.itemScopeFilter(access)).toEqual({ bucketId: { in: [BUCKET_A] } });
        expect(service.ancestorsAreTitleOnly(access)).toBe(true);
      });

      it(`${role} OWN: sees only items assigned to or created by them`, async () => {
        const { service, access } = await scoped(role, 'OWN');
        expect(service.canViewItem(access, item())).toBe(false);
        expect(service.canViewItem(access, item({ createdById: ME }))).toBe(true);
        expect(service.canViewItem(access, item({ assigneeIds: [OTHER, ME] }))).toBe(true);
        expect(service.itemScopeFilter(access)).toEqual({
          OR: [{ createdById: ME }, { assignees: { some: { userId: ME } } }],
        });
        expect(service.ancestorsAreTitleOnly(access)).toBe(true);
      });
    }

    it('ignores the stored bucket list unless the scope is BUCKETS', async () => {
      const { service, access } = await scoped('MEMBER', 'OWN', [BUCKET_A]);
      expect(access.allowedBucketIds).toEqual([]);
      expect(service.canViewItem(access, item({ bucketId: BUCKET_A }))).toBe(false);
    });

    it('PM and Lead see everything even with a restricted stored scope', async () => {
      for (const role of ['PM', 'LEAD'] as const) {
        const { service } = setup([member(role, 'BUCKETS', [BUCKET_B])]);
        const access = await resolveAs(service);
        expect(service.canViewItem(access, item({ bucketId: BUCKET_A }))).toBe(true);
        expect(service.itemScopeFilter(access)).toEqual({});
      }
    });
  });

  describe('item rules (SPEC §3.2 conditional rows)', () => {
    /**
     * Resolves access for a role with ALL visibility.
     *
     * @param role Project role.
     * @param settings Project settings.
     * @returns The service and access.
     */
    async function as(role: ProjectRole, settings: object = {}) {
      const { service } = setup([member(role)], settings);
      return { service, access: await resolveAs(service) };
    }
    const others = item();
    const created = item({ createdById: ME });
    const assigned = item({ assigneeIds: [ME] });

    it('edit: PM/Lead any item, Member own or assigned only, Viewer never', async () => {
      for (const role of ['PM', 'LEAD'] as const) {
        const { service, access } = await as(role);
        expect(service.canEditItem(access, others)).toBe(true);
      }
      const m = await as('MEMBER');
      expect(m.service.canEditItem(m.access, others)).toBe(false);
      expect(m.service.canEditItem(m.access, created)).toBe(true);
      expect(m.service.canEditItem(m.access, assigned)).toBe(true);
      const v = await as('VIEWER');
      expect(v.service.canEditItem(v.access, created)).toBe(false);
    });

    it('move: PM/Lead any card, Member own or assigned only, Viewer never', async () => {
      for (const role of ['PM', 'LEAD'] as const) {
        const { service, access } = await as(role);
        expect(service.canMoveItem(access, others)).toBe(true);
      }
      const m = await as('MEMBER');
      expect(m.service.canMoveItem(m.access, others)).toBe(false);
      expect(m.service.canMoveItem(m.access, created)).toBe(true);
      expect(m.service.canMoveItem(m.access, assigned)).toBe(true);
      const v = await as('VIEWER');
      expect(v.service.canMoveItem(v.access, assigned)).toBe(false);
    });

    it('delete: PM/Lead any item with cascade; Member own created without children, no cascade', async () => {
      for (const role of ['PM', 'LEAD'] as const) {
        const { service, access } = await as(role);
        expect(service.canDeleteItem(access, item({ hasChildren: true }), true)).toBe(true);
      }
      const m = await as('MEMBER');
      expect(m.service.canDeleteItem(m.access, created, false)).toBe(true);
      expect(m.service.canDeleteItem(m.access, created, true)).toBe(false);
      expect(m.service.canDeleteItem(m.access, { ...created, hasChildren: true }, false)).toBe(
        false,
      );
      // Assigned is not enough: only items the Member created.
      expect(m.service.canDeleteItem(m.access, assigned, false)).toBe(false);
      expect(m.service.canDeleteItem(m.access, others, false)).toBe(false);
      const v = await as('VIEWER');
      expect(v.service.canDeleteItem(v.access, created, false)).toBe(false);
    });

    it('notes and attachments: PM, Lead and Member on visible items; Viewer never', async () => {
      for (const role of ['PM', 'LEAD', 'MEMBER'] as const) {
        const { service, access } = await as(role);
        expect(service.canAnnotateItem(access, others)).toBe(true);
      }
      const v = await as('VIEWER');
      expect(v.service.canAnnotateItem(v.access, others)).toBe(false);
    });

    it('assign: self always; others needs ASSIGN_OTHERS (Members via the project setting)', async () => {
      for (const role of ['PM', 'LEAD'] as const) {
        const { service, access } = await as(role);
        expect(service.canAssign(access, [OTHER])).toBe(true);
      }
      const off = await as('MEMBER');
      expect(off.service.canAssign(off.access, [ME])).toBe(true);
      expect(off.service.canAssign(off.access, [ME, OTHER])).toBe(false);
      const on = await as('MEMBER', { membersCanAssignOthers: true });
      expect(on.service.canAssign(on.access, [OTHER])).toBe(true);
      const v = await as('VIEWER', { membersCanAssignOthers: true });
      expect(v.service.canAssign(v.access, [OTHER])).toBe(false);
    });

    it('denies every item action outside the visibility scope, even on own items', async () => {
      const { service } = setup([member('MEMBER', 'BUCKETS', [BUCKET_A])]);
      const access: ProjectAccess = await resolveAs(service);
      const hidden = item({ bucketId: BUCKET_B, createdById: ME });
      expect(service.canEditItem(access, hidden)).toBe(false);
      expect(service.canMoveItem(access, hidden)).toBe(false);
      expect(service.canDeleteItem(access, hidden, false)).toBe(false);
      expect(service.canAnnotateItem(access, hidden)).toBe(false);
    });

    it('non-member admins may view but not change items', async () => {
      const { service } = setup([]);
      const access = await resolveAs(service, 'ADMIN');
      expect(service.canViewItem(access, others)).toBe(true);
      expect(service.canEditItem(access, others)).toBe(false);
      expect(service.canMoveItem(access, others)).toBe(false);
      expect(service.canDeleteItem(access, others, false)).toBe(false);
      expect(service.canAnnotateItem(access, others)).toBe(false);
    });
  });
});
