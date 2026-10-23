import { createHash } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { Injectable } from '@nestjs/common';
import { inlineImagePath, type WorkItemDto } from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { invalidField } from '../common/api-exception.js';
import { rewriteImages } from './snapshot-images.js';
import { completedArchive } from './snapshot-stream.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectAccessService, type ProjectAccess } from '../projects/project-access.service.js';
import { FileStoreService } from '../storage/file-store.service.js';
import { ItemsService } from './items.service.js';
import { WorkService } from './work.service.js';
import { SnapshotQueryDto } from './snapshots.dto.js';
import {
  archiveLeaf,
  escapeHtml,
  readableText,
  snapshotWorkbook,
  type SnapshotTables,
} from './snapshot-format.js';

/** Server-calculated snapshots with the same readable scope as project and work lists. */
@Injectable()
export class SnapshotsService {
  /**
   * Receives scoped readers and local storage.
   * @param prisma Detail queries, always after scoped item authorization.
   * @param access Membership and owner-only access.
   * @param items Scoped item and activity readers.
   * @param work My work eligibility reader.
   * @param files Independent authorized file bytes.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly items: ItemsService,
    private readonly work: WorkService,
    private readonly files: FileStoreService,
  ) {}

  /**
   * Resolves every matching page, retaining My work's source and membership rules.
   * @param auth Caller.
   * @param query Scope and narrowing filters.
   * @param project Guarded project, or absent for My work.
   * @returns Readable source entries and a human-readable scope preview.
   */
  async preview(auth: AuthContext, query: SnapshotQueryDto, project?: ProjectAccess) {
    const entries: { access: ProjectAccess; item: WorkItemDto }[] = [];
    const filters = query.scope === 'all' ? {} : query;
    let cursor: string | undefined;
    if (project !== undefined) {
      do {
        const page = await this.items.list(project, { ...filters, cursor, limit: 100 });
        entries.push(...page.items.map((item) => ({ access: project, item })));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
    } else {
      const accesses = await this.access.memberAccesses(auth);
      const personal = await this.access.ownPersonalAccess(auth);
      if (personal !== null) accesses.push(personal);
      do {
        const page = await this.work.listForUser(auth, auth.user.id, {
          ...filters,
          source: query.source,
          includeCreated: query.includeCreated,
          includeDone: query.includeDone,
          cursor,
          limit: 100,
        });
        for (const summary of page.items) {
          const access = accesses.find((a) => a.project.id === summary.projectId);
          if (access !== undefined)
            entries.push({ access, item: await this.items.get(access, summary.id) });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
    }
    const selected =
      query.scope === 'all'
        ? entries
        : entries.filter(
            ({ item }) =>
              (query.boardOnly !== true || item.bucketId !== null) &&
              (query.unassigned !== true || item.assigneeIds.length === 0) &&
              (query.dueGroup === undefined || inDueGroup(item, query.dueGroup, query.today)),
          );
    return {
      entries: selected,
      scope: project === undefined ? 'My work' : project.project.name,
      mode:
        query.scope === 'all'
          ? project === undefined
            ? 'All my work'
            : 'All visible project items'
          : 'Current filtered view',
      filters: await this.describeFilters(auth, query, project),
      count: selected.length,
    };
  }

  /**
   * Names effective filters in ordinary language without exposing inaccessible references.
   * @param auth Caller.
   * @param query Source and narrowing options.
   * @param project Guarded project or My work.
   * @returns Human-readable scope details for both preview and Summary.
   */
  private async describeFilters(
    auth: AuthContext,
    query: SnapshotQueryDto,
    project?: ProjectAccess,
  ): Promise<string> {
    const names: string[] = [];
    if (project === undefined)
      names.push(
        `Source: ${query.source === 'PERSONAL' ? 'Personal' : query.source === 'PROJECTS' ? 'Projects' : 'All'}`,
        `Also items I created: ${query.includeCreated === true ? 'Yes' : 'No'}`,
        `Show done: ${query.includeDone === true ? 'Yes' : 'No'}`,
        'Unarchived membership projects only',
      );
    if (query.scope === 'all') return [...names, 'No narrowing filters'].join(' · ');
    const accesses = project === undefined ? await this.access.memberAccesses(auth) : [project];
    if (project === undefined) {
      const personal = await this.access.ownPersonalAccess(auth);
      if (personal !== null) accesses.push(personal);
    }
    const projectIds = accesses.map((access) => access.project.id);
    if (query.projectId !== undefined)
      names.push(
        `Project: ${accesses.find((access) => access.project.id === query.projectId)?.project.name ?? 'Selected project'}`,
      );
    if (query.q) names.push(`Text: “${query.q}”`);
    if (query.type) names.push(`Type: ${query.type.toLowerCase().replaceAll('_', ' ')}`);
    if (query.status) names.push(`Status: ${query.status.toLowerCase().replaceAll('_', ' ')}`);
    if (query.dueGroup) names.push(`Due: ${query.dueGroup}`);
    if (query.dueFrom) names.push(`Due from: ${query.dueFrom}`);
    if (query.dueTo) names.push(`Due through: ${query.dueTo}`);
    if (query.boardOnly) names.push('On-board items only');
    if (query.unassigned) names.push('Unassigned only');
    const lookup = (id: string) =>
      ({ where: { id, projectId: { in: projectIds } }, select: { name: true } }) as const;
    for (const [field, title, find] of [
      [query.bucketId, 'Bucket', (id: string) => this.prisma.bucket.findFirst(lookup(id))],
      [query.sprintId, 'Sprint', (id: string) => this.prisma.sprint.findFirst(lookup(id))],
      [query.teamId, 'Team', (id: string) => this.prisma.team.findFirst(lookup(id))],
      [query.labelId, 'Label', (id: string) => this.prisma.label.findFirst(lookup(id))],
    ] as const) {
      if (field === undefined) continue;
      if (field === 'none') {
        names.push(`No ${title.toLowerCase()}`);
        continue;
      }
      const row = await find(field);
      names.push(`${title}: ${row?.name ?? 'Selected value'}`);
    }
    if (query.assigneeId !== undefined) {
      const member = await this.prisma.projectMember.findFirst({
        where: { userId: query.assigneeId, projectId: { in: projectIds } },
        select: { user: { select: { displayName: true } } },
      });
      names.push(`Assignee: ${member?.user.displayName ?? 'Selected person'}`);
    }
    if (query.parentId !== undefined)
      names.push(
        query.parentId === 'none' ? 'Top-level items only' : 'Children of selected readable parent',
      );
    return names.length === 0 ? 'No narrowing filters' : names.join(' · ');
  }

  /**
   * Generates the workbook or offline ZIP locally, rechecking readable items and files.
   * @param auth Caller.
   * @param query Previewed options; scope is recomputed on download.
   * @param project Guarded project, absent for My work.
   * @returns Download bytes; missing content fails explicitly rather than silently disappearing.
   */
  async download(
    auth: AuthContext,
    query: SnapshotQueryDto,
    project?: ProjectAccess,
  ): Promise<Buffer | ReadStream> {
    const preview = await this.preview(auth, query, project);
    const tables: SnapshotTables = {
      Summary: {
        headers: ['Property', 'Value'],
        rows: [
          ['Scope', preview.scope],
          ['Selection', preview.mode],
          ['Filters', preview.filters],
          ['Item count', String(preview.count)],
          ['Export time (UTC)', new Date().toISOString()],
          [
            'Format',
            'Readable snapshot; not a restorable backup. Database and file backups remain necessary.',
          ],
          [
            'Content',
            'All matching pages. Long cells continue in Continued text; XML control characters are shown as Unicode escapes. Hidden ancestors are titles only; hidden dependencies are excluded. Dates use ISO calendar/UTC formats.',
          ],
        ],
      },
      Items: {
        headers: [
          'Item',
          'Title',
          'Type',
          'Hierarchy (titles only where restricted)',
          'Assignees',
          'Status',
          'Bucket',
          'Sprint',
          'Team',
          'Labels',
          'Priority',
          'Start date',
          'Due date',
          'Completed (UTC)',
          'Description',
          'Checklist progress',
          'Details',
          // Added in M8.5 at the end, so earlier columns keep their positions.
          'Due time',
        ],
        rows: [],
      },
      Checklists: { headers: ['Item', 'Text', 'Done', 'Order'], rows: [] },
      Notes: { headers: ['Item', 'Author', 'Created (UTC)', 'Edited (UTC)', 'Text'], rows: [] },
      Dependencies: {
        headers: ['Item', 'Relationship', 'Readable related item', 'Title'],
        rows: [],
      },
      Files: {
        headers: ['Item', 'Original name', 'Type', 'Bytes', 'Inline', 'Offline path'],
        rows: [],
      },
      Activity: {
        headers: ['Item', 'Action', 'Time (UTC)', 'Actor', 'Readable changes'],
        rows: [],
      },
    };
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const fileSources: Readable[] = [];
    const index: string[] = [];
    for (const entry of preview.entries) {
      const { access } = entry;
      const item = await this.items.get(access, entry.item.id);
      const row = await this.prisma.workItem.findFirstOrThrow({
        where: this.items.scoped(access, { id: item.id }),
        include: {
          assignees: { include: { projectMember: { include: { user: true } } } },
          bucket: true,
          sprint: true,
          team: true,
          labels: { include: { label: true } },
          notes: { include: { author: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
          attachments: true,
        },
      });
      const itemKey = `${access.project.id}/${item.id}`;
      tables['Items']?.rows.push([
        item.key,
        item.title,
        item.type,
        item.ancestors.map((a) => `${a.key} ${a.title}`).join(' / '),
        row.assignees
          .map((a) => `${a.projectMember.user.displayName} <${a.projectMember.user.email}>`)
          .join('\n'),
        item.status,
        row.bucket?.name ?? '',
        row.sprint?.name ?? '',
        row.team?.name ?? '',
        row.labels.map((l) => l.label.name).join('\n'),
        String(item.priority),
        item.startDate ?? '',
        item.dueDate ?? '',
        item.completedAt ?? '',
        readableText(item.description),
        `${item.checklist.done}/${item.checklist.total}`,
        'Checklists; Notes; Dependencies; Files; Activity (linked by Item)',
        item.dueTime ?? '',
      ]);
      for (const line of item.checklistItems)
        tables['Checklists']?.rows.push([
          item.key,
          line.text,
          String(line.done),
          String(line.position),
        ]);
      for (const note of row.notes)
        tables['Notes']?.rows.push([
          item.key,
          note.author.displayName,
          note.createdAt.toISOString(),
          note.editedAt?.toISOString() ?? '',
          readableText(note.body),
        ]);
      for (const [relationship, related] of [
        ['Blocked by', item.blockedBy],
        ['Blocks', item.blocks],
      ] as const)
        for (const other of related)
          tables['Dependencies']?.rows.push([item.key, relationship, other.key, other.title]);
      let cursor: string | undefined;
      do {
        const page = await this.items.activity(access, item.id, { cursor, limit: 100 });
        for (const activity of page.items)
          tables['Activity']?.rows.push([
            item.key,
            activity.action,
            activity.createdAt,
            activity.actorEmail ?? '',
            JSON.stringify(activity.meta),
          ]);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      const imagePaths = new Map<string, string>();
      for (const file of row.attachments) {
        const path = `items/${itemKey}/files/${archiveLeaf(file.id, file.originalName)}`;
        tables['Files']?.rows.push([
          item.key,
          file.originalName,
          file.mimeType,
          String(file.sizeBytes),
          String(file.inline),
          query.offline === true ? path : 'Not included: workbook only',
        ]);
        if (query.offline === true) {
          // Recheck the item and the exact file relation before opening any bytes.
          await this.items.findVisible(this.prisma, access, item.id);
          const current = await this.prisma.attachment.findFirst({
            where: { id: file.id, workItemId: item.id, inline: file.inline },
          });
          if (current === null)
            throw invalidField('file', 'A file changed while exporting; refresh and try again');
          const source = Readable.from(this.readFile(access, item.id, current.id));
          fileSources.push(source);
          zip.file(path, source);
          if (file.inline)
            imagePaths.set(
              inlineImagePath(access.project.id, item.id, file.id),
              `files/${archiveLeaf(file.id, file.originalName)}`,
            );
        }
      }
      if (query.offline === true) {
        const localHtml = (html: string) =>
          rewriteImages(html, (source) => {
            const path = imagePaths.get(source);
            if (path === undefined)
              throw invalidField('image', 'An inline image is unavailable; export was stopped');
            return path;
          });
        const files = row.attachments
          .filter((f) => !f.inline)
          .map(
            (f) =>
              `<li><a href="files/${escapeHtml(archiveLeaf(f.id, f.originalName))}" download>${escapeHtml(f.originalName)}</a></li>`,
          )
          .join('');
        const html = `<h1>${escapeHtml(item.key)} ${escapeHtml(item.title)}</h1><h2>Description</h2>${localHtml(item.description)}<h2>Checklist</h2><ul>${item.checklistItems.map((l) => `<li>${l.done ? '☑' : '☐'} ${escapeHtml(l.text)}</li>`).join('')}</ul><h2>Notes</h2>${row.notes.map((n) => `<article><h3>${escapeHtml(n.author.displayName)}</h3>${localHtml(n.body)}</article>`).join('')}<h2>Attachments</h2><ul>${files}</ul>`;
        zip.file(`items/${itemKey}/index.html`, Buffer.from(offlineDocument(html), 'utf8'));
        index.push(
          `<li><a href="items/${itemKey}/index.html">${escapeHtml(item.key)} ${escapeHtml(item.title)}</a></li>`,
        );
      }
    }
    const workbook = await snapshotWorkbook(tables);
    if (query.offline !== true) return workbook;
    zip.file('snapshot.xlsx', workbook);
    zip.file(
      'index.html',
      Buffer.from(
        offlineDocument(
          `<h1>${escapeHtml(preview.scope)}</h1><p>${escapeHtml(preview.mode)} · ${preview.count} items</p><p>Readable snapshot, not a restorable backup.</p><a href="snapshot.xlsx">Excel workbook</a><ul>${index.join('')}</ul>`,
        ),
        'utf8',
      ),
    );
    return completedArchive(zip, fileSources);
  }

  /**
   * Opens one independently authorized file only when the archive consumes it.
   * @param access Item scope snapshot for this request.
   * @param itemId Readable item owning the file.
   * @param fileId File relation to recheck immediately before reading.
   * @returns Verified file chunks; missing/changed content fails the entire archive.
   */
  private async *readFile(
    access: ProjectAccess,
    itemId: string,
    fileId: string,
  ): AsyncGenerator<Buffer> {
    await this.items.findVisible(this.prisma, access, itemId);
    const file = await this.prisma.attachment.findFirst({
      where: { id: fileId, workItemId: itemId },
    });
    if (file === null)
      throw invalidField('file', 'A file is no longer readable; export was stopped');
    const hash = createHash('sha256');
    let size = 0;
    const stream = await this.files.open(access.project.id, file.storedName);
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += bytes.length;
      hash.update(bytes);
      yield bytes;
    }
    if (size !== file.sizeBytes || hash.digest('hex') !== file.sha256)
      throw invalidField('file', 'A source file is incomplete or changed; export was stopped');
  }
}

/**
 * Wraps preserved sanitized rich text in an offline document with no active content.
 * @param body Safe content with local image paths.
 * @returns A standalone document.
 */
function offlineDocument(body: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Work snapshot</title><body>${body}</body></html>`;
}

/**
 * Matches the work screen's calendar groups without widening eligibility.
 * @param item Readable item.
 * @param group Requested group.
 * @param today Viewer's calendar day.
 * @returns Whether the item belongs to the group.
 */
function inDueGroup(
  item: WorkItemDto,
  group: string | undefined,
  today: string | undefined,
): boolean {
  if (today === undefined)
    throw invalidField('today', 'Choose the calendar day for a due-group snapshot');
  if (item.dueDate === null) return group === 'No date';
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + ((7 - date.getUTCDay()) % 7));
  const sunday = date.toISOString().slice(0, 10);
  const actual =
    item.dueDate < today && item.status !== 'DONE'
      ? 'Overdue'
      : item.dueDate === today
        ? 'Today'
        : item.dueDate > today && item.dueDate <= sunday
          ? 'This week'
          : 'Later';
  return actual === group;
}
