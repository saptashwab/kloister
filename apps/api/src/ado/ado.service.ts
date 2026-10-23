import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  type AdoDestinationDto,
  type AdoDestinationInput,
  type AdoExportRequest,
  type AdoField,
  type AdoImportRequest,
  type AdoPreview,
  type AdoProfile,
  type AdoReview,
  type AdoSampleResult,
  type AdoSummary,
  AuditAction,
  ProjectRole,
  type Page,
} from '@kloister/shared';
import { plainToInstance } from 'class-transformer';
import { statusOnEnter } from '../board/bucket-rules.js';
import { validate } from 'class-validator';
import JSZip from 'jszip';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { conflict, forbidden, invalidField, notFound } from '../common/api-exception.js';
import { type PageQueryDto, pageArgs, toPage } from '../common/pagination.js';
import { serializable } from '../common/transactions.js';
import type { AdoDestination, AdoTransferBatch, Prisma } from '../generated/prisma/client.js';
import { CreateItemDto, UpdateItemDto } from '../items/items.dto.js';
import {
  ItemsService,
  assertDateOrder,
  assertLabels,
  assertMembers,
  assertOpenSprint,
  findBucketFor,
} from '../items/items.service.js';
import { assertParentType, assertChildrenFit } from '../items/hierarchy.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProjectAccessService, type ProjectAccess } from '../projects/project-access.service.js';
import { projectArchived } from '../projects/project-access.service.js';
import { type ExportFile, exportPlan } from './export.js';
import { object, validateProfile } from './profiles.js';
import { readCsv, type CsvTable } from './csv.js';
import {
  canonical,
  digest,
  incomingPlan,
  localValues,
  SENT,
  sentFields,
  TRANSFER_INCLUDE,
  type IncomingOperation,
  type TransferItem,
  type TransferMember,
  type Values,
} from './transfer.js';
import { identityEmail, sameValue } from './values.js';

/** Unapplied incoming previews keep their parsed content this long. */
const PREVIEW_DAYS = 7;

type Tx = Prisma.TransactionClient;
type BatchContent = {
  request?: AdoImportRequest;
  table?: CsvTable;
  preview: AdoPreview;
  files?: ExportFile[];
};

/** Durable offline transfer lifecycle; no external requests or credentials. */
@Injectable()
export class AdoService {
  /**
   * Receives ordinary authorization, item validation and transactional persistence.
   * @param prisma Database client.
   * @param access Project and active-user authorization.
   * @param items Ordinary scoped item creation/update helpers.
   * @param audit Content-free action log.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly items: ItemsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Reads only the sanitized reviewed destination/profile needed for export.
   * @param access Guard-resolved project access.
   * @returns Profile or null before setup.
   */
  async destination(access: ProjectAccess): Promise<AdoDestinationDto | null> {
    const row = await this.prisma.adoDestination.findUnique({
      where: { projectId: access.project.id },
    });
    return row === null ? null : dto(row);
  }

  /**
   * Replaces reviewed settings. Destination identity freezes once any durable link exists.
   * @param auth Signed-in PM.
   * @param access Project access.
   * @param input Reviewed replacement and expected revision.
   * @returns Saved destination.
   */
  async configure(
    auth: AuthContext,
    access: ProjectAccess,
    input: AdoDestinationInput,
  ): Promise<AdoDestinationDto> {
    const profile = validateProfile(input.profile),
      organization = canonical(input.organization),
      remoteProject = canonical(input.remoteProject);
    if (
      !organization ||
      !remoteProject ||
      [...organization, ...remoteProject].some((c) => c.charCodeAt(0) < 32)
    )
      throw invalidField('destination', 'Supply organization/collection and project identities');
    return this.transaction(async (tx) => {
      await this.current(tx, access, true);
      await this.references(tx, access.project.id, profile);
      const existing = await tx.adoDestination.findUnique({
        where: { projectId: access.project.id },
      });
      if ((existing?.revision ?? 0) !== input.revision)
        throw conflict('Destination changed; reload settings');
      if (
        existing &&
        (existing.organization !== organization || existing.remoteProject !== remoteProject) &&
        (await tx.adoItemLink.count({ where: { destinationId: existing.id } }))
      )
        throw conflict(
          'Destination identity cannot change after links or pending references exist',
        );
      const data = {
        organization,
        remoteProject,
        profile: json(profile),
        revision: input.revision + 1,
      };
      const saved = existing
        ? await tx.adoDestination.update({ where: { id: existing.id }, data })
        : await tx.adoDestination.create({ data: { ...data, projectId: access.project.id } });
      await this.record(tx, auth, access, AuditAction.ADO_CONFIGURED, saved.id, {
        revision: saved.revision,
      });
      return dto(saved);
    });
  }

  /**
   * Sets whether every transfer in the project must use Detailed review. Kept apart from the
   * profile so it neither changes the profile revision nor invalidates observations.
   * @param auth Signed-in PM.
   * @param access Project access.
   * @param requireDetailedReview New policy.
   * @returns Saved destination.
   */
  async setReviewPolicy(
    auth: AuthContext,
    access: ProjectAccess,
    requireDetailedReview: boolean,
  ): Promise<AdoDestinationDto> {
    return this.transaction(async (tx) => {
      await this.current(tx, access, true);
      const existing = await this.requiredDestination(tx, access);
      const saved = await tx.adoDestination.update({
        where: { id: existing.id },
        data: { requireDetailedReview },
      });
      await this.record(tx, auth, access, AuditAction.ADO_CONFIGURED, saved.id, {
        requireDetailedReview,
      });
      return dto(saved);
    });
  }

