import { fakeAudit, fakePrisma, makeProject, makeUser } from '../../test/support/fakes.js';
import { PersonalService } from './personal.service.js';
import { ProjectAccessService } from './project-access.service.js';

describe('PersonalService', () => {
  const owner = makeUser();
  const auth = { user: owner, sessionId: 'session' };
  it('first-use creation takes identity only from the session and creates no memberships', async () => {
    const { fake, prisma } = fakePrisma();
    const row = makeProject({ key: null, ownerId: owner.id });
    fake.project.upsert.mockResolvedValue(row);
    fake.project.findUnique.mockResolvedValue(row);
    const access = new ProjectAccessService(prisma, fakeAudit().service);
    const project = await new PersonalService(prisma, access).ensure(auth);
    expect(project.ownerId).toBe(owner.id);
    expect(project.myRole).toBe('PM');
    expect(project.myPermissions).toEqual(
      expect.arrayContaining(['MANAGE_BOARD', 'CREATE_ITEMS', 'ANNOTATE_ITEMS']),
    );
    for (const permission of ['MANAGE_MEMBERS', 'ASSIGN_PMS', 'ASSIGN_OTHERS', 'EXPORT_ADO'])
      expect(project.myPermissions).not.toContain(permission);
    const args = fake.project.upsert.mock.calls[0]?.[0] as {
      where: object;
      create: Record<string, unknown>;
    };
    expect(args.where).toEqual({ ownerId: owner.id });
    expect(args.create).toMatchObject({ ownerId: owner.id, key: null });
    expect(args.create).not.toHaveProperty('members');
  });
  it('reading an unused space returns 404 without an upsert', async () => {
    const { fake, prisma } = fakePrisma();
    const access = new ProjectAccessService(prisma, fakeAudit().service);
    await expect(new PersonalService(prisma, access).get(auth)).rejects.toMatchObject({
      status: 404,
    });
    expect(fake.project.upsert).not.toHaveBeenCalled();
  });
  it('checks ownership before even a stored membership or the admin exception', async () => {
    const { fake, prisma } = fakePrisma();
    const audit = fakeAudit();
    const row = makeProject({ key: null, ownerId: owner.id });
    fake.project.findUnique.mockResolvedValue({ ...row, members: [{ role: 'PM' }] });
    const access = new ProjectAccessService(prisma, audit.service);
    for (const systemRole of ['USER', 'ADMIN'] as const) {
      await expect(
        access.resolve(
          {
            user: makeUser({ id: '22222222-2222-4222-8222-222222222222', systemRole }),
            sessionId: 's',
          },
          row.id,
          'GET project',
        ),
      ).rejects.toMatchObject({ status: 404 });
    }
    expect(audit.records).toEqual([]);
  });
});
