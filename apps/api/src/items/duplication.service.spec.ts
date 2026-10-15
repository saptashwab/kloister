import { jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { DEFAULT_PROJECT_SETTINGS } from '@kloister/shared';
import { makeProject, makeUser } from '../../test/support/fakes.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import type { SettingsService } from '../settings/settings.service.js';
import type { FileStoreService } from '../storage/file-store.service.js';
import type { ItemsService } from './items.service.js';
import { DuplicationService } from './duplication.service.js';

const bytes = Buffer.from('GIF89a-content');
const hash = createHash('sha256').update(bytes).digest('hex');
const fn = () => jest.fn<(...args: unknown[]) => Promise<unknown>>();

function setup(personal = false) {
  const user = makeUser();
  const access: ProjectAccess = {
    project: makeProject({ ownerId: personal ? user.id : null }),
    settings: DEFAULT_PROJECT_SETTINGS,
    userId: user.id,
    role: 'PM',
    isSystemAdmin: false,
    visibility: 'ALL',
    allowedBucketIds: [],
    teams: [],
    permissions: new Set(),
  };
  const source = {
    id: 'source',
    description: '<p>Plain content</p>',
    type: 'TASK',
    priority: 2,
    labelIds: [],
    checklistItems: [],
    startDate: null,
    dueDate: null,
    sprintId: null,
  };
  const db = {
    $queryRaw: fn(),
    attachment: { findMany: fn(), create: fn() },
    checklistItem: { createMany: fn() },
    workItem: { update: fn() },
    $transaction: fn(),
  };
  db.$queryRaw.mockResolvedValue([{ used: 0n }]);
  db.attachment.findMany.mockResolvedValue([
    {
      id: 'attachment',
      workItemId: 'source',
      originalName: 'file.gif',
      storedName: 'old-file',
      sizeBytes: bytes.length,
      sha256: hash,
      inline: false,
      mimeType: 'image/gif',
    },
  ]);
  db.attachment.create.mockResolvedValue({ id: 'copied-file' });
  db.$transaction.mockImplementation((callback) =>
    (callback as (tx: typeof db) => Promise<unknown>)(db),
  );
  const items = { findVisible: fn(), detail: fn(), create: fn() };
  items.findVisible.mockResolvedValue({ id: 'source' });
  items.detail.mockResolvedValue(source);
  items.create.mockResolvedValue({ id: 'copy' });
  const files = { open: fn(), receive: fn(), keep: fn(), discard: fn(), remove: fn() };
  files.open.mockImplementation(() => Promise.resolve(Readable.from(bytes)));
  files.receive.mockResolvedValue({
    tempPath: 'incoming',
    sizeBytes: bytes.length,
    head: bytes,
    sha256: hash,
  });
  files.remove.mockResolvedValue(undefined);
  files.discard.mockResolvedValue(undefined);
  files.keep.mockResolvedValue(undefined);
  const limits = { maxFileSizeMb: 1, projectQuotaMb: 2, personalQuotaMb: 1 };
  const settings = { getStorage: () => Promise.resolve(limits) } as SettingsService;
  const service = new DuplicationService(
    db as unknown as PrismaService,
    items as unknown as ItemsService,
    files as unknown as FileStoreService,
    settings,
  );
  return { service, db, items, files, source, limits, access, auth: { user, sessionId: 'sid' } };
}

describe('independent-copy file failure handling', () => {
  it.each([false, true])(
    'checks the whole batch against the correct quota, personal=%s',
    async (personal) => {
      const s = setup(personal);
      s.db.$queryRaw.mockResolvedValue([{ used: BigInt((personal ? 1 : 2) * 1024 * 1024) }]);
      await expect(
        s.service.duplicate(s.auth, s.access, 'source', {
          copies: [{ title: 'Copy', assigneeIds: [] }],
          attachments: true,
        }),
      ).rejects.toMatchObject({ response: { code: 'QUOTA_EXCEEDED' } });
      expect(s.items.create).not.toHaveBeenCalled();
      expect(s.files.receive).not.toHaveBeenCalled();
    },
  );

  it('removes the first physical copy if the second copy fails, allowing transaction rollback', async () => {
    const s = setup();
    s.items.create
      .mockResolvedValueOnce({ id: 'copy-one' })
      .mockRejectedValueOnce(new Error('assignment changed'));
    await expect(
      s.service.duplicate(s.auth, s.access, 'source', {
        copies: [
          { title: 'One', assigneeIds: [] },
          { title: 'Two', assigneeIds: [] },
        ],
        attachments: true,
      }),
    ).rejects.toThrow('assignment changed');
    expect(s.files.keep).toHaveBeenCalledTimes(1);
    const kept = s.files.keep.mock.calls[0]?.[2];
    expect(typeof kept).toBe('string');
    expect(kept).not.toBe('old-file');
    expect(s.files.remove).toHaveBeenCalledWith([
      { projectId: s.access.project.id, storedName: kept },
    ]);
  });

  it('rejects changed content and discards staging before any file is retained', async () => {
    const s = setup();
    s.files.receive.mockResolvedValue({
      tempPath: 'incoming',
      sizeBytes: bytes.length,
      head: bytes,
      sha256: 'changed',
    });
    await expect(
      s.service.duplicate(s.auth, s.access, 'source', {
        copies: [{ title: 'One', assigneeIds: [] }],
        attachments: true,
      }),
    ).rejects.toThrow('content has changed');
    expect(s.files.discard).toHaveBeenCalled();
    expect(s.files.keep).not.toHaveBeenCalled();
  });

  it.each(['missing file', 'file exceeds current size limit'])(
    'propagates %s instead of silently omitting content',
    async (reason) => {
      const s = setup();
      s.files.receive.mockRejectedValue(new Error(reason));
      await expect(
        s.service.duplicate(s.auth, s.access, 'source', {
          copies: [{ title: 'One', assigneeIds: [] }],
          attachments: true,
        }),
      ).rejects.toThrow(reason);
      expect(s.files.receive.mock.calls[0]?.[1]).toBe(1024 * 1024);
      expect(s.files.keep).not.toHaveBeenCalled();
    },
  );

  it('copies image-looking ordinary text without requiring a nonexistent file', async () => {
    const s = setup();
    s.source.description = '<p>Example /images/00000000-0000-0000-0000-000000000001</p>';
    s.db.attachment.findMany.mockResolvedValue([]);
    await s.service.duplicate(s.auth, s.access, 'source', {
      copies: [{ title: 'One', assigneeIds: [] }],
    });
    expect(s.db.workItem.update).toHaveBeenCalledWith({
      where: { id: 'copy' },
      data: { description: s.source.description },
    });
    expect(s.files.open).not.toHaveBeenCalled();
  });
});