  /**
   * Reads a sample ADO export to suggest mappings. Nothing is stored and no item is touched.
   * @param access PM project access.
   * @param csv Exported CSV text.
   * @returns Distinct types, states, tags, iterations, identities and date facts.
   */
  async sample(access: ProjectAccess, csv: string): Promise<AdoSampleResult> {
    await this.transaction((tx) => this.current(tx, access, true));
    const table = readCsv(csv);
    const distinct = (values: string[]): string[] =>
      [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const cells = (header: string): string[] => table.rows.map((r) => r[header] ?? '');
    const types = distinct(cells('Work Item Type'));
    const dateHeaders = table.headers.filter(
      (h) =>
        /\b(?:date|start|finish)\b/iu.test(h) &&
        !/^(?:Changed|Created|Closed|Resolved|Activated|State Change) Date$/iu.test(h),
    );
    let dateOrder: AdoSampleResult['dateOrder'] = null;
    for (const value of dateHeaders.flatMap(cells)) {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{4}/u.exec(value.trim());
      if (m && Number(m[1]) > 12) dateOrder = 'DMY';
      if (m && Number(m[2]) > 12) dateOrder = 'MDY';
    }
    const has = (type: string) => types.includes(type);
    return {
      headers: table.headers,
      process: has('Product Backlog Item')
        ? 'Scrum'
        : has('User Story')
          ? 'Agile'
          : has('Requirement')
            ? 'CMMI'
            : has('Issue') && !has('Feature')
              ? 'Basic'
              : null,
      types,
      states: [
        ...new Map(
          table.rows
            .filter((r) => r['State'] !== undefined && r['Work Item Type'])
            .map((r) => [
              `${r['Work Item Type']}\n${r['State']}`,
              { type: r['Work Item Type'], state: r['State'] },
            ]),
        ).values(),
      ].sort((a, b) => `${a.type}${a.state}`.localeCompare(`${b.type}${b.state}`)),
      tags: distinct(cells('Tags').flatMap((v) => v.split(';'))),
      iterations: distinct(cells('Iteration Path')),
      identities: distinct(cells('Assigned To')).map((value) => ({
        value,
        email: identityEmail(value),
      })),
      dateHeaders,
      dateOrder,
      rows: table.rows.length,
    };
  }

  /**
   * Evaluates a read-only export preview; never accepts a remote CSV.
   * @param access PM/Lead access.
   * @param request Reviewed outbound selection.
   * @returns Complete row/file preview.
   */
  async previewExport(access: ProjectAccess, request: AdoExportRequest): Promise<AdoPreview> {
    return serializable(
      this.prisma,
      async (tx) => (await this.buildExport(tx, access, request)).preview,
    );
  }

  /**
   * Atomically reserves create identities and exact files after revalidating the preview.
   * @param auth Signed-in PM or project Lead.
   * @param access Project access.
   * @param request Preview digest and durable retry key.
   * @returns Recoverable batch, without claiming ADO import success.
   */
  async prepare(
    auth: AuthContext,
    access: ProjectAccess,
    request: AdoExportRequest,
  ): Promise<AdoPreview> {
    if (!request.idempotencyKey || !request.previewDigest)
      throw invalidField('preview', 'Preview digest and retry identity are required');
    return this.transaction(async (tx) => {
      await this.current(tx, access, false);
      const destination = await this.requiredDestination(tx, access);
      const prior = await tx.adoTransferBatch.findUnique({
        where: {
          destinationId_idempotencyKey: {
            destinationId: destination.id,
            idempotencyKey: request.idempotencyKey!,
          },
        },
      });
      const requestDigest = digest({ ...request, idempotencyKey: undefined });
      if (prior) {
        if (prior.fileDigest !== requestDigest)
          throw conflict('Retry key belongs to another request');
        return this.receipt(prior);
      }
      const { preview, plan } = await this.buildExport(tx, access, request);
      if (preview.digest !== request.previewDigest)
        throw conflict('Export preview is stale; preview again');
      if (preview.errors.length) throw invalidField('preview', preview.errors.join('\n'));
      if (!plan.files.length) throw invalidField('selection', 'No exportable rows');
      const batchId = randomUUID();
      const files = plan.files.map((f) => ({ ...f }));
      let pending = false;
      for (const intent of plan.intents) {
        const existing = await tx.adoItemLink.findUnique({
          where: { destinationId_itemId: { destinationId: destination.id, itemId: intent.itemId } },
        });
        const reference = existing?.remoteId ? existing.reference : randomBytes(32).toString('hex');
        const suffix = intent.suffix.replaceAll(intent.reference, reference);
        for (const file of files) file.csv = file.csv.replaceAll(intent.reference, reference);
        // An update records which fields it sent, so a later different ADO value is asked about
        // instead of being treated as ADO's create defaults.
        const sent = intent.create
          ? []
          : [...new Set([...sentFields(existing?.intent), ...(intent.sent ?? [])])];
        const data = {
          generatedSuffix: suffix,
          intent: json(sent.length ? { ...intent.values, [SENT]: sent } : intent.values),
          ...(intent.create ? { pendingBatchId: batchId, reference } : {}),
        };
        if (existing) await tx.adoItemLink.update({ where: { id: existing.id }, data });
        else
          await tx.adoItemLink.create({
            data: {
              ...data,
              destinationId: destination.id,
              projectId: access.project.id,
              itemId: intent.itemId,
              reference,
            },
          });
        pending ||= intent.create;
      }
      const result: AdoPreview = { ...preview, batchId, state: pending ? 'PENDING' : 'PREPARED' };
      await tx.adoTransferBatch.create({
        data: {
          id: batchId,
          destinationId: destination.id,
          projectId: access.project.id,
          creatorId: auth.user.id,
          direction: 'OUT',
          mode: 'export',
          review: result.review ?? 'quick',
          state: result.state,
          revision: destination.revision,
          idempotencyKey: request.idempotencyKey!,
          fileDigest: requestDigest,
          digest: preview.digest,
          content: json({ preview: result, files }),
          ...(pending ? {} : { completedAt: new Date() }),
          rows: {
            create: preview.rows.map((r) => ({
              index: r.index,
              itemId: r.itemId,
              remoteId: r.remoteId,
              result: r.kind,
              content: json(r),
            })),
          },
        },
      });
      await this.record(tx, auth, access, AuditAction.ADO_PREPARED, batchId, {
        rows: result.rows.length,
        files: files.length,
      });
      return result;
    });
  }

  /**
   * Persists a PM-reviewed incoming preview, binding choices and exact source to a retry key.
   * @param auth Signed-in PM.
   * @param access Project access.
   * @param request Incoming rows and explicit resolutions.
   * @returns Recoverable preview, blocked until every error is resolved.
   */
  async previewImport(
    auth: AuthContext,
    access: ProjectAccess,
    request: AdoImportRequest,
  ): Promise<AdoPreview> {
    return this.transaction(async (tx) => {
      await this.current(tx, access, true);
      this.labelChoices(request);
      const context = await this.context(tx, access);
      const { destination, items, links, members } = context;
      const review = this.review(destination, request.review);
      const prior = await tx.adoTransferBatch.findUnique({
        where: {
          destinationId_idempotencyKey: {
            destinationId: destination.id,
            idempotencyKey: request.idempotencyKey,
          },
        },
      });
      if (prior) {
        if (prior.fileDigest !== digest(request))
          throw conflict('Retry key belongs to different content or choices');
        return this.receipt(prior);
      }
      const table = readCsv(request.csv);
      const plan = incomingPlan(destination, request, items, links, table, members);
      if (request.mode === 'import')
        plan.errors.push(...(await this.validateIncoming(tx, access, plan.operations, items)));
      const version = this.version(context, incomingIds(plan.operations, items));
      const selected = new Set(request.selectedRows ?? table.rows.map((_, i) => i));
      const contextColumns = new Set([
        'ID',
        'Work Item Type',
        'Parent',
        'Team Project',
        'Organization',
        'Collection',
      ]);
      const normalizedTable: CsvTable = {
        headers: table.headers,
        rows: table.rows.map((row, index) =>
          selected.has(index)
            ? row
            : Object.fromEntries(
                Object.entries(row).filter(
                  ([h]) => contextColumns.has(h) || /^Title(?: \d+)?$/u.test(h),
                ),
              ),
        ),
      };
      const batchId = randomUUID(),
        hash = digest({ requestDigest: digest(request), version });
      const preview: AdoPreview = {
        batchId,
        digest: hash,
        destination,
        rows: plan.rows,
        files: [],
        warnings: plan.warnings,
        errors: plan.errors,
        state: 'PREVIEW',
        review,
        summary: summarize(plan.rows, request.mode === 'import'),
      };
      await tx.adoTransferBatch.create({
        data: {
          id: batchId,
          destinationId: destination.id,
          projectId: access.project.id,
          creatorId: auth.user.id,
          direction: 'IN',
          mode: request.mode,
          review,
          revision: destination.revision,
          idempotencyKey: request.idempotencyKey,
          fileDigest: digest(request),
          digest: hash,
          content: json({ request: { ...request, csv: '' }, table: normalizedTable, preview }),
          rows: {
            create: plan.rows.map((r) => ({
              index: r.index,
              itemId: r.itemId,
              remoteId: r.remoteId,
              result: r.kind,
              content: json(r),
            })),
          },
        },
      });
      return preview;
    });
  }

  /**
   * Applies exactly the selected reviewed rows in one serializable transaction, including links and audit.
   * @param auth Signed-in PM.
   * @param access Project access.
   * @param batchId Scoped preview batch.
   * @param expectedDigest Digest shown in review.
   * @returns Durable receipt; identical retries never recreate work.
   */
  async apply(
    auth: AuthContext,
    access: ProjectAccess,
    batchId: string,
    expectedDigest: string,
  ): Promise<AdoPreview> {
    return this.transaction(async (tx) => {
      await this.current(tx, access, true);
      const batch = await this.batch(tx, access, batchId);
      if (batch.digest !== expectedDigest) throw conflict('Review digest does not match');
      if (batch.direction !== 'IN' || batch.state === 'CANCELLED')
        throw conflict('This is not an active incoming preview');
      if (batch.state === 'APPLIED') return this.receipt(batch);
      const content = batch.content as unknown as BatchContent;
      const request = content.request;
      if (!request) throw conflict('Preview content expired; upload again');
      const context = await this.context(tx, access);
      const { destination, items, links, members } = context;
      this.review(destination, request.review);
      const plan = incomingPlan(destination, request, items, links, content.table, members);
      const version = this.version(context, incomingIds(plan.operations, items));
      if (
        digest({ requestDigest: batch.fileDigest, version }) !== expectedDigest ||
        batch.revision !== destination.revision
      )
        throw conflict('Local data, references or mappings changed; review a fresh preview');
      if (request.mode === 'import')
        plan.errors.push(...(await this.validateIncoming(tx, access, plan.operations, items)));
      if (plan.errors.length) throw invalidField('preview', plan.errors.join('\n'));
      const labels = new Map<string, string>();
      // Labels are created only when a selected reviewed field actually takes them.
      for (const choice of request.createLabels)
        if (
          plan.operations.some((op) =>
            (op.changes.labelIds as string[] | undefined)?.includes(`label:${choice.tag}`),
          )
        ) {
          const label = await tx.label.create({
            data: { projectId: access.project.id, name: choice.name, colour: choice.colour },
          });
          labels.set(`label:${choice.tag}`, label.id);
        }
      const remoteToLocal = new Map(
        links.filter((l) => l.remoteId && !l.tombstonedAt).map((l) => [l.remoteId!, l.itemId]),
      );
      const resolved = new Set<string>();
      for (const op of plan.operations) {
        const changes = { ...op.changes };
        if (op.itemId && Array.isArray(changes.assigneeIds)) {
          const current = items.find((i) => i.id === op.itemId)!;
          const baseline = (links.find((l) => l.id === op.linkId)?.remoteBaseline ?? {}) as Values;
          const managed = Array.isArray(baseline.assigneeIds) ? baseline.assigneeIds : [];
          changes.assigneeIds = [
            ...new Set([
              ...current.assignees.map((a) => a.userId).filter((id) => !managed.includes(id)),
              ...changes.assigneeIds,
            ]),
          ];
        }
        if (typeof changes.parentId === 'string' && changes.parentId.startsWith('remote:')) {
          const parent = remoteToLocal.get(changes.parentId.slice(7));
          if (!parent) throw invalidField('parentId', 'Selected parent was not created or linked');
          changes.parentId = parent;
        }
        if (Array.isArray(changes.labelIds))
          changes.labelIds = changes.labelIds.map((id) => labels.get(id) ?? id);
        let itemId = op.itemId;
        if (request.mode === 'import') {
          const { bucketId, ...fields } = changes;
          if (itemId === null) {
            const create = await checked(CreateItemDto, {
              ...fields,
              bucketId,
            });
            itemId = (await this.items.create(auth, access, create, tx)).id;
          } else {
            const previousStatus = items.find((i) => i.id === itemId)!.status;
            if (bucketId !== undefined)
              await this.items.move(
                auth,
                access,
                itemId,
                { bucketId: bucketId as string | null },
                tx,
              );
            const update = await checked(UpdateItemDto, {
              ...(bucketId === undefined ? {} : { status: previousStatus }),
              ...fields,
            });
            await this.items.update(auth, access, itemId, update, tx);
          }
        }
        if (!itemId)
          throw invalidField('ID', 'Observation/reconciliation requires an existing local item');
        remoteToLocal.set(op.remoteId, itemId);
        const item = await tx.workItem.findFirstOrThrow({
          where: this.items.scoped(access, { id: itemId }),
          include: TRANSFER_INCLUDE,
        });
        const existing = links.find((l) => l.id === op.linkId);
        if (existing?.pendingBatchId) resolved.add(existing.pendingBatchId);
        const normalized: Values = { ...op.incoming };
        if (typeof normalized.parentId === 'string' && normalized.parentId.startsWith('remote:'))
          normalized.parentId = remoteToLocal.get(normalized.parentId.slice(7)) ?? null;
        if (Array.isArray(normalized.labelIds))
          normalized.labelIds = normalized.labelIds.map((id) => labels.get(id) ?? id);
        const data = {
          remoteId: op.remoteId,
          observation: json({ raw: op.raw, values: normalized }),
          observedAt: new Date(),
          observationRevision: destination.revision,
          pendingBatchId: null,
          // An import confirms every field. Other returns confirm only fields whose ADO value
          // already equals the local one, never initial defaults that differ from local intent.
          ...(request.mode === 'import'
            ? { localBaseline: json(localValues(item)), remoteBaseline: json(normalized) }
            : existing
              ? confirmedEqual(existing, localValues(item), normalized)
              : {}),
        };
        if (existing) await tx.adoItemLink.update({ where: { id: existing.id }, data });
        else
          await tx.adoItemLink.create({
            data: {
              ...data,
              destinationId: destination.id,
              projectId: access.project.id,
              itemId,
              reference: randomBytes(32).toString('hex'),
            },
          });
        await tx.adoTransferRow.update({
          where: { batchId_index: { batchId, index: op.index } },
          data: { itemId, result: request.mode === 'import' ? 'APPLIED' : 'LINKED' },
        });
      }
      for (const pendingId of resolved)
        if (
          (await tx.adoItemLink.count({
            where: { projectId: access.project.id, pendingBatchId: pendingId },
          })) === 0
        )
          await tx.adoTransferBatch.update({
            where: { id: pendingId },
            data: { state: 'CONFIRMED', completedAt: new Date() },
          });
      const result = { ...content.preview, state: 'APPLIED' };
      await tx.adoTransferBatch.update({
        where: { id: batchId },
        data: {
          state: 'APPLIED',
          completedAt: new Date(),
          content: json({ ...content, preview: result }),
        },
      });
      await this.record(tx, auth, access, AuditAction.ADO_APPLIED, batchId, {
        rows: plan.operations.length,
        mode: request.mode,
      });
      return result;
    });
  }

  /**
   * Lists PM-only recoverable batches without returning stored file contents.
   * @param access Project access.
   * @param page Cursor pagination.
   * @returns Safe batch summaries.
   */
  async history(
    access: ProjectAccess,
    page: PageQueryDto,
  ): Promise<Page<{ id: string; state: string; mode: string; review: string; createdAt: string }>> {
    const where = { projectId: access.project.id };
    if (
      page.cursor &&
      !(await this.prisma.adoTransferBatch.count({ where: { ...where, id: page.cursor } }))
    )
      return { items: [], nextCursor: null };
    const rows = await this.prisma.adoTransferBatch.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(page),
    });
    return toPage(rows, page, (b) => ({
      id: b.id,
      state: b.state,
      mode: b.mode,
      review: b.review,
      createdAt: b.createdAt.toISOString(),
    }));
  }

  /**
   * Recovers a scoped PM review/receipt.
   * @param access Project access.
   * @param batchId Scoped identity.
   * @returns Review or compact expired-content receipt.
   */
  async recover(access: ProjectAccess, batchId: string): Promise<AdoPreview> {
    return this.receipt(await this.batch(this.prisma, access, batchId));
  }

  /**
   * Downloads exact reserved outbound bytes; a download is never confirmation.
   * @param access PM/Lead access.
   * @param batchId Scoped outbound identity.
   * @returns ZIP bytes and safe filename.
   */
  async download(
    access: ProjectAccess,
    batchId: string,
  ): Promise<{ bytes: Buffer; filename: string }> {
    const batch = await this.batch(this.prisma, access, batchId);
    if (batch.direction !== 'OUT' || batch.state === 'CANCELLED') throw notFound('Export');
    const content = batch.content as unknown as BatchContent;
    if (!content.files) throw conflict('Completed file content expired; the receipt is retained');
    const zip = new JSZip();
    for (const file of content.files) zip.file(`${batch.id}-${file.name}`, file.csv);
    return {
      bytes: await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
      filename: `ado-${batch.id}.zip`,
    };
  }

  /**
   * Cancels pending creates only after explicit duplicate-risk acknowledgement.
   * @param auth Signed-in PM.
   * @param access Project access.
   * @param batchId Pending outbound batch.
   * @param acknowledged Operator understands replay cannot be prevented inside ADO.
   * @returns Cancelled receipt.
   */
  async cancel(
    auth: AuthContext,
    access: ProjectAccess,
    batchId: string,
    acknowledged: boolean,
  ): Promise<AdoPreview> {
    if (!acknowledged)
      throw invalidField(
        'duplicateRiskAcknowledged',
        'Cancelling cannot undo ADO imports. A future create file can create duplicates.',
      );
    return this.transaction(async (tx) => {
      await this.current(tx, access, true);
      const batch = await this.batch(tx, access, batchId);
      if (batch.direction !== 'OUT' || !['PENDING', 'CANCELLED'].includes(batch.state))
        throw conflict('Only pending creates can be cancelled');
      if (batch.state === 'CANCELLED') return this.receipt(batch);
      await tx.adoItemLink.updateMany({
        where: { projectId: access.project.id, pendingBatchId: batch.id, remoteId: null },
        data: { pendingBatchId: null },
      });
      const content = batch.content as unknown as BatchContent;
      const result = { ...content.preview, state: 'CANCELLED' };
      await tx.adoTransferBatch.update({
        where: { id: batchId },
        data: {
          state: 'CANCELLED',
          completedAt: new Date(),
          content: json({ ...content, preview: result }),
        },
      });
      await this.record(tx, auth, access, AuditAction.ADO_CANCELLED, batchId, {});
      return result;
    });
  }

  /**
   * Removes completed content after 90 days and unapplied incoming previews after 7 days, while
   * retaining compact retry receipts and active links.
   */
  @Cron('0 15 4 * * *')
  async cleanup(): Promise<void> {
    const cutoff = new Date(Date.now() - 90 * 86400000);
    const previews = new Date(Date.now() - PREVIEW_DAYS * 86400000);
    await this.transaction(async (tx) => {
      const stale = await tx.adoTransferBatch.findMany({
        where: { state: 'PREVIEW', createdAt: { lt: previews }, contentExpiredAt: null },
        select: { id: true },
      });
      for (const batch of stale) {
        await tx.adoTransferRow.updateMany({ where: { batchId: batch.id }, data: { content: {} } });
        await tx.adoTransferBatch.update({
          where: { id: batch.id },
          data: { content: {}, contentExpiredAt: new Date() },
        });
      }
      const batches = await tx.adoTransferBatch.findMany({
        where: {
          completedAt: { lt: cutoff },
          contentExpiredAt: null,
          state: { in: ['APPLIED', 'CONFIRMED', 'PREPARED', 'CANCELLED'] },
        },
        select: { id: true },
      });
      for (const batch of batches) {
        if (await tx.adoItemLink.count({ where: { pendingBatchId: batch.id } })) continue;
        await tx.adoTransferRow.updateMany({ where: { batchId: batch.id }, data: { content: {} } });
        await tx.adoTransferBatch.update({
          where: { id: batch.id },
          data: { content: {}, contentExpiredAt: new Date() },
        });
      }
    });
  }

  private async validateIncoming(
    tx: Tx,
    access: ProjectAccess,
    operations: IncomingOperation[],
    items: TransferItem[],
  ): Promise<string[]> {
    const errors: string[] = [];
    const future = new Map(items.map((i) => [i.id, localValues(i)]));
    const localId = (remote: string): string =>
      operations.find((op) => op.remoteId === remote)?.itemId ?? `remote:${remote}`;
    for (const op of operations) {
      const key = op.itemId ?? `remote:${op.remoteId}`;
      const value: Values = { ...future.get(key), ...op.changes };
      if (typeof value.parentId === 'string' && value.parentId.startsWith('remote:'))
        value.parentId = localId(value.parentId.slice(7));
      future.set(key, value);
    }
    for (const op of operations) {
      try {
        const key = op.itemId ?? `remote:${op.remoteId}`,
          value = future.get(key)!;
        const { bucketId, ...fields } = op.changes;
        const validatedFields = { ...fields };
        // Virtual references are type-checked in the final graph below; real references still pass the ordinary DTO validators.
        if (
          typeof validatedFields.parentId === 'string' &&
          validatedFields.parentId.startsWith('remote:')
        )
          delete validatedFields.parentId;
        if (Array.isArray(validatedFields.labelIds))
          validatedFields.labelIds = validatedFields.labelIds.filter(
            (id) => !id.startsWith('label:'),
          );
        if (op.itemId) await checked(UpdateItemDto, validatedFields);
        else await checked(CreateItemDto, { ...validatedFields, bucketId });
        const type = value.type as TransferItem['type'];
        const bucket = await findBucketFor(
          tx,
          access.project.id,
          type,
          (value.bucketId as string | null | undefined) ?? null,
        );
        if (op.changes.sprintId !== undefined || !op.itemId)
          await assertOpenSprint(
            tx,
            access.project.id,
            (value.sprintId as string | null | undefined) ?? null,
          );
        if (Array.isArray(op.changes.assigneeIds)) {
          await assertMembers(tx, access.project.id, op.changes.assigneeIds);
          if (
            (await tx.projectMember.count({
              where: {
                projectId: access.project.id,
                userId: { in: op.changes.assigneeIds },
                user: { isActive: true },
              },
            })) !== op.changes.assigneeIds.length
          )
            throw invalidField(
              'Assigned To',
              'Chosen incoming assignees must be active project members',
            );
        }
        if (Array.isArray(op.changes.labelIds))
          await assertLabels(
            tx,
            access.project.id,
            op.changes.labelIds.filter((id) => !id.startsWith('label:')),
          );
        assertDateOrder(
          (value.startDate as string | null | undefined) ?? null,
          (value.dueDate as string | null | undefined) ?? null,
        );
        if (typeof value.parentId === 'string') {
          const parent = future.get(value.parentId);
          if (!parent)
            throw invalidField(
              'parentId',
              'Reviewed parent is not an existing or selected local item',
            );
          assertParentType(type, parent.type as TransferItem['type']);
        }
        assertChildrenFit(
          type,
          [...future.values()]
            .filter((v) => v.parentId === key)
            .map((v) => v.type as TransferItem['type']),
        );
        const seen = new Set([key]);
        for (
          let parent = value.parentId;
          typeof parent === 'string';
          parent = future.get(parent)?.parentId
        ) {
          if (seen.has(parent))
            throw invalidField('parentId', 'Reviewed hierarchy contains a cycle');
          seen.add(parent);
        }
        const current = items.find((i) => i.id === op.itemId);
        if (current) {
          if (value.type !== current.type) {
            // Ordinary updates validate existing children immediately. Do not promise a final-graph transition that cannot safely pass each ordinary write.
            try {
              assertChildrenFit(
                type,
                items.filter((i) => i.parentId === current.id).map((i) => i.type),
              );
            } catch {
              throw invalidField(
                'type',
                'Change or move existing children in a separate reviewed step before changing this parent type',
              );
            }
          }
          const existingParent = items.find((i) => i.id === value.parentId);
          if (existingParent) {
            try {
              assertParentType(type, existingParent.type);
            } catch {
              throw invalidField(
                'parentId',
                'Complete the parent type transition in a separate reviewed step before changing this child',
              );
            }
          }
          const desiredStatus = (value.status ?? current.status) as TransferItem['status'];
          const movedStatus =
            bucket && bucket.id !== current.bucketId
              ? statusOnEnter(bucket, current.status)
              : current.status;
          const finalBucket =
            movedStatus !== desiredStatus && bucket
              ? (access.settings.statusToBucket[desiredStatus] ?? bucket.id)
              : (bucket?.id ?? null);
          if (finalBucket !== value.bucketId)
            throw invalidField(
              'bucketId',
              'Reviewed bucket conflicts with ordinary status-to-bucket rules; review consistent mappings',
            );
        }
      } catch (error) {
        errors.push(
          `Row ${op.index + 1}: ${error instanceof Error ? error.message : 'Invalid reviewed fields'}`,
        );
      }
    }
    return errors;
  }

  private transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    return serializable(this.prisma, work, undefined, 120_000);
  }

  private async buildExport(tx: Tx, access: ProjectAccess, request: AdoExportRequest) {
    await this.current(tx, access, false);
    const context = await this.context(tx, access);
    const { destination, items, links, labels, sprints, members } = context;
    const mode = this.review(destination, request.review);
    const plan = exportPlan(
      destination,
      { ...request, review: mode },
      items,
      links,
      { labels, sprints },
      members,
    );
    const review = { ...request };
    delete review.previewDigest;
    delete review.idempotencyKey;
    const version = this.version(
      context,
      new Set(plan.rows.flatMap((r) => (r.itemId ? [r.itemId] : []))),
    );
    const preview: AdoPreview = {
      batchId: null,
      digest: digest({ review, version }),
      destination,
      rows: plan.rows,
      files: plan.files.map(({ name, rows }) => ({ name, rows })),
      warnings: plan.warnings,
      errors: plan.errors,
      state: 'PREVIEW',
      review: mode,
      summary: summarize(plan.rows, true),
    };
    return { preview, plan };
  }

  private async context(tx: Tx, access: ProjectAccess) {
    const destination = dto(await this.requiredDestination(tx, access));
    const items = await tx.workItem.findMany({
      where: this.items.scoped(access, {}),
      include: TRANSFER_INCLUDE,
      orderBy: { number: 'asc' },
    });
    const links = await tx.adoItemLink.findMany({
      where: { destinationId: destination.id, projectId: access.project.id },
      orderBy: { id: 'asc' },
    });
    const members = await tx.projectMember.findMany({
      where: { projectId: access.project.id },
      include: { user: { select: { isActive: true, email: true, displayName: true } } },
      orderBy: { id: 'asc' },
    });
    const buckets = await tx.bucket.findMany({
      where: { projectId: access.project.id },
      orderBy: { id: 'asc' },
    });
    const sprints = await tx.sprint.findMany({
      where: { projectId: access.project.id },
      orderBy: { id: 'asc' },
    });
    const labels = await tx.label.findMany({
      where: { projectId: access.project.id },
      orderBy: { id: 'asc' },
    });
    return {
      destination,
      items,
      links,
      labels,
      sprints,
      buckets,
      memberRows: members,
      members: members
        .filter((m) => m.user.isActive)
        .map((m): TransferMember => ({
          userId: m.userId,
          email: m.user.email,
          displayName: m.user.displayName,
        })),
      project: access.project.updatedAt,
    };
  }

  /**
   * Staleness digest over the destination, the project's shared references and only the items
   * this review touches, so edits to unrelated items do not invalidate it.
   * @param context Loaded transfer context.
   * @param ids Items the review reads.
   * @returns Version digest.
   */
  private version(context: Awaited<ReturnType<AdoService['context']>>, ids: Set<string>): string {
    return digest({
      destination: context.destination,
      items: context.items.filter((i) => ids.has(i.id)),
      links: context.links.filter((l) => ids.has(l.itemId)),
      members: context.memberRows,
      buckets: context.buckets,
      sprints: context.sprints,
      labels: context.labels,
      project: context.project,
    });
  }

  /**
   * Resolves the review mode, enforcing a PM's Detailed-only policy.
   * @param destination Destination with its policy.
   * @param requested Mode asked for; Quick when omitted.
   * @returns Mode to use.
   */
  private review(destination: AdoDestinationDto, requested: AdoReview | undefined): AdoReview {
    const mode = requested ?? 'quick';
    if (mode === 'quick' && destination.requireDetailedReview)
      throw invalidField('review', 'A project PM requires Detailed review for ADO transfers');
    return mode;
  }

  private async requiredDestination(
    tx: Tx | PrismaService,
    access: ProjectAccess,
  ): Promise<AdoDestination> {
    if (access.project.ownerId !== null) throw notFound('Project');
    const row = await tx.adoDestination.findUnique({ where: { projectId: access.project.id } });
    if (!row)
      throw invalidField(
        'destination',
        'A project PM must configure and review the ADO destination first',
      );
    return row;
  }

  private async current(tx: Tx, access: ProjectAccess, pm: boolean): Promise<void> {
    const project = await tx.project.findUnique({ where: { id: access.project.id } });
    if (!project || project.ownerId !== null) throw notFound('Project');
    const fresh = await this.access.accessesOf(tx, project.id, [access.userId]);
    const member = fresh.get(access.userId);
    if (!member || (member.role !== ProjectRole.PM && (pm || member.role !== ProjectRole.LEAD)))
      throw forbidden();
    if (project.archivedAt !== null) throw projectArchived();
  }

  private async batch(
    tx: Tx | PrismaService,
    access: ProjectAccess,
    batchId: string,
  ): Promise<AdoTransferBatch> {
    const batch = await tx.adoTransferBatch.findFirst({
      where: { id: batchId, projectId: access.project.id },
    });
    if (!batch) throw notFound('Batch');
    return batch;
  }

  private async receipt(batch: AdoTransferBatch): Promise<AdoPreview> {
    const content = batch.content as unknown as Partial<BatchContent>;
    if (content.preview) return { ...content.preview, state: batch.state };
    const destination = await this.prisma.adoDestination.findUniqueOrThrow({
      where: { id: batch.destinationId },
    });
    return {
      batchId: batch.id,
      digest: batch.digest,
      destination: dto(destination),
      rows: [],
      files: [],
      warnings: [
        'The stored review content has expired. This durable receipt still prevents duplicate creates on retry.',
      ],
      errors: [],
      state: batch.state,
    };
  }

  private async references(tx: Tx, projectId: string, profile: AdoProfile): Promise<void> {
    const check = async (kind: 'bucket' | 'sprint' | 'label', ids: string[]): Promise<void> => {
      const unique = [...new Set(ids)];
      const count =
        kind === 'bucket'
          ? await tx.bucket.count({ where: { projectId, id: { in: unique } } })
          : kind === 'sprint'
            ? await tx.sprint.count({ where: { projectId, id: { in: unique } } })
            : await tx.label.count({ where: { projectId, id: { in: unique } } });
      if (count !== unique.length)
        throw invalidField('profile', `Mapped ${kind} must exist in this project`);
    };
    await check(
      'bucket',
      Object.values(profile.incomingStates).map((m) => m.bucketId),
    );
    await check(
      'sprint',
      Object.values(profile.iterations).filter((v): v is string => v !== null),
    );
    await check(
      'label',
      Object.values(profile.tags).filter((v): v is string => v !== null),
    );
    const users = [
      ...new Set([
        ...Object.keys(profile.identities),
        ...Object.values(profile.incomingIdentities).filter((v): v is string => v !== null),
      ]),
    ];
    if (
      (await tx.projectMember.count({
        where: { projectId, userId: { in: users }, user: { isActive: true } },
      })) !== users.length
    )
      throw invalidField('identities', 'Mapped assignees must be active project members');
  }

  private labelChoices(request: AdoImportRequest): void {
    const seen = new Set<string>();
    for (const raw of request.createLabels) {
      const value = object(raw);
      if (
        typeof value['tag'] !== 'string' ||
        !value['tag'] ||
        typeof value['name'] !== 'string' ||
        !value['name'].trim() ||
        value['name'].length > 100 ||
        typeof value['colour'] !== 'string' ||
        !/^#[a-f0-9]{6}$/iu.test(value['colour']) ||
        seen.has(value['tag'])
      )
        throw invalidField('createLabels', 'Review distinct tag, label name and hex colour');
      seen.add(value['tag']);
    }
  }

  private record(
    tx: Tx,
    auth: AuthContext,
    access: ProjectAccess,
    action: AuditAction,
    entityId: string,
    meta: Prisma.InputJsonObject,
  ): Promise<void> {
    return this.audit.record(
      {
        actorId: auth.user.id,
        projectId: access.project.id,
        action,
        entityId,
        entityType: 'AdoTransfer',
        meta,
      },
      tx,
    );
  }
}

