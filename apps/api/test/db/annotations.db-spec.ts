import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  AuditAction,
  type AttachmentDto,
  ErrorCode,
  type InlineImageDto,
  inlineImagePath,
  type NoteDto,
  type Page,
  type WorkItemDetailDto,
} from '@kloister/shared';
import { AttachmentsService } from '../../src/annotations/attachments.service.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  ATTACHMENTS_DIR,
  call,
  codeOf,
  GIF,
  login,
  type Res,
  resetDb,
  seedAttachment,
  seedBucket,
  seedItem,
  seedNote,
  seedProject,
  seedTeam,
  seedUser,
  startApp,
  storedFileExists,
  upload,
} from './support.js';

// Notes, attachments and inline images against a real database: the HTTP
// permission tests for the SPEC §3.2 row "Notes and attachments on visible
// items", every visibility scope of §3.3 and the team rules of §3.5, plus
// the storage rules of §5 (sanitizing, same-item images, content-checked
// types, size limit, quota, download headers).

const NAMES = [
  'admin',
  'pm',
  'lead',
  'member',
  'member2',
  'viewer',
  'teamLead',
  'outsider',
] as const;
type Name = (typeof NAMES)[number];
type Caller = 'pm' | 'lead' | 'member' | 'viewer' | 'outsider' | 'admin';
const CALLERS: Caller[] = ['pm', 'lead', 'member', 'viewer', 'outsider', 'admin'];

