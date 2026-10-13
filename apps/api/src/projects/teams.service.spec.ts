import { AuditAction, ErrorCode } from '@kloister/shared';
import { fakeAudit, fakePrisma, makeProject, makeUser } from '../../test/support/fakes.js';
import type { AuthContext } from '../auth/auth-context.js';
import type { ApiException } from '../common/api-exception.js';
import type { ProjectAccess } from './project-access.service.js';
import { TeamsService } from './teams.service.js';

const PM_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const TEAM_ID = '66666666-6666-4666-8666-666666666666';

const auth: AuthContext = { user: makeUser({ id: PM_ID }), sessionId: 's' };
const access = { project: makeProject(), userId: PM_ID } as unknown as ProjectAccess;

/**
 * Awaits a promise expected to reject with an ApiException.
 *
 * @param promise The call under test.
 * @returns The exception's status, code and message.
 */
async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const e = error as ApiException;
    const body = e.getResponse() as { code: string; message: string };
    return { status: e.getStatus(), code: body.code, message: body.message };
  }
  throw new Error('expected rejection');
}

/**
 * Builds a team row with members.
 *
 * @param members Members as user id and role.
 * @returns The row as loaded by the service.
 */
function team(members: { userId: string; role: string }[] = []) {
  return {
    id: TEAM_ID,
    projectId: access.project.id,
    name: 'Backend',
    description: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    members: members.map((m) => ({
      id: `tm-${m.userId}`,
      ...m,
      projectMember: {
        user: { email: `${m.userId}@example.org`, displayName: m.userId, isActive: true },
      },
    })),
  };
}

/**
 * Builds the service with the caller as PM of an unarchived project.
 *
 * @param targetRole Project role of the user being placed, or null if not a member.
 * @returns Service, fake and audit records.
 */
function setup(targetRole: string | null = 'MEMBER') {
  const { fake, prisma } = fakePrisma();
  const audit = fakeAudit();
  fake.projectMember.findUnique.mockImplementation((args: unknown) => {
    const { userId } = (args as { where: { projectId_userId: { userId: string } } }).where
      .projectId_userId;
    if (userId === PM_ID) return Promise.resolve({ role: 'PM', project: { archivedAt: null } });
    return Promise.resolve(
      targetRole === null ? null : { role: targetRole, user: { email: 'u@example.org' } },
    );
  });
  fake.team.findFirst.mockResolvedValue(team());
  fake.teamMember.upsert.mockResolvedValue({});
  return { service: new TeamsService(prisma, audit.service), fake, audit };
}

describe('TeamsService', () => {
  it('only places project members in a team', async () => {
    const { service, fake } = setup(null);
    expect(
      await rejection(service.setMember(auth, access, TEAM_ID, USER_ID, { role: 'MEMBER' })),
    ).toMatchObject({ status: 400, code: ErrorCode.VALIDATION_FAILED });
    expect(fake.teamMember.upsert).not.toHaveBeenCalled();
  });

  it('never makes a project Viewer a team Lead, but accepts them as a Member', async () => {
    const { service, fake } = setup('VIEWER');
    expect(
      (await rejection(service.setMember(auth, access, TEAM_ID, USER_ID, { role: 'LEAD' }))).status,
    ).toBe(400);
    await service.setMember(auth, access, TEAM_ID, USER_ID, { role: 'MEMBER' });
    expect(fake.teamMember.upsert).toHaveBeenCalledWith({
      where: { teamId_userId: { teamId: TEAM_ID, userId: USER_ID } },
      create: { teamId: TEAM_ID, projectId: access.project.id, userId: USER_ID, role: 'MEMBER' },
      update: { role: 'MEMBER' },
    });
  });

  it('audits a role change with the previous role, and skips no-op changes', async () => {
    const { service, fake, audit } = setup('MEMBER');
    fake.team.findFirst.mockResolvedValue(team([{ userId: USER_ID, role: 'MEMBER' }]));
    await service.setMember(auth, access, TEAM_ID, USER_ID, { role: 'MEMBER' });
    expect(fake.teamMember.upsert).not.toHaveBeenCalled();
    await service.setMember(auth, access, TEAM_ID, USER_ID, { role: 'LEAD' });
    expect(audit.records[0]).toMatchObject({
      action: AuditAction.TEAM_MEMBER_SET,
      meta: { userId: USER_ID, role: 'LEAD', previousRole: 'MEMBER' },
    });
  });

  it('answers 404 for teams outside the project and users not in the team', async () => {
    const { service, fake } = setup();
    fake.team.findFirst.mockResolvedValue(null);
    expect((await rejection(service.update(auth, access, TEAM_ID, { name: 'X' }))).status).toBe(
      404,
    );
    expect(fake.team.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TEAM_ID, projectId: access.project.id } }),
    );
    fake.team.findFirst.mockResolvedValue(team());
    expect((await rejection(service.removeMember(auth, access, TEAM_ID, USER_ID))).status).toBe(
      404,
    );
  });

  it('reports duplicate names on create, and a generic conflict elsewhere', async () => {
    const { service, fake } = setup();
    const unique = Object.assign(new Error('unique'), { code: 'P2002' });
    fake.team.create.mockRejectedValue(unique);
    expect(await rejection(service.create(auth, access, { name: 'Backend' }))).toMatchObject({
      status: 409,
      message: 'A team with this name already exists in the project',
    });
    fake.teamMember.upsert.mockRejectedValue(unique);
    const res = await rejection(
      service.setMember(auth, access, TEAM_ID, USER_ID, { role: 'LEAD' }),
    );
    expect(res.status).toBe(409);
    expect(res.message).not.toContain('name');
  });

  it('re-checks inside the transaction that the caller is still PM and the project live', async () => {
    const demoted = setup();
    demoted.fake.projectMember.findUnique.mockResolvedValue({
      role: 'LEAD',
      project: { archivedAt: null },
    });
    expect((await rejection(demoted.service.create(auth, access, { name: 'X' }))).status).toBe(403);
    const archived = setup();
    archived.fake.projectMember.findUnique.mockResolvedValue({
      role: 'PM',
      project: { archivedAt: new Date() },
    });
    expect((await rejection(archived.service.create(auth, access, { name: 'X' }))).code).toBe(
      ErrorCode.PROJECT_ARCHIVED,
    );
    expect(archived.fake.team.create).not.toHaveBeenCalled();
  });
});