function dto(row: AdoDestination): AdoDestinationDto {
  return {
    id: row.id,
    organization: row.organization,
    remoteProject: row.remoteProject,
    profile: validateProfile(row.profile),
    revision: row.revision,
    requireDetailedReview: row.requireDetailedReview,
  };
}

/**
 * Counts rows by kind and the fields actually sent or applied, for the one-glance summary.
 * @param rows Reviewed rows.
 * @param choices Whether this review applies field choices (link-only and observe do not).
 * @returns Summary.
 */
function summarize(rows: AdoPreview['rows'], choices: boolean): AdoSummary {
  const summary: AdoSummary = { kinds: {}, fields: {}, conflicts: 0 };
  for (const row of rows) {
    summary.kinds[row.kind] = (summary.kinds[row.kind] ?? 0) + 1;
    for (const field of row.changes ?? []) summary.fields[field] = (summary.fields[field] ?? 0) + 1;
    if (choices) summary.conflicts += row.differences.filter((d) => d.choice === undefined).length;
  }
  return summary;
}

/**
 * Baselines extended with the fields whose observed ADO value equals the local value.
 * @param link Existing link.
 * @param link.localBaseline Confirmed local values.
 * @param link.remoteBaseline Confirmed ADO values.
 * @param local Current local values.
 * @param remote Observed ADO values.
 * @returns Baseline updates for the link.
 */
