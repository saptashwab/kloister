import { inlineImagePath } from '@kloister/shared';
import type { DbClient } from '../audit/audit.service.js';
import { imageIdsIn, type RichTextRules, sanitizeWithMentions } from '../common/sanitize-html.js';

/**
 * Sanitizes an item's description or note (SPEC §5), keeping only images
 * that are inline images of that same item, served by its own endpoint,
 * mentions of the given users and references the writer may see (M12).
 *
 * @param db Database or transaction client.
 * @param projectId The item's project.
 * @param itemId The item.
 * @param html Untrusted HTML from the request.
 * @param mentions Users who may be mentioned, with their names (notes only).
 * @param references References to mark, as written → canonical key.
 * @returns Safe HTML, the users its mentions name and the items it references.
 */
export async function sanitizeItemText(
  db: DbClient,
  projectId: string,
  itemId: string,
  html: string,
  mentions?: ReadonlyMap<string, string>,
  references?: ReadonlyMap<string, string>,
): Promise<{ html: string; mentioned: string[]; references: string[] }> {
  const candidates = imageIdsIn(html);
  const images =
    candidates.length === 0
      ? []
      : await db.attachment.findMany({
          where: { id: { in: candidates }, workItemId: itemId, inline: true },
          select: { id: true },
        });
  const rules: RichTextRules = {
    images: {
      prefix: inlineImagePath(projectId, itemId, ''),
      ids: new Set(images.map((i) => i.id)),
    },
    ...(mentions === undefined ? {} : { mentions }),
    ...(references === undefined ? {} : { references }),
  };
  return sanitizeWithMentions(html, rules);
}
