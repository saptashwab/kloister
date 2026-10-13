import { AuditAction, ErrorCode } from '@kloister/shared';
import { fakeAudit, fakePrisma, makeProject, makeUser } from '../../test/support/fakes.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { ApiException } from '../common/api-exception.js';
import { MembersService, normalizePlacement } from './members.service.js';
import type { ProjectAccess } from './project-access.service.js';
import { ProjectsService } from './projects.service.js';

const PM_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const BUCKET = '44444444-4444-4444-8444-444444444444';

const auth: AuthContext = { user: makeUser({ id: PM_ID }), sessionId: 's' };
const access = {
  project: makeProject(),
  settings: { membersCanAssignOthers: false },
  userId: PM_ID,
  role: 'PM',
  visibility: 'ALL',
  allowedBucketIds: [],
  permissions: new Set(),
} as unknown as ProjectAccess;

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
 * Builds a membership row with its user.
 *
 * @param userId Member's user id.
 * @param role Project role.
 * @returns The row.
 */
function row(userId: string, role: string) {
  return {
    id: `m-${userId}`,
    projectId: access.project.id,
    userId,
    role,
    visibility: 'ALL',
    allowedBucketIds: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    user: { email: `${userId}@example.org`, displayName: 'X', isActive: true },
    project: { archivedAt: null },
  };
}

/**
 * Builds a members service whose fake database knows the caller (a PM) and
 * one target membership.
 *
 * @param targetRole The target's role.
 * @param otherActivePms Count returned for other active PMs.
 * @returns Service, fake and audit records.
 */
function setup(targetRole: string, otherActivePms: number) {
  const { fake, prisma } = fakePrisma();
  const audit = fakeAudit();
  fake.projectMember.findUnique.mockImplementation((args: unknown) => {
    const { userId } = (args as { where: { projectId_userId: { userId: string } } }).where
      .projectId_userId;
    return Promise.resolve(userId === PM_ID ? row(PM_ID, 'PM') : row(TARGET_ID, targetRole));
  });
  fake.projectMember.count.mockResolvedValue(otherActivePms);
  fake.projectMember.update.mockImplementation((args: unknown) =>
    Promise.resolve({ ...row(TARGET_ID, targetRole), ...(args as { data: object }).data }),
  );
  fake.projectMember.delete.mockResolvedValue({});
  return { service: new MembersService(prisma, audit.service), fake, audit };
}

describe('normalizePlacement', () => {
  it('forces ALL with no buckets for PM and Lead', () => {
    for (const role of ['PM', 'LEAD'] as const) {
      expect(
        normalizePlacement({ role, visibility: 'BUCKETS', allowedBucketIds: [BUCKET] }),
      ).toEqual({ role, visibility: 'ALL', allowedBucketIds: [] });
    }
  });

  it('keeps buckets only for BUCKETS scope, without duplicates', () => {
    expect(
      normalizePlacement({
        role: 'MEMBER',
        visibility: 'BUCKETS',
        allowedBucketIds: [BUCKET, BUCKET],
      }),
    ).toEqual({ role: 'MEMBER', visibility: 'BUCKETS', allowedBucketIds: [BUCKET] });
    expect(
      normalizePlacement({ role: 'VIEWER', visibility: 'OWN', allowedBucketIds: [BUCKET] }),
    ).toEqual({ role: 'VIEWER', visibility: 'OWN', allowedBucketIds: [] });
  });
});

