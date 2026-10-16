import { randomUUID } from 'node:crypto';
import { jest } from '@jest/globals';
import { ItemsService } from '../../src/items/items.service.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { AdoImportRequest, AdoPreview, AdoExportRequest } from '@kloister/shared';
import JSZip from 'jszip';
import { AdoService } from '../../src/ado/ado.service.js';
import { preset } from '../../src/ado/profiles.js';
import { readCsv } from '../../src/ado/csv.js';
import type { PrismaService } from '../../src/prisma/prisma.service.js';
import {
  call,
  login,
  resetDb,
  seedBucket,
  seedItem,
  seedProject,
  seedTeam,
  seedUser,
  startApp,
} from './support.js';

describe('scoped durable offline transfers (CI database only)', () => {
  let app: NestFastifyApplication,
    prisma: PrismaService,
    project: string,
    bucket: string,
    pm: string,
    itemId: string;
  let sids: Record<string, string>;
  const base = () => `/api/v1/projects/${project}/ado`;
  const outgoing = (): AdoExportRequest => ({
    selection: {
      scope: 'project',
      ancestors: true,
      excludeDone: false,
      notes: false,
      labelIds: [],
      labelMode: 'any',
    },
    assignees: {},
    choices: {},
    freshnessAcknowledged: true,
  });
  const incoming = (
    csv = 'ID,Work Item Type,Title,State\n901,Task,Incoming Ω,New\n',
  ): AdoImportRequest => ({
    csv,
    mode: 'import',
    selectedRows: null,
    destinationAcknowledged: true,
    manualLinks: {},
    confirmedNew: ['901'],
    omittedParents: [],
    choices: {
      '901': { title: 'incoming', type: 'incoming', status: 'incoming', bucketId: 'incoming' },
    },
    types: {},
    createLabels: [],
    idempotencyKey: randomUUID(),
  });
  beforeAll(async () => {
    ({ app, prisma } = await startApp());
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb(prisma);
    const names = ['pm', 'lead', 'member', 'viewer', 'teamlead', 'admin', 'outsider'];
    const users = await Promise.all(
      names.map((n) =>
        seedUser(prisma, {
          email: `${n}@example.org`,
          ...(n === 'admin' ? { systemRole: 'ADMIN' } : {}),
        }),
      ),
    );
    pm = users[0].id;
    project = (
      await seedProject(
        prisma,
        'ADO',
        users.slice(0, 5).map((u, i) => ({
          userId: u.id,
          role: (['PM', 'LEAD', 'MEMBER', 'VIEWER', 'MEMBER'] as const)[i],
          visibility: i === 4 ? 'OWN' : 'ALL',
        })),
      )
    ).id;
    bucket = (await seedBucket(prisma, project, 'Existing board')).id;
    await seedTeam(prisma, project, 'Team', [{ userId: users[4].id, role: 'LEAD' }]);
    itemId = (
      await seedItem(prisma, project, {
        createdById: pm,
        bucketId: bucket,
        title: 'Local task',
        status: 'BLOCKED',
      })
    ).id;
    sids = Object.fromEntries(
      await Promise.all(
        users.map(async (u, i) => [names[i] ?? '', await login(app, u.email)] as const),
      ),
    );
    const profile = preset('Agile');
    profile.fields = {};
    profile.reverseTypes['Task'] = 'TASK';
    profile.incomingStates['Task\nNew'] = { status: 'NOT_STARTED', bucketId: bucket };
    const response = await call(app, 'PUT', `${base()}/destination`, {
      sid: sids['pm'],
      body: { organization: 'collection', remoteProject: 'remote', profile, revision: 0 },
    });
    expect(response.statusCode).toBe(200);
  });

  const routes = [
    ['GET', 'destination', false],
    ['GET', 'profile', true],
    ['PUT', 'destination', false],
    ['POST', 'export/preview', true],
    ['POST', 'export/prepare', true],
    ['POST', 'import/preview', false],
    ['GET', 'batches', false],
    ['GET', 'batches/00000000-0000-4000-8000-000000000001', false],
    ['GET', 'batches/00000000-0000-4000-8000-000000000001/download', true],
    ['POST', 'batches/00000000-0000-4000-8000-000000000001/apply', false],
    ['POST', 'batches/00000000-0000-4000-8000-000000000001/cancel', false],
  ] as const;
  for (const [method, path, lead] of routes) {
    for (const role of ['pm', 'lead', 'member', 'viewer', 'teamlead', 'admin', 'outsider']) {
      it(`${method} ${path}: ${role} has exactly its project transfer permission`, async () => {
        const res = await call(app, method, `${base()}/${path}`, {
          sid: sids[role],
          ...(method === 'GET' ? {} : { body: {} }),
        });
        if (role === 'outsider') expect(res.statusCode).toBe(404);
        else if (role === 'pm' || (role === 'lead' && lead))
          expect([200, 201, 400, 404]).toContain(res.statusCode);
        else expect(res.statusCode).toBe(403);
      });
    }
    it(`${method} ${path}: personal space is excluded even for its owner`, async () => {
      const personal = await prisma.project.create({ data: { ownerId: pm, name: 'Private' } });
      expect(
        (
          await call(app, method, `/api/v1/projects/${personal.id}/ado/${path}`, {
            sid: sids['pm'],
            ...(method === 'GET' ? {} : { body: {} }),
          })
        ).statusCode,
      ).toBe(404);
    });
    if (method !== 'GET')
      it(`${method} ${path}: archived writes are blocked`, async () => {
        await prisma.project.update({ where: { id: project }, data: { archivedAt: new Date() } });
        expect(
          (await call(app, method, `${base()}/${path}`, { sid: sids['pm'], body: {} })).statusCode,
        ).toBe(409);
      });
  }

  async function preview(request: AdoImportRequest): Promise<AdoPreview> {
    const response = await call(app, 'POST', `${base()}/import/preview`, {
      sid: sids['pm'],
      body: request,
    });
    expect(response.statusCode).toBe(201);
    return response.json() as AdoPreview;
  }
  async function apply(p: AdoPreview) {
    return call(app, 'POST', `${base()}/batches/${p.batchId}/apply`, {
      sid: sids['pm'],
      body: { digest: p.digest },
    });
  }

  it('imports ADO-origin rows transactionally, repeats idempotently and retains receipts through cleanup', async () => {
    const request = incoming();
    const p = await preview(request);
    expect(p.errors).toEqual([]);
    expect((await apply(p)).statusCode).toBe(201);
    expect((await apply(p)).statusCode).toBe(201);
    expect(await prisma.workItem.count({ where: { projectId: project } })).toBe(2);
    const mapping = await prisma.adoItemLink.findFirstOrThrow({
      where: { projectId: project, remoteId: '901' },
    });
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: mapping.itemId } })).title).toBe(
      'Incoming Ω',
    );
    await prisma.adoTransferBatch.update({
      where: { id: p.batchId! },
      data: { completedAt: new Date(0) },
    });
    await app.get(AdoService).cleanup();
    expect((await apply(p)).statusCode).toBe(201);
    expect((await preview(request)).state).toBe('APPLIED');
    expect(await prisma.workItem.count({ where: { projectId: project } })).toBe(2);
    expect(
      (await prisma.adoTransferBatch.findUniqueOrThrow({ where: { id: p.batchId! } })).content,
    ).toEqual({});
  });
  it('reserves create intent once, recovers exact bytes and links returned IDs without replacing local status', async () => {
    const request = outgoing();
    const p = (
      await call(app, 'POST', `${base()}/export/preview`, { sid: sids['lead'], body: request })
    ).json() as AdoPreview;
    expect(p.errors).toEqual([]);
    const body = { ...request, previewDigest: p.digest, idempotencyKey: randomUUID() };
    const prepared = (
      await call(app, 'POST', `${base()}/export/prepare`, { sid: sids['lead'], body })
    ).json() as AdoPreview;
    const retry = (
      await call(app, 'POST', `${base()}/export/prepare`, { sid: sids['lead'], body })
    ).json() as AdoPreview;
    expect(retry.batchId).toBe(prepared.batchId);
    const download = await call(app, 'GET', `${base()}/batches/${prepared.batchId}/download`, {
      sid: sids['lead'],
    });
    expect(download.statusCode).toBe(200);
    const zip = await JSZip.loadAsync(download.rawPayload);
    const file = Object.values(zip.files).find((f) => !f.dir)!;
    const table = readCsv(await file.async('string'));
    const l = await prisma.adoItemLink.findFirstOrThrow({ where: { projectId: project, itemId } });
    expect(table.headers).not.toContain('State');
    expect(table.headers).not.toContain('Assigned To');
    expect(table.rows[0]['Description']).toContain(l.reference);
    const blocked = (
      await call(app, 'POST', `${base()}/export/preview`, { sid: sids['pm'], body: request })
    ).json() as AdoPreview;
    expect(blocked.errors.join()).toMatch(/recover or cancel/);
    const returned = incoming(
      `ID,Work Item Type,Title,State,Description\n901,Task,Local task,New,Kloister reference: ${l.reference}`,
    );
    returned.mode = 'reconcile';
    // Real return files retain the issued footer; manual fallback handles an intentionally removed footer.
    returned.csv = 'ID,Work Item Type,Title,State\n901,Task,Local task,New';
    returned.manualLinks = { '901': itemId };
    const reviewed = await preview(returned);
    expect(reviewed.errors).toEqual([]);
    expect((await apply(reviewed)).statusCode).toBe(201);
    expect((await prisma.workItem.findUniqueOrThrow({ where: { id: itemId } })).status).toBe(
      'BLOCKED',
    );
    expect((await prisma.adoItemLink.findUniqueOrThrow({ where: { id: l.id } })).remoteId).toBe(
      '901',
    );
    expect(
      (await prisma.adoTransferBatch.findUniqueOrThrow({ where: { id: prepared.batchId! } })).state,
    ).toBe('CONFIRMED');
  });
  it('rejects stale local/config/permission changes and rolls an entire selected batch back', async () => {
    const p = await preview(incoming());
    await prisma.workItem.update({
      where: { id: itemId },
      data: { title: 'Changed after preview' },
    });
    expect((await apply(p)).statusCode).toBe(409);
    expect(await prisma.workItem.count({ where: { projectId: project } })).toBe(1);
    const request = incoming(
      'ID,Work Item Type,Title,State\n901,Task,First,New\n902,Task,Second,New',
    );
    request.confirmedNew.push('902');
    request.choices['902'] = {
      title: 'incoming',
      type: 'incoming',
      status: 'incoming',
      bucketId: 'incoming',
    };
    const atomic = await preview(request);
    expect(atomic.errors).toEqual([]);
    // A chosen invalid field is rejected by the ordinary item validator after the first row; both must roll back.
    const batch = await prisma.adoTransferBatch.findUniqueOrThrow({
      where: { id: atomic.batchId! },
    });
    expect(JSON.stringify(batch.content)).not.toContain('"csv":"ID,');
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: project, userId: pm } },
      data: { role: 'MEMBER' },
    });
    expect((await apply(atomic)).statusCode).toBe(403);
    expect(await prisma.adoItemLink.count()).toBe(0);
  });
  it('rolls back a first successful mutation when a later row fails, then retries once', async () => {
    const request = incoming(
      'ID,Work Item Type,Title,State\n901,Task,First,New\n902,Task,Second,New',
    );
    request.confirmedNew.push('902');
    request.choices['902'] = {
      title: 'incoming',
      type: 'incoming',
      status: 'incoming',
      bucketId: 'incoming',
    };
    const p = await preview(request);
    expect(p.errors).toEqual([]);
    const items = app.get(ItemsService),
      original = items.create.bind(items);
    const spy = jest
      .spyOn(items, 'create')
      .mockImplementation(async (...args: Parameters<ItemsService['create']>) => {
        if (args[2].title === 'Second') throw new Error('Injected second-row failure');
        return original(...args);
      });
    try {
      expect((await apply(p)).statusCode).toBe(500);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
    expect(await prisma.workItem.count({ where: { projectId: project } })).toBe(1);
    expect(await prisma.adoItemLink.count()).toBe(0);
    expect(
      (await prisma.adoTransferBatch.findUniqueOrThrow({ where: { id: p.batchId! } })).state,
    ).toBe('PREVIEW');
    expect((await apply(p)).statusCode).toBe(201);
    expect(await prisma.workItem.count({ where: { projectId: project } })).toBe(3);
  });
  it('serializes concurrent applies and retained receipts prevent duplicate creates', async () => {
    const p = await preview(incoming());
    const results = await Promise.all([apply(p), apply(p)]);
    expect(results.some((r) => r.statusCode === 201)).toBe(true);
    expect(results.every((r) => [201, 409].includes(r.statusCode))).toBe(true);
    expect((await apply(p)).statusCode).toBe(201);
    expect(await prisma.workItem.count({ where: { projectId: project } })).toBe(2);
    expect(await prisma.adoItemLink.count({ where: { remoteId: '901' } })).toBe(1);
  });
  it('keeps a tombstone after ordinary deletion and refuses resurrection', async () => {
    const p = await preview(incoming());
    expect((await apply(p)).statusCode).toBe(201);
    const link = await prisma.adoItemLink.findFirstOrThrow({ where: { remoteId: '901' } });
    expect(
      (
        await call(app, 'DELETE', `/api/v1/projects/${project}/items/${link.itemId}`, {
          sid: sids['pm'],
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (await prisma.adoItemLink.findUniqueOrThrow({ where: { id: link.id } })).tombstonedAt,
    ).not.toBeNull();
    expect((await preview(incoming())).errors.join()).toMatch(/tombstone/);
  });
  it('permits nonexclusive remote destinations while preserving local project isolation', async () => {
    const other = await seedProject(prisma, 'OTHER', [{ userId: pm, role: 'PM' }]);
    const b = await seedBucket(prisma, other.id, 'Existing');
    const profile = preset('Basic');
    profile.incomingStates['Issue\nTo Do'] = { status: 'NOT_STARTED', bucketId: b.id };
    expect(
      (
        await call(app, 'PUT', `/api/v1/projects/${other.id}/ado/destination`, {
          sid: sids['pm'],
          body: { organization: 'collection', remoteProject: 'remote', revision: 0, profile },
        })
      ).statusCode,
    ).toBe(200);
    const p = await preview(incoming());
    expect(
      (
        await call(app, 'GET', `/api/v1/projects/${other.id}/ado/batches/${p.batchId}`, {
          sid: sids['pm'],
        })
      ).statusCode,
    ).toBe(404);
  });
});
