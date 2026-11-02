import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  type ItemPreviewDto,
  type ItemReferrerDto,
  ProjectPermission as P,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { ItemsService } from './items.service.js';
import { ReferencesQueryDto } from './references.dto.js';
import { ReferencesService } from './references.service.js';

/**
 * Item references in rich text (M12): previews for hover cards and the
 * "Referenced in" list of an item.
 *
 * Permissions: previews need a signed-in user and return only items of
 * projects they are a member of and can see; "Referenced in" goes through
 * {@link ProjectAccessGuard} and lists only referring items the caller can
 * see.
 */
@Controller()
export class ReferencesController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param references Reference previews.
   * @param items "Referenced in" through the visibility filter.
   */
  constructor(
    private readonly references: ReferencesService,
    private readonly items: ItemsService,
  ) {}

  /**
   * Previews referenced items by key (`KLO-12`). Permissions: signed in;
   * unknown, hidden and trashed items are left out.
   *
   * @param auth The caller.
   * @param query The keys.
   * @returns The visible items.
   */
  @Get('references')
  previews(
    @CurrentAuth() auth: AuthContext,
    @Query() query: ReferencesQueryDto,
  ): Promise<ItemPreviewDto[]> {
    return this.references.previews(auth, query.keys);
  }

  /**
   * Lists the visible items whose description or notes name this item.
   * Permissions: any member and admin, within scope; 404 unless the item is
   * visible.
   *
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @returns The referring items.
   */
  @Get('projects/:id/items/:item/referenced-in')
  @UseGuards(ProjectAccessGuard)
  @RequireProjectPermission(P.VIEW_ITEMS)
  referencedIn(
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
  ): Promise<ItemReferrerDto[]> {
    return this.items.referencedIn(access, item);
  }
}