describe('MembersService last-PM rule (SPEC §3.2)', () => {
  it('rejects demoting the last active PM', async () => {
    const { service, fake } = setup('PM', 0);
    expect(await rejection(service.update(auth, access, TARGET_ID, { role: 'LEAD' }))).toEqual({
      status: 409,
      code: ErrorCode.LAST_PM,
    });
    expect(fake.projectMember.update).not.toHaveBeenCalled();
    expect(fake.projectMember.count).toHaveBeenCalledWith({
      where: {
        projectId: access.project.id,
        role: 'PM',
        userId: { not: TARGET_ID },
        user: { isActive: true },
      },
    });
  });

  it('rejects removing the last active PM', async () => {
    const { service, fake } = setup('PM', 0);
    expect((await rejection(service.remove(auth, access, TARGET_ID))).code).toBe(ErrorCode.LAST_PM);
    expect(fake.projectMember.delete).not.toHaveBeenCalled();
  });

  it('allows demoting a PM while another active PM remains, and audits it', async () => {
    const { service, audit } = setup('PM', 1);
    const dto = await service.update(auth, access, TARGET_ID, {
      role: 'MEMBER',
      visibility: 'OWN',
    });
    expect(dto).toMatchObject({ role: 'MEMBER', visibility: 'OWN' });
    expect(audit.records[0]).toMatchObject({ action: AuditAction.MEMBER_UPDATED });
  });

  it('does not count PMs when changing a non-PM', async () => {
    const { service, fake } = setup('MEMBER', 0);
    await service.update(auth, access, TARGET_ID, { role: 'VIEWER' });
    expect(fake.projectMember.count).not.toHaveBeenCalled();
  });

  it('refuses when the caller lost the PM role concurrently', async () => {
    const { service, fake } = setup('MEMBER', 1);
    fake.projectMember.findUnique.mockResolvedValue(row(PM_ID, 'LEAD'));
    expect((await rejection(service.remove(auth, access, TARGET_ID))).status).toBe(403);
    expect(
      (await rejection(service.add(auth, access, { userId: TARGET_ID, role: 'PM' }))).status,
    ).toBe(403);
    expect(fake.projectMember.create).not.toHaveBeenCalled();
  });

  it('refuses changes when the project was archived concurrently', async () => {
    const { service, fake } = setup('MEMBER', 1);
    fake.projectMember.findUnique.mockResolvedValue({
      ...row(PM_ID, 'PM'),
      project: { archivedAt: new Date() },
    });
    expect(
      (await rejection(service.update(auth, access, TARGET_ID, { role: 'VIEWER' }))).code,
    ).toBe(ErrorCode.PROJECT_ARCHIVED);
    expect(fake.projectMember.update).not.toHaveBeenCalled();
  });

  it('refuses making a team Lead a project Viewer (SPEC §3.5)', async () => {
    const { service, fake } = setup('MEMBER', 1);
    fake.teamMember.count.mockResolvedValue(1);
    expect(await rejection(service.update(auth, access, TARGET_ID, { role: 'VIEWER' }))).toEqual({
      status: 409,
      code: ErrorCode.CONFLICT,
    });
    expect(fake.teamMember.count).toHaveBeenCalledWith({
      where: { projectId: access.project.id, userId: TARGET_ID, role: 'LEAD' },
    });
    expect(fake.projectMember.update).not.toHaveBeenCalled();
  });

  it('writes nothing for a no-op change', async () => {
    const { service, fake, audit } = setup('MEMBER', 1);
    await service.update(auth, access, TARGET_ID, { role: 'MEMBER', visibility: 'ALL' });
    expect(fake.projectMember.update).not.toHaveBeenCalled();
    expect(audit.records).toHaveLength(0);
  });
});

