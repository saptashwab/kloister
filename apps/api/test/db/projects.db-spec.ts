import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  AuditAction,
  ErrorCode,
  type MemberCandidateDto,
  type Page,
  type ProjectDto,
  type ProjectMemberDto,
} from '@kloister/shared';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import { call, codeOf, login, resetDb, seedProject, seedUser, startApp } from './support.js';

// Project and membership endpoints against a real database, including the
// HTTP permission matrix (SPEC §3.2 rows that M2 exposes, §3.4 404 rule).

const BUCKET = '44444444-4444-4444-8444-444444444444';

describe('projects and members (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  /** Ids of the seeded users, by name. */
  let ids: Record<'admin' | 'pm' | 'lead' | 'member' | 'viewer' | 'outsider' | 'newbie', string>;
  let projectId: string;

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(prisma);
    const names = ['pm', 'lead', 'member', 'viewer', 'outsider', 'newbie'] as const;
    const admin = await seedUser(prisma, { email: 'admin@example.org', systemRole: 'ADMIN' });
    const seeded: Record<string, string> = { admin: admin.id };
    for (const name of names) {
      seeded[name] = (await seedUser(prisma, { email: `${name}@example.org` })).id;
    }
    ids = seeded;
    projectId = (
      await seedProject(prisma, 'KLO', [
        { userId: ids.pm, role: 'PM' },
        { userId: ids.lead, role: 'LEAD' },
        { userId: ids.member, role: 'MEMBER' },
        { userId: ids.viewer, role: 'VIEWER', visibility: 'OWN' },
      ])
    ).id;
  });

  /**
   * Signs in a seeded user by name.
   *
   * @param name Seeded user name.
   * @returns Session token.
   */
  const sid = (name: keyof typeof ids): Promise<string> => login(app, `${name}@example.org`);

  describe('permission matrix', () => {
    type Caller = 'pm' | 'lead' | 'member' | 'viewer' | 'outsider' | 'admin';
    type Route = {
      name: string;
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      url: () => string;
      body?: () => object;
      // Expected status per caller: PM, Lead, Member, Viewer, non-member, non-member admin.
      expect: Record<Caller, number>;
    };
    const base = () => `/api/v1/projects/${projectId}`;
    // Ordered so the PM's run succeeds end to end (the newbie is added, then removed).
    const routes: Route[] = [
      {
        name: 'view project',
        method: 'GET',
        url: base,
        expect: { pm: 200, lead: 200, member: 200, viewer: 200, outsider: 404, admin: 200 },
      },
      {
        name: 'view project by key',
        method: 'GET',
        url: () => '/api/v1/projects/klo',
        expect: { pm: 200, lead: 200, member: 200, viewer: 200, outsider: 404, admin: 200 },
      },
      {
        name: 'list members',
        method: 'GET',
        url: () => `${base()}/members`,
        expect: { pm: 200, lead: 200, member: 200, viewer: 200, outsider: 404, admin: 200 },
      },
      {
        name: 'edit project settings',
        method: 'PATCH',
        url: base,
        body: () => ({ name: 'Renamed', settings: { membersCanAssignOthers: true } }),
        expect: { pm: 200, lead: 403, member: 403, viewer: 403, outsider: 404, admin: 403 },
      },
      {
        name: 'search member candidates',
        method: 'GET',
        url: () => `${base()}/member-candidates`,
        expect: { pm: 200, lead: 403, member: 403, viewer: 403, outsider: 404, admin: 403 },
      },
      {
        name: 'add member',
        method: 'POST',
        url: () => `${base()}/members`,
        body: () => ({ userId: ids.newbie, role: 'MEMBER' }),
        expect: { pm: 201, lead: 403, member: 403, viewer: 403, outsider: 404, admin: 403 },
      },
      {
        name: 'change member role and visibility',
        method: 'PATCH',
        url: () => `${base()}/members/${ids.viewer}`,
        body: () => ({ role: 'MEMBER', visibility: 'BUCKETS', allowedBucketIds: [BUCKET] }),
        expect: { pm: 200, lead: 403, member: 403, viewer: 403, outsider: 404, admin: 403 },
      },
      {
        name: 'remove member',
        method: 'DELETE',
        url: () => `${base()}/members/${ids.newbie}`,
        expect: { pm: 204, lead: 403, member: 403, viewer: 403, outsider: 404, admin: 403 },
      },
      {
        name: 'archive project',
        method: 'POST',
        url: () => `${base()}/archive`,
        expect: { pm: 200, lead: 403, member: 403, viewer: 403, outsider: 404, admin: 403 },
      },
      {
        name: 'unarchive project',
        method: 'POST',
        url: () => `${base()}/unarchive`,
        expect: { pm: 200, lead: 403, member: 403, viewer: 403, outsider: 404, admin: 403 },
      },
    ];

    it.each(['pm', 'lead', 'member', 'viewer', 'outsider', 'admin'] as const)(
      'enforces every project route for %s',
      async (caller) => {
        const session = await sid(caller);
        const before = await prisma.projectMember.findMany({ orderBy: { id: 'asc' } });
        for (const route of routes) {
          const res = await call(app, route.method, route.url(), {
            sid: session,
            ...(route.body === undefined ? {} : { body: route.body() }),
          });
          expect({ route: route.name, status: res.statusCode }).toEqual({
            route: route.name,
            status: route.expect[caller],
          });
          if (res.statusCode === 404) expect(codeOf(res)).toBe(ErrorCode.NOT_FOUND);
          if (res.statusCode === 403) expect(codeOf(res)).toBe(ErrorCode.FORBIDDEN);
        }
        if (caller !== 'pm') {
          // Refused callers changed nothing.
          expect(await prisma.projectMember.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
          expect((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).name).toBe(
            'Project KLO',
          );
        }
      },
    );

    it('audits every request by a non-member admin and none by members (SPEC §3.1)', async () => {
      const admin = await sid('admin');
      await call(app, 'GET', `/api/v1/projects/${projectId}`, { sid: admin });
      await call(app, 'GET', `/api/v1/projects/${projectId}/members`, { sid: admin });
      await call(app, 'PATCH', `/api/v1/projects/${projectId}`, {
        sid: admin,
        body: { name: 'X' },
      });
      const pm = await sid('pm');
      await call(app, 'GET', `/api/v1/projects/${projectId}`, { sid: pm });

      const entries = await prisma.auditLog.findMany({
        where: { action: AuditAction.ADMIN_CROSS_PROJECT_ACCESS },
      });
      // Sorted: entries written within the same millisecond have no stable order.
      expect(
        entries.map((e) => [e.actorId, e.projectId, (e.meta as { via: string }).via]).sort(),
      ).toEqual([
        [ids.admin, projectId, 'GET /api/v1/projects/:id'],
        [ids.admin, projectId, 'GET /api/v1/projects/:id/members'],
        [ids.admin, projectId, 'PATCH /api/v1/projects/:id'],
      ]);
    });

    it('binds an admin who is a member to their membership, unaudited', async () => {
      await prisma.projectMember.create({
        data: { projectId, userId: ids.admin, role: 'VIEWER', visibility: 'OWN' },
      });
      const admin = await sid('admin');
      const get = await call(app, 'GET', `/api/v1/projects/${projectId}`, { sid: admin });
      expect(get.json()).toMatchObject({ myRole: 'VIEWER', myVisibility: 'OWN' });
      const patch = await call(app, 'PATCH', `/api/v1/projects/${projectId}`, {
        sid: admin,
        body: { name: 'X' },
      });
      expect(patch.statusCode).toBe(403);
      expect(
        await prisma.auditLog.count({ where: { action: AuditAction.ADMIN_CROSS_PROJECT_ACCESS } }),
      ).toBe(0);
    });

    it('refuses project routes to users who must change their password', async () => {
      const pm = await sid('pm');
      await prisma.user.update({ where: { id: ids.pm }, data: { mustChangePassword: true } });
      for (const url of ['/api/v1/projects', `/api/v1/projects/${projectId}`]) {
        const res = await call(app, 'GET', url, { sid: pm });
        expect(res.statusCode).toBe(403);
        expect(codeOf(res)).toBe(ErrorCode.PASSWORD_CHANGE_REQUIRED);
      }
    });

    it('answers 404 before validating the body for non-members', async () => {
      const res = await call(app, 'POST', `/api/v1/projects/${projectId}/members`, {
        sid: await sid('outsider'),
        body: { nonsense: true },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for unknown projects and malformed references', async () => {
      const pm = await sid('pm');
      for (const ref of ['00000000-0000-4000-8000-000000000000', 'NOPE', 'bad%20ref']) {
        expect((await call(app, 'GET', `/api/v1/projects/${ref}`, { sid: pm })).statusCode).toBe(
          404,
        );
      }
    });
  });

  describe('create (admins only)', () => {
    it('creates a project with its first PM and audits both', async () => {
      const res = await call(app, 'POST', '/api/v1/projects', {
        sid: await sid('admin'),
        body: { key: 'abc', name: ' New ', description: 'About', pmUserId: ids.newbie },
      });
      expect(res.statusCode).toBe(201);
      const project = res.json() as ProjectDto;
      expect(project).toMatchObject({
        key: 'ABC',
        name: 'New',
        description: 'About',
        myRole: null,
        settings: { membersCanAssignOthers: false },
      });
      const members = await prisma.projectMember.findMany({ where: { projectId: project.id } });
      expect(members.map((m) => [m.userId, m.role])).toEqual([[ids.newbie, 'PM']]);
      const actions = (
        await prisma.auditLog.findMany({
          where: { projectId: project.id },
          orderBy: { action: 'asc' },
        })
      ).map((e) => e.action);
      expect(actions).toEqual([AuditAction.MEMBER_ADDED, AuditAction.PROJECT_CREATED]);

      // The new PM can open and manage it.
      const pmView = await call(app, 'GET', '/api/v1/projects/ABC', { sid: await sid('newbie') });
      expect((pmView.json() as ProjectDto).myRole).toBe('PM');
    });

    it('is forbidden to non-admins, including PMs', async () => {
      const res = await call(app, 'POST', '/api/v1/projects', {
        sid: await sid('pm'),
        body: { key: 'ABC', name: 'X', pmUserId: ids.pm },
      });
      expect(res.statusCode).toBe(403);
      expect(await prisma.project.count()).toBe(1);
    });

    it('rejects duplicate keys, bad keys and inactive or unknown PMs', async () => {
      const admin = await sid('admin');
      const create = (body: object) => call(app, 'POST', '/api/v1/projects', { sid: admin, body });
      expect(codeOf(await create({ key: 'klo', name: 'X', pmUserId: ids.pm }))).toBe(
        ErrorCode.CONFLICT,
      );
      for (const key of ['K', 'TOOLONG', 'AB1', 'A B']) {
        expect((await create({ key, name: 'X', pmUserId: ids.pm })).statusCode).toBe(400);
      }
      await prisma.user.update({ where: { id: ids.newbie }, data: { isActive: false } });
      expect((await create({ key: 'ABC', name: 'X', pmUserId: ids.newbie })).statusCode).toBe(400);
      expect(
        (await create({ key: 'ABC', name: 'X', pmUserId: '00000000-0000-4000-8000-000000000000' }))
          .statusCode,
      ).toBe(400);
      expect(await prisma.project.count()).toBe(1);
    });
  });

  describe('list', () => {
    beforeEach(async () => {
      await seedProject(prisma, 'OLD', [{ userId: ids.pm, role: 'PM' }], {
        archivedAt: new Date(),
      });
      await seedProject(prisma, 'OTH', [{ userId: ids.outsider, role: 'PM' }]);
    });

    /**
     * Lists projects and returns their keys.
     *
     * @param name Caller.
     * @param query Query string.
     * @returns The response status and keys.
     */
    async function keys(name: keyof typeof ids, query = '') {
      const res = await call(app, 'GET', `/api/v1/projects${query}`, { sid: await sid(name) });
      return {
        status: res.statusCode,
        keys:
          res.statusCode === 200 ? (res.json() as Page<ProjectDto>).items.map((p) => p.key) : [],
      };
    }

    it("shows only the caller's own, unarchived projects by default", async () => {
      expect(await keys('pm')).toEqual({ status: 200, keys: ['KLO'] });
      expect(await keys('pm', '?includeArchived=true')).toEqual({
        status: 200,
        keys: ['KLO', 'OLD'],
      });
      expect(await keys('newbie')).toEqual({ status: 200, keys: [] });
      // An admin's "mine" is their memberships too.
      expect(await keys('admin')).toEqual({ status: 200, keys: [] });
    });

    it('lists all projects for admins only, without auditing', async () => {
      expect(await keys('admin', '?scope=all')).toEqual({ status: 200, keys: ['KLO', 'OTH'] });
      expect((await keys('pm', '?scope=all')).status).toBe(403);
      expect(
        await prisma.auditLog.count({ where: { action: AuditAction.ADMIN_CROSS_PROJECT_ACCESS } }),
      ).toBe(0);
    });

    it("reports the caller's role and permissions", async () => {
      const res = await call(app, 'GET', '/api/v1/projects', { sid: await sid('viewer') });
      const [project] = (res.json() as Page<ProjectDto>).items;
      expect(project).toMatchObject({
        myRole: 'VIEWER',
        myVisibility: 'OWN',
        myPermissions: ['VIEW_ITEMS'],
      });
    });

    it('searches by key or name and paginates', async () => {
      expect(await keys('admin', '?scope=all&q=oth')).toEqual({ status: 200, keys: ['OTH'] });
      const first = await call(app, 'GET', '/api/v1/projects?scope=all&limit=1', {
        sid: await sid('admin'),
      });
      const page = first.json() as Page<ProjectDto>;
      expect(page.items).toHaveLength(1);
      const second = await call(
        app,
        'GET',
        `/api/v1/projects?scope=all&limit=1&cursor=${page.nextCursor ?? ''}`,
        { sid: await sid('admin') },
      );
      expect((second.json() as Page<ProjectDto>).items.map((p) => p.key)).toEqual(['OTH']);
    });
  });

  describe('settings and archiving', () => {
    it('updates name, description and the assignment setting, keeping the key', async () => {
      const pm = await sid('pm');
      const res = await call(app, 'PATCH', `/api/v1/projects/${projectId}`, {
        sid: pm,
        body: { name: 'Renamed', description: 'Text', settings: { membersCanAssignOthers: true } },
      });
      expect(res.json()).toMatchObject({
        key: 'KLO',
        name: 'Renamed',
        settings: { membersCanAssignOthers: true },
      });
      // The setting now grants Members ASSIGN_OTHERS.
      const asMember = await call(app, 'GET', `/api/v1/projects/${projectId}`, {
        sid: await sid('member'),
      });
      expect((asMember.json() as ProjectDto).myPermissions).toContain('ASSIGN_OTHERS');

      expect(
        (
          await call(app, 'PATCH', `/api/v1/projects/${projectId}`, {
            sid: pm,
            body: { key: 'NEW' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call(app, 'PATCH', `/api/v1/projects/${projectId}`, {
            sid: pm,
            body: { name: null },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await call(app, 'PATCH', `/api/v1/projects/${projectId}`, {
            sid: pm,
            body: { settings: [{ membersCanAssignOthers: false }] },
          })
        ).statusCode,
      ).toBe(400);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.PROJECT_UPDATED },
      });
      expect(audit.projectId).toBe(projectId);
    });

    it('makes archived projects read-only until unarchived', async () => {
      const pm = await sid('pm');
      const url = `/api/v1/projects/${projectId}`;
      expect((await call(app, 'POST', `${url}/archive`, { sid: pm })).statusCode).toBe(200);

      const patch = await call(app, 'PATCH', url, { sid: pm, body: { name: 'X' } });
      expect(patch.statusCode).toBe(409);
      expect(codeOf(patch)).toBe(ErrorCode.PROJECT_ARCHIVED);
      const add = await call(app, 'POST', `${url}/members`, {
        sid: pm,
        body: { userId: ids.newbie, role: 'MEMBER' },
      });
      expect(codeOf(add)).toBe(ErrorCode.PROJECT_ARCHIVED);
      // Reads still work for every member, including reads that need PM rights.
      for (const name of ['lead', 'member', 'viewer'] as const) {
        const s = await sid(name);
        expect((await call(app, 'GET', url, { sid: s })).statusCode).toBe(200);
        expect((await call(app, 'GET', `${url}/members`, { sid: s })).statusCode).toBe(200);
      }
      expect((await call(app, 'GET', `${url}/member-candidates`, { sid: pm })).statusCode).toBe(
        200,
      );
      // Role checks still come first: a Lead cannot unarchive.
      const leadUnarchive = await call(app, 'POST', `${url}/unarchive`, { sid: await sid('lead') });
      expect(leadUnarchive.statusCode).toBe(403);

      const unarchived = await call(app, 'POST', `${url}/unarchive`, { sid: pm });
      expect((unarchived.json() as ProjectDto).archivedAt).toBeNull();
      expect((await call(app, 'PATCH', url, { sid: pm, body: { name: 'X' } })).statusCode).toBe(
        200,
      );
      const actions = (await prisma.auditLog.findMany({ where: { projectId } }))
        .map((e) => e.action)
        .sort();
      expect(actions).toEqual([
        AuditAction.PROJECT_ARCHIVED,
        AuditAction.PROJECT_UNARCHIVED,
        AuditAction.PROJECT_UPDATED,
      ]);
    });
  });

  describe('members', () => {
    const url = () => `/api/v1/projects/${projectId}/members`;

    it('lists members with user details but no secrets', async () => {
      const res = await call(app, 'GET', url(), { sid: await sid('viewer') });
      const page = res.json() as Page<ProjectMemberDto>;
      // Sorted: the seeded members share one insert timestamp.
      expect(page.items.map((m) => [m.email, m.role]).sort()).toEqual([
        ['lead@example.org', 'LEAD'],
        ['member@example.org', 'MEMBER'],
        ['pm@example.org', 'PM'],
        ['viewer@example.org', 'VIEWER'],
      ]);
      expect(JSON.stringify(page)).not.toContain('passwordHash');
    });

    it('offers only active non-members as candidates', async () => {
      await prisma.user.update({ where: { id: ids.outsider }, data: { isActive: false } });
      const res = await call(app, 'GET', `/api/v1/projects/${projectId}/member-candidates`, {
        sid: await sid('pm'),
      });
      const emails = (res.json() as MemberCandidateDto[]).map((c) => c.email).sort();
      expect(emails).toEqual(['admin@example.org', 'newbie@example.org']);
      const search = await call(
        app,
        'GET',
        `/api/v1/projects/${projectId}/member-candidates?q=NEW`,
        {
          sid: await sid('pm'),
        },
      );
      expect((search.json() as MemberCandidateDto[]).map((c) => c.email)).toEqual([
        'newbie@example.org',
      ]);
    });

    it('adds members, normalising PM/Lead visibility, and rejects duplicates and inactive users', async () => {
      const pm = await sid('pm');
      const added = await call(app, 'POST', url(), {
        sid: pm,
        body: { userId: ids.newbie, role: 'LEAD', visibility: 'OWN', allowedBucketIds: [BUCKET] },
      });
      expect(added.statusCode).toBe(201);
      expect(added.json()).toMatchObject({ role: 'LEAD', visibility: 'ALL', allowedBucketIds: [] });

      const dup = await call(app, 'POST', url(), {
        sid: pm,
        body: { userId: ids.newbie, role: 'MEMBER' },
      });
      expect(dup.statusCode).toBe(409);

      await prisma.user.update({ where: { id: ids.outsider }, data: { isActive: false } });
      const inactive = await call(app, 'POST', url(), {
        sid: pm,
        body: { userId: ids.outsider, role: 'MEMBER' },
      });
      expect(inactive.statusCode).toBe(400);
      const badRole = await call(app, 'POST', url(), {
        sid: pm,
        body: { userId: ids.outsider, role: 'OWNER' },
      });
      expect(badRole.statusCode).toBe(400);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.MEMBER_ADDED },
      });
      expect(audit).toMatchObject({ actorId: ids.pm, projectId });
    });

    it('stores bucket scopes and returns 404 for non-members', async () => {
      const pm = await sid('pm');
      const res = await call(app, 'PATCH', `${url()}/${ids.member}`, {
        sid: pm,
        body: { visibility: 'BUCKETS', allowedBucketIds: [BUCKET] },
      });
      expect(res.json()).toMatchObject({ visibility: 'BUCKETS', allowedBucketIds: [BUCKET] });
      const missing = await call(app, 'PATCH', `${url()}/${ids.outsider}`, {
        sid: pm,
        body: { role: 'VIEWER' },
      });
      expect(missing.statusCode).toBe(404);
      const malformed = await call(app, 'DELETE', `${url()}/abc`, { sid: pm });
      expect(malformed.statusCode).toBe(400);
    });

    it('never removes or demotes the last active PM (SPEC §3.2)', async () => {
      const pm = await sid('pm');
      const demote = await call(app, 'PATCH', `${url()}/${ids.pm}`, {
        sid: pm,
        body: { role: 'LEAD' },
      });
      expect(demote.statusCode).toBe(409);
      expect(codeOf(demote)).toBe(ErrorCode.LAST_PM);
      expect(codeOf(await call(app, 'DELETE', `${url()}/${ids.pm}`, { sid: pm }))).toBe(
        ErrorCode.LAST_PM,
      );

      // A deactivated second PM does not count.
      await call(app, 'PATCH', `${url()}/${ids.lead}`, { sid: pm, body: { role: 'PM' } });
      await prisma.user.update({ where: { id: ids.lead }, data: { isActive: false } });
      expect(
        codeOf(
          await call(app, 'PATCH', `${url()}/${ids.pm}`, { sid: pm, body: { role: 'MEMBER' } }),
        ),
      ).toBe(ErrorCode.LAST_PM);

      // With an active second PM, the first may step down and loses PM rights.
      await prisma.user.update({ where: { id: ids.lead }, data: { isActive: true } });
      const stepDown = await call(app, 'PATCH', `${url()}/${ids.pm}`, {
        sid: pm,
        body: { role: 'MEMBER' },
      });
      expect(stepDown.statusCode).toBe(200);
      const after = await call(app, 'POST', url(), {
        sid: pm,
        body: { userId: ids.newbie, role: 'MEMBER' },
      });
      expect(after.statusCode).toBe(403);
    });

    it('lets a PM remove themselves while another active PM remains', async () => {
      const pm = await sid('pm');
      await call(app, 'PATCH', `${url()}/${ids.lead}`, { sid: pm, body: { role: 'PM' } });
      expect((await call(app, 'DELETE', `${url()}/${ids.pm}`, { sid: pm })).statusCode).toBe(204);
      // No longer a member: the project disappears for them.
      expect(
        (await call(app, 'GET', `/api/v1/projects/${projectId}`, { sid: pm })).statusCode,
      ).toBe(404);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.MEMBER_REMOVED },
      });
      expect(audit.meta).toMatchObject({ userId: ids.pm, role: 'PM' });
    });
  });
});