function confirmedEqual(
  link: { localBaseline: unknown; remoteBaseline: unknown },
  local: Values,
  remote: Values,
): { localBaseline: Prisma.InputJsonValue; remoteBaseline: Prisma.InputJsonValue } {
  const lb = { ...(link.localBaseline as Values) },
    rb = { ...(link.remoteBaseline as Values) };
  for (const field of Object.keys(remote) as AdoField[])
    if (field !== 'bucketId' && sameValue(field, local[field], remote[field])) {
      lb[field] = local[field] ?? null;
      rb[field] = remote[field] ?? null;
    }
  return { localBaseline: json(lb), remoteBaseline: json(rb) };
}

/**
 * Items an incoming review reads: linked rows and their old and new parents.
 * @param operations Planned rows.
 * @param items Current items.
 * @returns Item IDs.
 */
function incomingIds(operations: IncomingOperation[], items: TransferItem[]): Set<string> {
  const ids = new Set<string>();
  for (const op of operations) {
    if (op.itemId) ids.add(op.itemId);
    const parent = op.incoming.parentId;
    if (typeof parent === 'string' && !parent.startsWith('remote:')) ids.add(parent);
    const current = items.find((i) => i.id === op.itemId)?.parentId;
    if (current) ids.add(current);
  }
  return ids;
}
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
async function checked<T extends object>(constructor: new () => T, value: object): Promise<T> {
  const instance = plainToInstance(constructor, value);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true });
  if (errors.length)
    throw invalidField(
      'row',
      errors
        .map((e) => `${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
        .join('; '),
    );
  return instance;
}
