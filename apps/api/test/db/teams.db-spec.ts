import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AuditAction, ErrorCode, type Page, type ProjectDto, type TeamDto } from '@kloister/shared';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  call,
  codeOf,
  login,
  resetDb,
  seedProject,
  seedTeam,
  seedUser,
  startApp,
} from './support.js';

// Optional project teams (SPEC §3.5) against a real database, including the
// HTTP permission matrix for every team route.

describe('project teams (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  /** Ids of the seeded users, by name. */
  let ids: Record<'admin' | 'pm' | 'lead' | 'member' | 'viewer' | 'outsider', string>;
  let projectId: string;
  let teamId: string;

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    const admin = await seedUser(prisma, { email: 'admin@example.org', systemRole: 'ADMIN' });
    const seeded: Record<string, string> = { admin: admin.id };
    for (const name of ['pm', 'lead', 'member', 'viewer', 'outsider'] as const) {
      seeded[name] = (await seedUser(prisma, { email: `${name}@example.org` })).id;
    }
    ids = seeded;
    projectId = (
      await seedProject(prisma, 'KLO', [
        { userId: ids.pm, role: 'PM' },
        { userId: ids.lead, role: 'LEAD' },
        { userId: ids.member, role: 'MEMBER' },
        { userId: ids.viewer, role: 'VIEWER' },
      ])
    ).id;
    // The project Member leads this team: team Leads still cannot manage teams.
    teamId = (await seedTeam(prisma, projectId, 'Backend', [{ userId: ids.member, role: 'LEAD' }]))
      .id;
  });

  /**
   * Signs in a seeded user by name.
   *
   * @param name Seeded user name.
   * @returns Session token.
   */
  const sid = (name: keyof typeof ids): Promise<string> => login(app, `${name}@example.org`);
  const teams = () => `/api/v1/projects/${projectId}/teams`;

  describe('permission matrix', () => {
    type Caller = 'pm' | 'lead' | 'member' | 'viewer' | 'outsider' | 'admin';
    type Route = {
      name: string;
      method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
      url: () => string;
      body?: object;
      expect: Record<Caller, number>;
    };
    const refused = { lead: 403, member: 403, viewer: 403, outsider: 404, admin: 403 };
    // Ordered so the PM's run succeeds end to end.
    const routes: Route[] = [
      {
        name: 'list teams',
        method: 'GET',
        url: teams,
        expect: { pm: 200, lead: 200, member: 200, viewer: 200, outsider: 404, admin: 200 },
      },
      {
        name: 'create team',
        method: 'POST',
        url: teams,
        body: { name: 'Frontend' },
        expect: { pm: 201, ...refused },
      },
      {
        name: 'rename team',
        method: 'PATCH',
        url: () => `${teams()}/${teamId}`,
        body: { name: 'Backend API', description: 'Services' },
        expect: { pm: 200, ...refused },
      },
      {
        name: 'add team member',
        method: 'PUT',
        url: () => `${teams()}/${teamId}/members/${ids.viewer}`,
        body: { role: 'MEMBER' },
        expect: { pm: 200, ...refused },
      },
      {
        name: 'change team role',
        method: 'PUT',
        url: () => `${teams()}/${teamId}/members/${ids.member}`,
        body: { role: 'MEMBER' },
        expect: { pm: 200, ...refused },
      },
      {
        name: 'remove team member',
        method: 'DELETE',
        url: () => `${teams()}/${teamId}/members/${ids.member}`,
        expect: { pm: 200, ...refused },
      },
      {
        name: 'delete team',
        method: 'DELETE',
        url: () => `${teams()}/${teamId}`,
        expect: { pm: 204, ...refused },
      },
    ];

    it.each(['pm', 'lead', 'member', 'viewer', 'outsider', 'admin'] as const)(
      'enforces every team route for %s',
      async (caller) => {
        const session = await sid(caller);
        const before = await prisma.teamMember.findMany({ orderBy: { id: 'asc' } });
        for (const route of routes) {
          const res = await call(app, route.method, route.url(), {
            sid: session,
            ...(route.body === undefined ? {} : { body: route.body }),
          });
          expect({ route: route.name, status: res.statusCode }).toEqual({
            route: route.name,
            status: route.expect[caller],
          });
          if (res.statusCode === 404) expect(codeOf(res)).toBe(ErrorCode.NOT_FOUND);
          if (res.statusCode === 403) expect(codeOf(res)).toBe(ErrorCode.FORBIDDEN);
        }
        if (caller !== 'pm') {
          expect(await prisma.teamMember.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
          expect(await prisma.team.count()).toBe(1);
        }
      },
    );
  });

  it('lists teams with members by name and reports myTeams', async () => {
    const frontend = await seedTeam(prisma, projectId, 'Frontend', [
      { userId: ids.member, role: 'MEMBER' },
      { userId: ids.lead, role: 'LEAD' },
    ]);
    const res = await call(app, 'GET', teams(), { sid: await sid('viewer') });
    const page = res.json() as Page<TeamDto>;
    expect(page.items.map((t) => t.name)).toEqual(['Backend', 'Frontend']);
    expect(page.items[1]?.members.map((m) => [m.displayName, m.role])).toEqual([
      ['lead', 'LEAD'],
      ['member', 'MEMBER'],
    ]);
    expect(JSON.stringify(page)).not.toContain('passwordHash');

    // One user leads one team and is a member of another.
    const project = await call(app, 'GET', `/api/v1/projects/${projectId}`, {
      sid: await sid('member'),
    });
    expect(
      (project.json() as ProjectDto).myTeams.sort((a, b) => a.teamId.localeCompare(b.teamId)),
    ).toEqual(
      [
        { teamId, role: 'LEAD' },
        { teamId: frontend.id, role: 'MEMBER' },
      ].sort((a, b) => a.teamId.localeCompare(b.teamId)),
    );
  });

  it('allows several Leads per team and audits team changes', async () => {
    const pm = await sid('pm');
    const res = await call(app, 'PUT', `${teams()}/${teamId}/members/${ids.lead}`, {
      sid: pm,
      body: { role: 'LEAD' },
    });
    expect(
      (res.json() as TeamDto).members
        .filter((m) => m.role === 'LEAD')
        .map((m) => m.userId)
        .sort(),
    ).toEqual([ids.lead, ids.member].sort());
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: AuditAction.TEAM_MEMBER_SET },
    });
    expect(audit).toMatchObject({
      actorId: ids.pm,
      projectId,
      entityType: 'Team',
      entityId: teamId,
    });
    expect(audit.meta).toMatchObject({ userId: ids.lead, role: 'LEAD', previousRole: null });
  });

  it('rejects duplicate names per project but allows them across projects', async () => {
    const pm = await sid('pm');
    const dup = await call(app, 'POST', teams(), { sid: pm, body: { name: 'Backend' } });
    expect(dup.statusCode).toBe(409);
    expect(codeOf(dup)).toBe(ErrorCode.CONFLICT);
    await seedProject(prisma, 'OTH', [{ userId: ids.pm, role: 'PM' }]);
    const other = await call(app, 'POST', '/api/v1/projects/OTH/teams', {
      sid: pm,
      body: { name: 'Backend' },
    });
    expect(other.statusCode).toBe(201);
    for (const body of [{ name: '' }, { name: null }, { name: 'X', extra: 1 }]) {
      expect((await call(app, 'POST', teams(), { sid: pm, body })).statusCode).toBe(400);
    }
  });

  it('only takes project members, and never a Viewer as Lead', async () => {
    const pm = await sid('pm');
    const outsider = await call(app, 'PUT', `${teams()}/${teamId}/members/${ids.outsider}`, {
      sid: pm,
      body: { role: 'MEMBER' },
    });
    expect(outsider.statusCode).toBe(400);
    const viewerLead = await call(app, 'PUT', `${teams()}/${teamId}/members/${ids.viewer}`, {
      sid: pm,
      body: { role: 'LEAD' },
    });
    expect(viewerLead.statusCode).toBe(400);
    const viewerMember = await call(app, 'PUT', `${teams()}/${teamId}/members/${ids.viewer}`, {
      sid: pm,
      body: { role: 'MEMBER' },
    });
    expect(viewerMember.statusCode).toBe(200);
    const badRole = await call(app, 'PUT', `${teams()}/${teamId}/members/${ids.lead}`, {
      sid: pm,
      body: { role: 'OWNER' },
    });
    expect(badRole.statusCode).toBe(400);
  });

  it("answers 404 for another project's team and for users not in the team", async () => {
    const otherProject = await seedProject(prisma, 'OTH', [{ userId: ids.outsider, role: 'PM' }]);
    const foreign = await seedTeam(prisma, otherProject.id, 'Theirs');
    const pm = await sid('pm');
    for (const [method, url, body] of [
      ['PATCH', `${teams()}/${foreign.id}`, { name: 'Mine' }],
      ['DELETE', `${teams()}/${foreign.id}`, undefined],
      ['PUT', `${teams()}/${foreign.id}/members/${ids.lead}`, { role: 'MEMBER' }],
      ['DELETE', `${teams()}/${teamId}/members/${ids.lead}`, undefined],
    ] as const) {
      const res = await call(app, method, url, { sid: pm, ...(body ? { body } : {}) });
      expect({ method, url, status: res.statusCode }).toEqual({ method, url, status: 404 });
    }
    expect((await prisma.team.findUniqueOrThrow({ where: { id: foreign.id } })).name).toBe(
      'Theirs',
    );
  });

  it('removes team memberships when the user leaves the project', async () => {
    const pm = await sid('pm');
    const res = await call(app, 'DELETE', `/api/v1/projects/${projectId}/members/${ids.member}`, {
      sid: pm,
    });
    expect(res.statusCode).toBe(204);
    expect(await prisma.teamMember.count({ where: { userId: ids.member } })).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: AuditAction.MEMBER_REMOVED },
    });
    expect(audit.meta).toMatchObject({ userId: ids.member, teamsLeft: 1 });
  });

  it('refuses to make a team Lead a project Viewer until their team role changes', async () => {
    const pm = await sid('pm');
    const url = `/api/v1/projects/${projectId}/members/${ids.member}`;
    const demote = await call(app, 'PATCH', url, { sid: pm, body: { role: 'VIEWER' } });
    expect(demote.statusCode).toBe(409);
    await call(app, 'PUT', `${teams()}/${teamId}/members/${ids.member}`, {
      sid: pm,
      body: { role: 'MEMBER' },
    });
    expect((await call(app, 'PATCH', url, { sid: pm, body: { role: 'VIEWER' } })).statusCode).toBe(
      200,
    );
  });

  it('deleting a team keeps its members in the project', async () => {
    const pm = await sid('pm');
    expect((await call(app, 'DELETE', `${teams()}/${teamId}`, { sid: pm })).statusCode).toBe(204);
    expect(await prisma.projectMember.count({ where: { projectId, userId: ids.member } })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: AuditAction.TEAM_DELETED },
    });
    expect(audit.meta).toMatchObject({ name: 'Backend', members: 1 });
  });

  it('accepts the TEAMS visibility scope for members', async () => {
    const res = await call(app, 'PATCH', `/api/v1/projects/${projectId}/members/${ids.viewer}`, {
      sid: await sid('pm'),
      body: { visibility: 'TEAMS' },
    });
    expect(res.json()).toMatchObject({ visibility: 'TEAMS' });
    const asViewer = await call(app, 'GET', `/api/v1/projects/${projectId}`, {
      sid: await sid('viewer'),
    });
    expect((asViewer.json() as ProjectDto).myVisibility).toBe('TEAMS');
  });

  it('refuses team changes on archived projects but still lists teams', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    const pm = await sid('pm');
    const create = await call(app, 'POST', teams(), { sid: pm, body: { name: 'Frontend' } });
    expect(create.statusCode).toBe(409);
    expect(codeOf(create)).toBe(ErrorCode.PROJECT_ARCHIVED);
    expect((await call(app, 'GET', teams(), { sid: pm })).statusCode).toBe(200);
  });
  it('rejects renaming to a duplicate name and explicit nulls', async () => {
    const pm = await sid('pm');
    await seedTeam(prisma, projectId, 'Frontend');
    const dup = await call(app, 'PATCH', `${teams()}/${teamId}`, {
      sid: pm,
      body: { name: 'Frontend' },
    });
    expect(dup.statusCode).toBe(409);
    for (const body of [{ name: null }, { description: null }]) {
      expect((await call(app, 'PATCH', `${teams()}/${teamId}`, { sid: pm, body })).statusCode).toBe(
        400,
      );
    }
  });

  it('refuses promoting a project Viewer who is a team Member to team Lead', async () => {
    await prisma.teamMember.create({
      data: { teamId, projectId, userId: ids.viewer, role: 'MEMBER' },
    });
    const res = await call(app, 'PUT', `${teams()}/${teamId}/members/${ids.viewer}`, {
      sid: await sid('pm'),
      body: { role: 'LEAD' },
    });
    expect(res.statusCode).toBe(400);
    expect(
      (await prisma.teamMember.findFirstOrThrow({ where: { teamId, userId: ids.viewer } })).role,
    ).toBe('MEMBER');
  });

  it('refuses team membership changes on archived projects', async () => {
    await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    const pm = await sid('pm');
    const put = await call(app, 'PUT', `${teams()}/${teamId}/members/${ids.lead}`, {
      sid: pm,
      body: { role: 'MEMBER' },
    });
    expect(codeOf(put)).toBe(ErrorCode.PROJECT_ARCHIVED);
    const del = await call(app, 'DELETE', `${teams()}/${teamId}/members/${ids.member}`, {
      sid: pm,
    });
    expect(codeOf(del)).toBe(ErrorCode.PROJECT_ARCHIVED);
    // Admins' PM-assignment exception does not extend to teams.
    const admin = await call(app, 'POST', teams(), {
      sid: await sid('admin'),
      body: { name: 'Frontend' },
    });
    expect(admin.statusCode).toBe(403);
  });

  it('lets an admin who is a PM of the project manage teams', async () => {
    await prisma.projectMember.create({ data: { projectId, userId: ids.admin, role: 'PM' } });
    const res = await call(app, 'POST', teams(), {
      sid: await sid('admin'),
      body: { name: 'Frontend' },
    });
    expect(res.statusCode).toBe(201);
  });
});