/** An SVG, which must never be accepted as an image. */
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('notes, attachments and inline images (db)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let ids: Record<Name, string>;
  let projectId: string;
  let buckets: Record<'todo' | 'doing', string>;
  let t1: string;
  /** theirs: PM's item in To Do. teamItem: PM's item in team T1. doingItem: PM's item in Doing. */
  let items: Record<'theirs' | 'teamItem' | 'doingItem', { id: string; number: number }>;
  /** Seeded on `theirs`. */
  let memberNote: string;
  let pmNote: string;
  let memberFile: string;
  let image: string;
  let sessions: Partial<Record<Name, string>> = {};

  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    sessions = {};
    await resetDb(prisma);
    const seeded: Partial<Record<Name, string>> = {};
    for (const name of NAMES) {
      seeded[name] = (
        await seedUser(prisma, {
          email: `${name.toLowerCase()}@example.org`,
          systemRole: name === 'admin' ? 'ADMIN' : 'USER',
        })
      ).id;
    }
    ids = seeded as Record<Name, string>;
    projectId = (
      await seedProject(prisma, 'KLO', [
        { userId: ids.pm, role: 'PM' },
        { userId: ids.lead, role: 'LEAD' },
        { userId: ids.member, role: 'MEMBER' },
        { userId: ids.member2, role: 'MEMBER' },
        { userId: ids.viewer, role: 'VIEWER' },
        { userId: ids.teamLead, role: 'MEMBER', visibility: 'OWN' },
      ])
    ).id;
    buckets = {
      todo: (await seedBucket(prisma, projectId, 'To Do')).id,
      doing: (await seedBucket(prisma, projectId, 'Doing')).id,
    };
    t1 = (
      await seedTeam(prisma, projectId, 'T1', [
        { userId: ids.teamLead, role: 'LEAD' },
        { userId: ids.member, role: 'MEMBER' },
      ])
    ).id;
    const pm = ids.pm;
    const theirs = await seedItem(prisma, projectId, { createdById: pm, bucketId: buckets.todo });
    const teamItem = await seedItem(prisma, projectId, {
      createdById: pm,
      bucketId: buckets.todo,
      teamId: t1,
    });
    const doingItem = await seedItem(prisma, projectId, {
      createdById: pm,
      bucketId: buckets.doing,
    });
    items = { theirs, teamItem, doingItem };
    memberNote = (await seedNote(prisma, theirs.id, ids.member)).id;
    pmNote = (await seedNote(prisma, theirs.id, pm)).id;
    memberFile = (await seedAttachment(prisma, projectId, theirs.id, ids.member)).id;
    image = (await seedAttachment(prisma, projectId, theirs.id, ids.member, { inline: true })).id;
  });

  const base = (n: number | string) => `/api/v1/projects/${projectId}/items/${n}`;
  const notes = (n: number | string) => `${base(n)}/notes`;
  const files = (n: number | string) => `${base(n)}/attachments`;
  const images = (n: number | string) => `${base(n)}/images`;

  /**
   * Signs in a seeded user once per test.
   *
   * @param name Seeded user.
   * @returns The session token.
   */
  async function sid(name: Name): Promise<string> {
    return (sessions[name] ??= await login(app, `${name.toLowerCase()}@example.org`));
  }

  /**
   * Sends one JSON request as a seeded user.
   *
   * @param name Seeded user.
   * @param method HTTP method.
   * @param url Path.
   * @param body JSON body.
   * @returns The response.
   */
  async function as(
    name: Name,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: object,
  ): Promise<Res> {
    return call(app, method, url, {
      sid: await sid(name),
      ...(body === undefined ? {} : { body }),
    });
  }

  /**
   * Uploads bytes as a seeded user.
   *
   * @param name Seeded user.
   * @param url Upload path.
   * @param bytes Content.
   * @param fileName File name.
   * @returns The response.
   */
  async function send(name: Name, url: string, bytes = GIF, fileName = 'file.gif'): Promise<Res> {
    return upload(app, url, await sid(name), bytes, fileName);
  }

  /**
   * Changes a member's stored visibility directly.
   *
   * @param name Seeded user.
   * @param visibility New scope.
   * @param allowedBucketIds Buckets for the BUCKETS scope.
   */
  async function setScope(
    name: Name,
    visibility: 'ALL' | 'BUCKETS' | 'OWN' | 'TEAMS',
    allowedBucketIds: string[] = [],
  ): Promise<void> {
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId: ids[name] } },
      data: { visibility, allowedBucketIds },
    });
  }

  /**
   * What a refused request must leave unchanged.
   *
   * @returns Counts of notes, attachments, audit entries and stored files.
   */
  async function snapshot() {
    return {
      notes: await prisma.note.findMany({ orderBy: { id: 'asc' } }),
      attachments: await prisma.attachment.count(),
      audit: await prisma.auditLog.count({
        where: {
          action: { notIn: [AuditAction.ADMIN_CROSS_PROJECT_ACCESS, AuditAction.LOGIN_SUCCEEDED] },
        },
      }),
      files: (await readdir(join(ATTACHMENTS_DIR, projectId))).length,
    };
  }

  describe('permission matrix (SPEC §3.2 "Notes and attachments on visible items")', () => {
    // Non-members get 404; admins who are not members are read-only (403 on writes).
    const read = { pm: 200, lead: 200, member: 200, viewer: 200, outsider: 404, admin: 200 };
    const annotate = (ok: number) => ({
      pm: ok,
      lead: ok,
      member: ok,
      viewer: 403,
      outsider: 404,
      admin: 403,
    });
    type Row = {
      name: string;
      request: (caller: Caller) => Promise<Res>;
      expect: Record<Caller, number>;
    };
    const ROWS: Row[] = [
      {
        name: 'list notes',
        request: (c) => as(c, 'GET', notes(items.theirs.number)),
        expect: read,
      },
      {
        name: 'add a note',
        request: (c) => as(c, 'POST', notes(items.theirs.number), { body: '<p>Hello</p>' }),
        expect: annotate(201),
      },
      {
        name: 'edit a note (the Member wrote it)',
        request: (c) =>
          as(c, 'PATCH', `${notes(items.theirs.number)}/${memberNote}`, { body: '<p>Edited</p>' }),
        expect: { pm: 403, lead: 403, member: 200, viewer: 403, outsider: 404, admin: 403 },
      },
      {
        name: 'edit a note (the PM wrote it)',
        request: (c) =>
          as(c, 'PATCH', `${notes(items.theirs.number)}/${pmNote}`, { body: '<p>Edited</p>' }),
        expect: { pm: 200, lead: 403, member: 403, viewer: 403, outsider: 404, admin: 403 },
      },
      {
        name: 'delete a note (the Member wrote it)',
        request: (c) => as(c, 'DELETE', `${notes(items.theirs.number)}/${memberNote}`),
        expect: annotate(204),
      },
      {
        name: 'delete a note (the PM wrote it)',
        request: (c) => as(c, 'DELETE', `${notes(items.theirs.number)}/${pmNote}`),
        expect: { pm: 204, lead: 204, member: 403, viewer: 403, outsider: 404, admin: 403 },
      },
      {
        name: 'list attachments',
        request: (c) => as(c, 'GET', files(items.theirs.number)),
        expect: read,
      },
      {
        name: 'upload an attachment',
        request: (c) => send(c, files(items.theirs.number)),
        expect: annotate(201),
      },
      {
        name: 'download an attachment',
        request: (c) => as(c, 'GET', `${files(items.theirs.number)}/${memberFile}`),
        expect: read,
      },
      {
        name: 'delete an attachment (the Member uploaded it)',
        request: (c) => as(c, 'DELETE', `${files(items.theirs.number)}/${memberFile}`),
        expect: annotate(204),
      },
      {
        name: 'upload an inline image',
        request: (c) => send(c, images(items.theirs.number)),
        expect: annotate(201),
      },
      {
        name: 'view an inline image',
        request: (c) => as(c, 'GET', `${images(items.theirs.id)}/${image}`),
        expect: read,
      },
    ];

    for (const row of ROWS) {
      for (const caller of CALLERS) {
        it(`${row.name}: ${caller} → ${row.expect[caller]}`, async () => {
          await sid(caller);
          const before = await snapshot();
          const res = await row.request(caller);
          expect(res.statusCode).toBe(row.expect[caller]);
          if (res.statusCode === 404) expect(codeOf(res)).toBe(ErrorCode.NOT_FOUND);
          if (res.statusCode === 403) expect(codeOf(res)).toBe(ErrorCode.FORBIDDEN);
          if (res.statusCode >= 400) {
            // A refused request changes nothing, on disk either.
            expect(await snapshot()).toEqual(before);
          }
        });
      }
    }

    it("a Member cannot delete another Member's attachment", async () => {
      const theirs = (await seedAttachment(prisma, projectId, items.theirs.id, ids.member2)).id;
      const url = `${files(items.theirs.number)}/${theirs}`;
      await sid('member');
      const before = await snapshot();
      const refused = await as('member', 'DELETE', url);
      expect(refused.statusCode).toBe(403);
      expect(await snapshot()).toEqual(before);
      expect((await as('member2', 'DELETE', url)).statusCode).toBe(204);
    });

    it('never serves an image or attachment through another item or the other route', async () => {
      // `image` and `memberFile` belong to `theirs`.
      const elsewhere = images(items.teamItem.id);
      expect((await as('pm', 'GET', `${elsewhere}/${image}`)).statusCode).toBe(404);
      expect(
        (await as('pm', 'GET', `${files(items.teamItem.number)}/${memberFile}`)).statusCode,
      ).toBe(404);
      expect((await as('pm', 'GET', `${images(items.theirs.id)}/${memberFile}`)).statusCode).toBe(
        404,
      );
      expect((await as('pm', 'GET', `${files(items.theirs.number)}/${image}`)).statusCode).toBe(
        404,
      );
      expect((await as('pm', 'DELETE', `${files(items.theirs.number)}/${image}`)).statusCode).toBe(
        404,
      );
      expect(await prisma.attachment.count({ where: { id: image } })).toBe(1);
    });

    it('reports note and attachment capabilities that match the rules', async () => {
      const list = async (name: Name) =>
        ((await as(name, 'GET', notes(items.theirs.number))).json() as Page<NoteDto>).items;
      const byId = (rows: NoteDto[], id: string) => rows.find((n) => n.id === id)?.can;
      const member = await list('member');
      expect(byId(member, memberNote)).toEqual({ edit: true, delete: true });
      expect(byId(member, pmNote)).toEqual({ edit: false, delete: false });
      const lead = await list('lead');
      expect(byId(lead, memberNote)).toEqual({ edit: false, delete: true });
      const viewer = await list('viewer');
      expect(byId(viewer, memberNote)).toEqual({ edit: false, delete: false });
      const attachments = (
        await as('member2', 'GET', files(items.theirs.number))
      ).json() as Page<AttachmentDto>;
      expect(attachments.items.map((a) => [a.id, a.can])).toEqual([
        [memberFile, { edit: false, delete: false }],
      ]);
    });
  });

  describe('visibility scopes (SPEC §3.3)', () => {
    /**
     * Every annotation route for one item, as a Member.
     *
     * @param name The caller.
     * @param item The item.
     * @param item.id Item id.
     * @param item.number Item number.
     * @returns Status code per route.
     */
    async function everyRoute(name: Name, item: { id: string; number: number }) {
      const note = (await seedNote(prisma, item.id, ids[name])).id;
      const file = (await seedAttachment(prisma, projectId, item.id, ids[name])).id;
      const img = (await seedAttachment(prisma, projectId, item.id, ids[name], { inline: true }))
        .id;
      const n = item.number;
      return {
        listNotes: (await as(name, 'GET', notes(n))).statusCode,
        addNote: (await as(name, 'POST', notes(n), { body: 'x' })).statusCode,
        editNote: (await as(name, 'PATCH', `${notes(n)}/${note}`, { body: 'x' })).statusCode,
        deleteNote: (await as(name, 'DELETE', `${notes(n)}/${note}`)).statusCode,
        listFiles: (await as(name, 'GET', files(n))).statusCode,
        upload: (await send(name, files(n))).statusCode,
        download: (await as(name, 'GET', `${files(n)}/${file}`)).statusCode,
        deleteFile: (await as(name, 'DELETE', `${files(n)}/${file}`)).statusCode,
        uploadImage: (await send(name, images(n))).statusCode,
        viewImage: (await as(name, 'GET', `${images(item.id)}/${img}`)).statusCode,
      };
    }

    const all404 = {
      listNotes: 404,
      addNote: 404,
      editNote: 404,
      deleteNote: 404,
      listFiles: 404,
      upload: 404,
      download: 404,
      deleteFile: 404,
      uploadImage: 404,
      viewImage: 404,
    };

    it('ALL: a Member uses every route on any visible item', async () => {
      expect(await everyRoute('member', items.doingItem)).toEqual({
        listNotes: 200,
        addNote: 201,
        editNote: 200,
        deleteNote: 204,
        listFiles: 200,
        upload: 201,
        download: 200,
        deleteFile: 204,
        uploadImage: 201,
        viewImage: 200,
      });
    });

    it('BUCKETS: items outside the chosen buckets are 404 on every route', async () => {
      await setScope('member', 'BUCKETS', [buckets.todo]);
      expect(await everyRoute('member', items.doingItem)).toEqual(all404);
      expect((await as('member', 'GET', notes(items.theirs.number))).statusCode).toBe(200);
    });

    it('OWN: items neither created by nor assigned to the user are 404 on every route', async () => {
      await setScope('member', 'OWN');
      expect(await everyRoute('member', items.theirs)).toEqual(all404);
    });

    it('TEAMS: only items of the teams the user belongs to', async () => {
      await setScope('member', 'TEAMS');
      expect(
        (await as('member', 'POST', notes(items.teamItem.number), { body: 'x' })).statusCode,
      ).toBe(201);
      expect(await everyRoute('member', items.theirs)).toEqual(all404);
    });

    it('Viewers outside their scope get 404, not 403', async () => {
      await setScope('viewer', 'OWN');
      expect((await as('viewer', 'GET', notes(items.theirs.number))).statusCode).toBe(404);
      expect((await as('viewer', 'GET', `${images(items.theirs.id)}/${image}`)).statusCode).toBe(
        404,
      );
    });
  });

  describe('teams (SPEC §3.5)', () => {
    it("a team Lead annotates and moderates their team's items whatever their scope", async () => {
      // teamLead is a project Member with the OWN scope who leads T1.
      const n = items.teamItem.number;
      const note = (await seedNote(prisma, items.teamItem.id, ids.member)).id;
      const file = (await seedAttachment(prisma, projectId, items.teamItem.id, ids.member)).id;
      expect((await as('teamLead', 'POST', notes(n), { body: 'x' })).statusCode).toBe(201);
      // Moderating does not include rewriting someone else's words.
      expect((await as('teamLead', 'PATCH', `${notes(n)}/${note}`, { body: 'y' })).statusCode).toBe(
        403,
      );
      expect((await as('teamLead', 'DELETE', `${notes(n)}/${note}`)).statusCode).toBe(204);
      expect((await as('teamLead', 'DELETE', `${files(n)}/${file}`)).statusCode).toBe(204);
    });

    it('a team Lead keeps those rights under the TEAMS scope', async () => {
      await setScope('teamLead', 'TEAMS');
      const n = items.teamItem.number;
      const note = (await seedNote(prisma, items.teamItem.id, ids.member)).id;
      expect((await as('teamLead', 'POST', notes(n), { body: 'x' })).statusCode).toBe(201);
      expect((await as('teamLead', 'DELETE', `${notes(n)}/${note}`)).statusCode).toBe(204);
      expect((await as('teamLead', 'GET', notes(items.theirs.number))).statusCode).toBe(404);
    });

    it('team Lead moderation stops at the team', async () => {
      expect(
        (await as('teamLead', 'DELETE', `${notes(items.theirs.number)}/${memberNote}`)).statusCode,
      ).toBe(404);
      await setScope('teamLead', 'ALL');
      expect(
        (await as('teamLead', 'DELETE', `${notes(items.theirs.number)}/${memberNote}`)).statusCode,
      ).toBe(403);
    });

    it('team membership alone adds no moderation', async () => {
      const note = (await seedNote(prisma, items.teamItem.id, ids.pm)).id;
      expect(
        (await as('member', 'DELETE', `${notes(items.teamItem.number)}/${note}`)).statusCode,
      ).toBe(403);
    });

    it('a Viewer stored as team Lead gets no rights', async () => {
      await prisma.teamMember.create({
        data: { teamId: t1, projectId, userId: ids.viewer, role: 'LEAD' },
      });
      const note = (await seedNote(prisma, items.teamItem.id, ids.member)).id;
      const n = items.teamItem.number;
      expect((await as('viewer', 'POST', notes(n), { body: 'x' })).statusCode).toBe(403);
      expect((await as('viewer', 'DELETE', `${notes(n)}/${note}`)).statusCode).toBe(403);
      expect((await send('viewer', images(n))).statusCode).toBe(403);
    });
  });

  describe('notes (SPEC §5 sanitizing, §6 mentions)', () => {
    it('sanitizes bodies, keeps mentions of members and images of the same item only', async () => {
      const own = inlineImagePath(projectId, items.theirs.id, image);
      const elsewhere = (
        await seedAttachment(prisma, projectId, items.teamItem.id, ids.member, { inline: true })
      ).id;
      const foreign = inlineImagePath(projectId, items.teamItem.id, elsewhere);
      const res = await as('member', 'POST', notes(items.theirs.number), {
        body:
          `<p onclick="x()">Hi <span data-mention="${ids.member2}">@member2</span> ` +
          `<span data-mention="${ids.outsider}">@outsider</span></p>` +
          `<script>alert(1)</script><img src="${own}" alt="Mine">` +
          `<img src="${foreign}"><img src="https://evil.example/x.png">`,
      });
      expect(res.statusCode).toBe(201);
      const note = res.json() as NoteDto;
      expect(note.body).toBe(
        `<p>Hi <span data-mention="${ids.member2}">@member2</span> @outsider</p>` +
          `<img src="${own}" alt="Mine" />`,
      );
      expect(note.authorName).toBe('member');
      expect(note.editedAt).toBeNull();
    });

    it('refuses empty notes and marks edits', async () => {
      const empty = await as('member', 'POST', notes(items.theirs.number), {
        body: '<p> <script>x</script></p>',
      });
      expect(empty.statusCode).toBe(400);
      const edited = await as('member', 'PATCH', `${notes(items.theirs.number)}/${memberNote}`, {
        body: '<p>Changed</p>',
      });
      expect((edited.json() as NoteDto).editedAt).not.toBeNull();
    });

    it('records notes in the activity history without their text', async () => {
      await as('member', 'POST', notes(items.theirs.number), { body: '<p>Secret plan</p>' });
      await as('pm', 'DELETE', `${notes(items.theirs.number)}/${memberNote}`);
      const log = await prisma.auditLog.findMany({
        where: { entityId: items.theirs.id, action: { startsWith: 'NOTE_' } },
        orderBy: { createdAt: 'asc' },
      });
      expect(log.map((l) => l.action)).toEqual([AuditAction.NOTE_ADDED, AuditAction.NOTE_DELETED]);
      expect(JSON.stringify(log.map((l) => l.meta))).not.toContain('Secret');
    });

    it('lists notes newest first, a page at a time', async () => {
      const page = (
        await as('pm', 'GET', `${notes(items.theirs.number)}?limit=1`)
      ).json() as Page<NoteDto>;
      expect(page.items).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      const rest = (
        await as('pm', 'GET', `${notes(items.theirs.number)}?cursor=${page.nextCursor ?? ''}`)
      ).json() as Page<NoteDto>;
      expect(rest.items).toHaveLength(1);
      expect(rest.items[0]?.id).not.toBe(page.items[0]?.id);
    });

    it('keeps archived projects read-only', async () => {
      await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
      const add = await as('member', 'POST', notes(items.theirs.number), { body: 'x' });
      expect(add.statusCode).toBe(409);
      expect(codeOf(add)).toBe(ErrorCode.PROJECT_ARCHIVED);
      expect((await send('member', files(items.theirs.number))).statusCode).toBe(409);
      expect((await as('member', 'GET', notes(items.theirs.number))).statusCode).toBe(200);
    });
  });

  describe('descriptions with inline images (SPEC §5)', () => {
    it('keeps images of the item and drops any other image', async () => {
      const own = inlineImagePath(projectId, items.theirs.id, image);
      const res = await as('pm', 'PATCH', base(items.theirs.number), {
        description: `<p>Look</p><img src="${own}" alt="Shot"><img src="https://evil.example/a.png">`,
      });
      expect((res.json() as WorkItemDetailDto).description).toBe(
        `<p>Look</p><img src="${own}" alt="Shot" />`,
      );
      // The same image is not accepted in another item's description.
      const other = await as('pm', 'PATCH', base(items.doingItem.number), {
        description: `<img src="${inlineImagePath(projectId, items.doingItem.id, image)}">x`,
      });
      expect((other.json() as WorkItemDetailDto).description).toBe('x');
    });
  });

  describe('uploads (SPEC §5)', () => {
    it('stores an inline image and serves it with its type and nosniff', async () => {
      const res = await send('member', images(items.theirs.number), GIF, 'shot.gif');
      expect(res.statusCode).toBe(201);
      const created = res.json() as InlineImageDto;
      expect(created).toMatchObject({ name: 'shot.gif', mimeType: 'image/gif' });
      expect(created.url).toBe(inlineImagePath(projectId, items.theirs.id, created.id));
      const view = await as('viewer', 'GET', `/${created.url}`);
      expect(view.statusCode).toBe(200);
      expect(view.headers['content-type']).toBe('image/gif');
      expect(view.headers['x-content-type-options']).toBe('nosniff');
      expect(view.headers['content-security-policy']).toContain("default-src 'none'");
      // Inline images are not listed as attachments.
      const list = (
        await as('pm', 'GET', files(items.theirs.number))
      ).json() as Page<AttachmentDto>;
      expect(list.items.map((a) => a.id)).toEqual([memberFile]);
    });

    it('refuses SVG and anything else that is not PNG, JPEG, GIF or WebP by content', async () => {
      for (const [bytes, name] of [
        [SVG, 'drawing.svg'],
        [SVG, 'renamed.png'],
        [Buffer.from('%PDF-1.7'), 'doc.gif'],
      ] as const) {
        const before = await snapshot();
        const res = await send('member', images(items.theirs.number), bytes, name);
        expect(res.statusCode).toBe(415);
        expect(codeOf(res)).toBe(ErrorCode.UNSUPPORTED_FILE_TYPE);
        expect(await snapshot()).toEqual(before);
      }
      expect(await readdir(join(ATTACHMENTS_DIR, '.incoming'))).toEqual([]);
    });

    it('serves attachments as downloads, never as SVG', async () => {
      const res = await send('member', files(items.theirs.number), SVG, '../../Plan "März".svg');
      expect(res.statusCode).toBe(201);
      const attachment = res.json() as AttachmentDto;
      expect(attachment).toMatchObject({
        name: 'Plan "März".svg',
        mimeType: 'application/octet-stream',
      });
      const download = await as('viewer', 'GET', `/${attachment.url}`);
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-type']).toBe('application/octet-stream');
      expect(download.headers['content-disposition']).toBe(
        `attachment; filename="Plan _M_rz_.svg"; filename*=UTF-8''Plan%20%22M%C3%A4rz%22.svg`,
      );
      expect(download.headers['x-content-type-options']).toBe('nosniff');
      expect(download.headers['cache-control']).toBe('private, no-store');
      expect((download as unknown as { body: string }).body).toBe(SVG.toString());
    });

    it('applies the size limit from the storage settings to attachments and images', async () => {
      await prisma.appSetting.create({ data: { key: 'storage', value: { maxFileSizeMb: 1 } } });
      const big = Buffer.concat([GIF, Buffer.alloc(1024 * 1024)]);
      for (const url of [files(items.theirs.number), images(items.theirs.number)]) {
        const before = await snapshot();
        const res = await send('member', url, big);
        expect(res.statusCode).toBe(413);
        expect(codeOf(res)).toBe(ErrorCode.FILE_TOO_LARGE);
        expect(await snapshot()).toEqual(before);
      }
    });

    it('applies the project quota, counting inline images too', async () => {
      await prisma.appSetting.create({ data: { key: 'storage', value: { projectQuotaMb: 1 } } });
      // Fill the quota with an inline image, leaving less room than one GIF.
      const used = await prisma.attachment.aggregate({ _sum: { sizeBytes: true } });
      await seedAttachment(prisma, projectId, items.doingItem.id, ids.pm, {
        inline: true,
        bytes: Buffer.alloc(1024 * 1024 - (used._sum.sizeBytes ?? 0) - GIF.length + 1),
      });
      for (const url of [files(items.theirs.number), images(items.theirs.number)]) {
        const before = await snapshot();
        const res = await send('member', url);
        expect(res.statusCode).toBe(409);
        expect(codeOf(res)).toBe(ErrorCode.QUOTA_EXCEEDED);
        expect(await snapshot()).toEqual(before);
      }
    });

    it('removes stored files when their item is deleted', async () => {
      const rows = await prisma.attachment.findMany({ where: { workItemId: items.theirs.id } });
      expect(rows).toHaveLength(2);
      expect((await as('pm', 'DELETE', base(items.theirs.number))).statusCode).toBe(204);
      expect(await prisma.attachment.count({ where: { workItemId: items.theirs.id } })).toBe(0);
      for (const row of rows) expect(await storedFileExists(projectId, row.storedName)).toBe(false);
    });

    it('removes a deleted attachment from disk and records it in the history', async () => {
      const row = await prisma.attachment.findUniqueOrThrow({ where: { id: memberFile } });
      expect(
        (await as('member', 'DELETE', `${files(items.theirs.number)}/${memberFile}`)).statusCode,
      ).toBe(204);
      expect(await storedFileExists(projectId, row.storedName)).toBe(false);
      const log = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.ATTACHMENT_DELETED },
      });
      expect(log.meta).toMatchObject({ attachmentId: memberFile, name: 'seeded.gif' });
    });

    it('removes inline images that no description or note uses after a day', async () => {
      const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const make = async () =>
        seedAttachment(prisma, projectId, items.doingItem.id, ids.pm, {
          inline: true,
          createdAt: old,
        });
      const unused = await make();
      const inDescription = await make();
      const inNote = await make();
      const fresh = await seedAttachment(prisma, projectId, items.doingItem.id, ids.pm, {
        inline: true,
      });
      await prisma.workItem.update({
        where: { id: items.doingItem.id },
        data: {
          description: `<img src="${inlineImagePath(projectId, items.doingItem.id, inDescription.id)}" />`,
        },
      });
      await seedNote(
        prisma,
        items.doingItem.id,
        ids.pm,
        `<img src="${inlineImagePath(projectId, items.doingItem.id, inNote.id)}" />`,
      );
      const removed = await app
        .get(AttachmentsService)
        .removeUnusedImages(new Date(Date.now() - 24 * 60 * 60 * 1000));
      expect(removed).toBe(1);
      const left = await prisma.attachment.findMany({ where: { workItemId: items.doingItem.id } });
      expect(left.map((a) => a.id).sort()).toEqual([inDescription.id, inNote.id, fresh.id].sort());
      expect(await storedFileExists(projectId, unused.storedName)).toBe(false);
    });
  });
});
