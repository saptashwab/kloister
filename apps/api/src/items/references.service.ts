import { Injectable } from '@nestjs/common';
import {
  type ItemPreviewDto,
  type ItemReferrerDto,
  markedReferences,
  parseReferenceKey,
  REFERENCE_KEYS_MAX,
  referenceKey,
  referenceTokens,
  unmarkReferences,
} from '@kloister/shared';
import type { DbClient } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { fromDbDate } from '../common/dates.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { type ProjectAccess, ProjectAccessService } from '../projects/project-access.service.js';
import { toItemRef } from './item.mapper.js';

/** Most distinct references resolved in one text. */
const TOKENS_MAX = 200;

/** Item numbers wanted per project key (null: the text's own project). */
type Wanted = Map<string | null, Set<number>>;

/**
 * Groups references by project key.
 *
 * @param refs Keys and numbers.
 * @returns The numbers per key.
 */
function group(refs: readonly { key: string | null; number: number }[]): Wanted {
  const wanted: Wanted = new Map();
  for (const ref of refs.slice(0, TOKENS_MAX)) {
    const numbers = wanted.get(ref.key) ?? new Set<number>();
    numbers.add(ref.number);
    wanted.set(ref.key, numbers);
  }
  return wanted;
}

/**
 * Item references in descriptions and notes (M12 plan section 6): which
 * references a writer may mark, which marks a reader may see, the
 * "Referenced in" rows kept in step with the text, and previews.
 *
 * Non-disclosure (SPEC §3.4): a reference is marked only when the writer can
 * see the item, and a mark is returned only to readers who can see it too;
 * everyone else gets the plain text they would have read anyway. Items of
 * other projects count only where the person is a member, with that
 * membership's visibility; trashed items never count.
 */