describe('MembersService admin PM assignment (SPEC §3.1)', () => {
  const adminAccess = {
    ...access,
    role: null,
    isSystemAdmin: true,
    permissions: new Set(['VIEW_ITEMS', 'ASSIGN_PMS']),
  } as unknown as ProjectAccess;
  const adminAuth: AuthContext = {
    user: makeUser({ id: PM_ID, systemRole: 'ADMIN' }),
    sessionId: 's',
  };

  /**
   * Builds the service with the admin still active in the database.
   *
   * @param targetRole The target member's role.
   * @param otherActivePms Count returned for other active PMs.
   * @returns Service, fake and audit records.
   */
  function adminSetup(targetRole: string, otherActivePms = 1) {
    const ctx = setup(targetRole, otherActivePms);
    ctx.fake.projectMember.findUnique.mockResolvedValue(row(TARGET_ID, targetRole));
    ctx.fake.user.findUnique.mockImplementation((args: unknown) => {
      const { id } = (args as { where: { id: string } }).where;
      return Promise.resolve(
        id === PM_ID
          ? makeUser({ id: PM_ID, systemRole: 'ADMIN' })
          : makeUser({ id: TARGET_ID, email: 'target@example.org' }),
      );
    });
    ctx.fake.projectMember.create.mockImplementation((args: unknown) =>
      Promise.resolve({ ...row(TARGET_ID, 'PM'), ...(args as { data: object }).data }),
    );
    return ctx;
  }

  it('adds users as PM only', async () => {
    const { service, audit } = adminSetup('MEMBER');
    expect(
      (await rejection(service.add(adminAuth, adminAccess, { userId: TARGET_ID, role: 'LEAD' })))
        .status,
    ).toBe(403);
    await service.add(adminAuth, adminAccess, { userId: TARGET_ID, role: 'PM' });
    expect(audit.records[0]).toMatchObject({
      action: AuditAction.MEMBER_ADDED,
      meta: expect.objectContaining({ role: 'PM', asAdmin: true }) as unknown,
    });
  });

  it('promotes to and demotes from PM, but changes nothing else', async () => {
    const promote = adminSetup('MEMBER');
    await expect(
      promote.service.update(adminAuth, adminAccess, TARGET_ID, { role: 'PM' }),
    ).resolves.toMatchObject({ role: 'PM' });
    const demote = adminSetup('PM');
    await expect(
      demote.service.update(adminAuth, adminAccess, TARGET_ID, { role: 'LEAD' }),
    ).resolves.toMatchObject({ role: 'LEAD' });
    const other = adminSetup('MEMBER');
    expect(
      (await rejection(other.service.update(adminAuth, adminAccess, TARGET_ID, { role: 'VIEWER' })))
        .status,
    ).toBe(403);
    expect(other.fake.projectMember.update).not.toHaveBeenCalled();
  });

  it('removes PMs only, and still keeps one active PM', async () => {
    const nonPm = adminSetup('MEMBER');
    expect((await rejection(nonPm.service.remove(adminAuth, adminAccess, TARGET_ID))).status).toBe(
      403,
    );
    const last = adminSetup('PM', 0);
    expect((await rejection(last.service.remove(adminAuth, adminAccess, TARGET_ID))).code).toBe(
      ErrorCode.LAST_PM,
    );
    const ok = adminSetup('PM', 1);
    await ok.service.remove(adminAuth, adminAccess, TARGET_ID);
    expect(ok.fake.projectMember.delete).toHaveBeenCalled();
  });

  it('cannot change visibility while demoting a PM', async () => {
    const { service, fake } = adminSetup('PM');
    expect(
      (
        await rejection(
          service.update(adminAuth, adminAccess, TARGET_ID, { role: 'MEMBER', visibility: 'OWN' }),
        )
      ).status,
    ).toBe(403);
    expect(fake.projectMember.update).not.toHaveBeenCalled();
  });

  it('limits admins who are PMs to PM-role changes while the project is archived', async () => {
    const archivedAdminPm = {
      ...access,
      project: makeProject({ archivedAt: new Date() }),
      isSystemAdmin: true,
      permissions: new Set(['MANAGE_MEMBERS', 'ASSIGN_PMS', 'VIEW_ITEMS']),
    } as unknown as ProjectAccess;
    const { service } = adminSetup('MEMBER');
    expect(
      (await rejection(service.update(adminAuth, archivedAdminPm, TARGET_ID, { role: 'VIEWER' })))
        .status,
    ).toBe(403);
    await expect(
      service.update(adminAuth, archivedAdminPm, TARGET_ID, { role: 'PM' }),
    ).resolves.toMatchObject({ role: 'PM' });
  });

  it('refuses when the caller is no longer an active admin', async () => {
    const { service, fake } = adminSetup('PM');
    fake.user.findUnique.mockResolvedValue(makeUser({ id: PM_ID, systemRole: 'USER' }));
    expect((await rejection(service.remove(adminAuth, adminAccess, TARGET_ID))).status).toBe(403);
  });
});

describe('ProjectsService.list', () => {
  it('refuses scope=all to non-admins', async () => {
    const { prisma } = fakePrisma();
    const service = new ProjectsService(prisma, fakeAudit().service);
    expect(await rejection(service.list(auth, { scope: 'all' }))).toEqual({
      status: 403,
      code: ErrorCode.FORBIDDEN,
    });
  });
});