@Injectable()
export class ReferencesService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param access Visibility rules and other projects' access.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * The references in untrusted text that the writer may mark, from the text
   * as written to the canonical key, for the sanitizer.
   *
   * @param db Database or transaction client.
   * @param access The writer's access to the text's project.
   * @param html Untrusted HTML.
   * @param previous The stored text being replaced: its marks stay when the
   *   same key is still written, so an editor who sees less (and got those
   *   references as plain text) does not remove them.
   * @returns Text as written → canonical key.
   */
  async markable(
    db: DbClient,
    access: ProjectAccess,
    html: string,
    previous = '',
  ): Promise<Map<string, string>> {
    const tokens = referenceTokens(html);
    if (tokens.length === 0) return new Map();
    const kept = new Set(markedReferences(previous));
    const own = access.project.key;
    const visible = await this.visibleKeys(
      db,
      access,
      group(tokens.map((t) => ({ key: t.key === own ? null : t.key, number: t.number }))),
    );
    const map = new Map<string, string>();
    for (const token of tokens) {
      const sameProject = token.key === null || token.key === own;
      const canonical = referenceKey(sameProject ? own : token.key, token.number);
      if (visible.has(canonical) || kept.has(token.text))
        map.set(token.text, visible.has(canonical) ? canonical : token.text);
    }
    return map;
  }

  /**
   * Returns stored HTML for one reader: marks of items they cannot see
   * become plain text.
   *
   * @param db Database or transaction client.
   * @param access The reader's access to the texts' project.
   * @param htmls Stored descriptions or notes.
   * @returns The HTML for this reader, in the same order.
   */
  async redact(db: DbClient, access: ProjectAccess, htmls: readonly string[]): Promise<string[]> {
    const keys = [
      ...new Set(htmls.flatMap((h) => (h.includes('data-ref') ? markedReferences(h) : []))),
    ];
    if (keys.length === 0) return [...htmls];
    const visible = await this.visibleKeys(db, access, this.wantedFromKeys(access, keys));
    return htmls.map((h) => unmarkReferences(h, (key) => visible.has(key)));
  }

  /**
   * Rebuilds an item's "Referenced in" rows from its description and notes,
   * after any of them changed. The marks were checked when written, so the
   * targets are looked up without a scope; trashed targets keep their rows.
   *
   * @param db Transaction client.
   * @param itemId The item whose text changed.
   * @returns Resolves once the rows match the text.
   */
  async sync(db: DbClient, itemId: string): Promise<void> {
    const item = await db.workItem.findUnique({
      where: { id: itemId },
      select: {
        projectId: true,
        description: true,
        project: { select: { key: true } },
        notes: { select: { body: true } },
      },
    });
    if (item === null) return;
    const keys = markedReferences([item.description, ...item.notes.map((n) => n.body)].join(''));
    const own = item.project.key;
    const parsed = keys.flatMap((k) => {
      const ref = parseReferenceKey(k);
      return ref === null ? [] : [{ key: ref.key === own ? null : ref.key, number: ref.number }];
    });
    const conditions = [...group(parsed)].map(([key, numbers]) => ({
      number: { in: [...numbers] },
      ...(key === null ? { projectId: item.projectId } : { project: { key } }),
    }));
    const targets =
      conditions.length === 0
        ? []
        : await db.workItem.findMany({ where: { OR: conditions }, select: { id: true } });
    const ids = targets.map((t) => t.id).filter((id) => id !== itemId);
    await db.itemReference.deleteMany({
      where: { sourceItemId: itemId, targetItemId: { notIn: ids } },
    });
    if (ids.length > 0)
      await db.itemReference.createMany({
        data: ids.map((targetItemId) => ({ sourceItemId: itemId, targetItemId })),
        skipDuplicates: true,
      });
  }

  /**
   * Previews of referenced items by canonical key, for hover cards on items
   * outside the open project (M12).
   *
   * Permissions: signed in; only items of ordinary projects the caller is a
   * member of and can see are returned. Unknown, hidden and trashed items are
   * left out without a trace.
   *
   * @param auth The caller.
   * @param keys Canonical keys (`KLO-12`), at most {@link REFERENCE_KEYS_MAX}.
   * @returns The visible items.
   */
  async previews(auth: AuthContext, keys: readonly string[]): Promise<ItemPreviewDto[]> {
    const parsed = keys
      .slice(0, REFERENCE_KEYS_MAX)
      .map(parseReferenceKey)
      .filter((r): r is { key: string; number: number } => r !== null && r.key !== null);
    if (parsed.length === 0) return [];
    const projects = await this.prisma.project.findMany({
      where: { key: { in: [...new Set(parsed.map((r) => r.key))] }, ownerId: null },
      select: { id: true },
    });
    const accesses = await this.access.memberAccessesIn(
      auth,
      projects.map((p) => p.id),
    );
    const result: ItemPreviewDto[] = [];
    for (const access of accesses) {
      const numbers = parsed.filter((r) => r.key === access.project.key).map((r) => r.number);
      const rows = await this.prisma.workItem.findMany({
        where: {
          AND: [
            { projectId: access.project.id, number: { in: numbers } },
            this.access.itemScopeFilter(access),
          ],
        },
        select: {
          id: true,
          number: true,
          type: true,
          title: true,
          status: true,
          dueDate: true,
          assignees: { select: { userId: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        },
        orderBy: { number: 'asc' },
      });
      for (const row of rows) {
        result.push({
          ...toItemRef(access.project.key, row),
          projectId: access.project.id,
          status: row.status,
          assigneeIds: row.assignees.map((a) => a.userId),
          dueDate: fromDbDate(row.dueDate),
        });
      }
    }
    return result;
  }

  /**
   * The items whose description or notes name an item ("Referenced in"),
   * limited to those the caller can see: in this project with their scope,
   * elsewhere only where they are a member.
   *
   * @param access The caller's access to the item's project.
   * @param itemId The item, already checked to be visible.
   * @returns The referring items, by project and number.
   */
  async referencedIn(access: ProjectAccess, itemId: string): Promise<ItemReferrerDto[]> {
    const rows = await this.prisma.itemReference.findMany({
      where: { targetItemId: itemId },
      select: { source: { select: { id: true, projectId: true } } },
    });
    const byProject = new Map<string, string[]>();
    for (const { source } of rows) {
      byProject.set(source.projectId, [...(byProject.get(source.projectId) ?? []), source.id]);
    }
    const result: ItemReferrerDto[] = [];
    for (const [projectId, ids] of byProject) {
      const reader =
        projectId === access.project.id
          ? access
          : (await this.access.accessesOf(this.prisma, projectId, [access.userId])).get(
              access.userId,
            );
      if (reader === undefined) continue;
      const visible = await this.prisma.workItem.findMany({
        where: {
          AND: [{ projectId, id: { in: ids } }, this.access.itemScopeFilter(reader)],
        },
        select: { id: true, number: true, type: true, title: true },
        orderBy: { number: 'asc' },
      });
      result.push(...visible.map((v) => ({ ...toItemRef(reader.project.key, v), projectId })));
    }
    return result;
  }

  /**
   * Groups canonical keys of stored marks by project for a reader of the
   * given project.
   *
   * @param access The reader's access.
   * @param keys Canonical keys.
   * @returns The numbers per key (null: the reader's project).
   */
  private wantedFromKeys(access: ProjectAccess, keys: readonly string[]): Wanted {
    const own = access.project.key;
    return group(
      keys.flatMap((k) => {
        const ref = parseReferenceKey(k);
        return ref === null ? [] : [{ key: ref.key === own ? null : ref.key, number: ref.number }];
      }),
    );
  }

  /**
   * The canonical keys of the wanted items that this person can see: in the
   * open project with their scope, in other projects only as a member there.
   *
   * @param db Database or transaction client.
   * @param access The person's access to the open project.
   * @param wanted Numbers per project key (null: the open project).
   * @returns Visible canonical keys.
   */
  private async visibleKeys(
    db: DbClient,
    access: ProjectAccess,
    wanted: Wanted,
  ): Promise<Set<string>> {
    const visible = new Set<string>();
    for (const [key, numbers] of wanted) {
      let reader: ProjectAccess | undefined = access;
      if (key !== null) {
        const project = await db.project.findFirst({
          where: { key, ownerId: null },
          select: { id: true },
        });
        reader =
          project === null
            ? undefined
            : (await this.access.accessesOf(db, project.id, [access.userId])).get(access.userId);
      }
      if (reader === undefined) continue;
      const rows = await db.workItem.findMany({
        where: {
          AND: [
            { projectId: reader.project.id, number: { in: [...numbers] } },
            this.access.itemScopeFilter(reader),
          ],
        },
        select: { number: true },
      });
      for (const row of rows) visible.add(referenceKey(reader.project.key, row.number));
    }
    return visible;
  }
}
