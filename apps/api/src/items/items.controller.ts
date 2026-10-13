import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  type AuditEntryDto,
  type Page,
  ProjectPermission as P,
  type WorkItemDetailDto,
  type WorkItemDto,
} from '@kloister/shared';
import type { AuthContext } from '../auth/auth-context.js';
import { CurrentAuth } from '../auth/decorators.js';
import { PageQueryDto } from '../common/pagination.js';
import {
  CurrentProject,
  ProjectAccessGuard,
  RequireProjectPermission,
} from '../projects/project-access.guard.js';
import type { ProjectAccess } from '../projects/project-access.service.js';
import { DependenciesService } from './dependencies.service.js';
import {
  AddDependencyDto,
  CreateItemDto,
  DeleteItemQueryDto,
  ListItemsQueryDto,
  MoveItemDto,
  UpdateItemDto,
} from './items.dto.js';
import { ItemsService } from './items.service.js';

/**
 * Work items under `/api/v1/projects/:id/items` (SPEC §8 `items`, `/move`,
 * `/children`). `:item` is the item's uuid or its per-project number.
 *
 * Permissions: every route goes through {@link ProjectAccessGuard}
 * (non-members 404, archived projects read-only) and needs the role-level
 * permission named on it (403 otherwise; for conditional rows either the
 * "any" or the "own" permission). The service then applies the visibility
 * scope (items outside it are 404) and the per-item rules (403).
 */
@Controller('projects/:id/items')
@UseGuards(ProjectAccessGuard)
export class ItemsController {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param items Item operations.
   * @param dependencies Dependency operations.
   */
  constructor(
    private readonly items: ItemsService,
    private readonly dependencies: DependenciesService,
  ) {}

  /**
   * Lists visible items. Permissions: any member and admin, within scope.
   *
   * @param access The caller's access.
   * @param query Filters, order and pagination.
   * @returns One page of items.
   */
  @Get()
  @RequireProjectPermission(P.VIEW_ITEMS)
  list(
    @CurrentProject() access: ProjectAccess,
    @Query() query: ListItemsQueryDto,
  ): Promise<Page<WorkItemDto>> {
    return this.items.list(access, query);
  }

  /**
   * Creates an item. Permissions: `CREATE_ITEMS` (PM, Lead, Member).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param body The item.
   * @returns The new item (201).
   */
  @Post()
  @RequireProjectPermission(P.CREATE_ITEMS)
  create(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Body() body: CreateItemDto,
  ): Promise<WorkItemDetailDto> {
    return this.items.create(auth, access, body);
  }

  /**
   * Returns one item. Permissions: visible items only (404 otherwise).
   *
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @returns The item with checklist and dependencies.
   */
  @Get(':item')
  @RequireProjectPermission(P.VIEW_ITEMS)
  get(
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
  ): Promise<WorkItemDetailDto> {
    return this.items.get(access, item);
  }

  /**
   * Edits an item. Permissions: `EDIT_ANY_ITEM`, or `EDIT_OWN_ITEMS` on own
   * items, or leading the item's team.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param body Fields to change.
   * @returns The updated item.
   */
  @Patch(':item')
  @RequireProjectPermission([P.EDIT_ANY_ITEM, P.EDIT_OWN_ITEMS])
  update(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Body() body: UpdateItemDto,
  ): Promise<WorkItemDetailDto> {
    return this.items.update(auth, access, item, body);
  }

  /**
   * Deletes an item (`?cascade=true` for its subtree). Permissions:
   * `DELETE_ANY_ITEM`, or `DELETE_OWN_ITEMS` on own childless items, or
   * leading the item's team (no cascade).
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param query Cascade flag.
   * @returns Resolves once deleted (204).
   */
  @Delete(':item')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireProjectPermission([P.DELETE_ANY_ITEM, P.DELETE_OWN_ITEMS])
  remove(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Query() query: DeleteItemQueryDto,
  ): Promise<void> {
    return this.items.remove(auth, access, item, query.cascade ?? false);
  }

  /**
   * Moves a card into or within a bucket. Permissions: `MOVE_ANY_ITEM`, or
   * `MOVE_OWN_ITEMS` on own/assigned cards, or leading the item's team.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param body Target bucket and neighbour.
   * @returns The item with its final bucket and status.
   */
  @Post(':item/move')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission([P.MOVE_ANY_ITEM, P.MOVE_OWN_ITEMS])
  move(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Body() body: MoveItemDto,
  ): Promise<WorkItemDetailDto> {
    return this.items.move(auth, access, item, body);
  }

  /**
   * Lists an item's visible children. Permissions: visible parent only.
   *
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param query Pagination.
   * @returns One page of children.
   */
  @Get(':item/children')
  @RequireProjectPermission(P.VIEW_ITEMS)
  children(
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Query() query: PageQueryDto,
  ): Promise<Page<WorkItemDto>> {
    return this.items.children(access, item, query);
  }

  /**
   * Returns an item's activity history. Permissions: visible items only.
   *
   * @param access The caller's access.
   * @param item Item uuid or number.
   * @param query Pagination.
   * @returns One page of audit entries, newest first.
   */
  @Get(':item/activity')
  @RequireProjectPermission(P.VIEW_ITEMS)
  activity(
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Query() query: PageQueryDto,
  ): Promise<Page<AuditEntryDto>> {
    return this.items.activity(access, item, query);
  }

  /**
   * Marks the item as blocked by another. Permissions: as for editing the item.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Blocked item uuid or number.
   * @param body The blocking item.
   * @returns The blocked item.
   */
  @Post(':item/dependencies')
  @HttpCode(HttpStatus.OK)
  @RequireProjectPermission([P.EDIT_ANY_ITEM, P.EDIT_OWN_ITEMS])
  addDependency(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Body() body: AddDependencyDto,
  ): Promise<WorkItemDetailDto> {
    return this.dependencies.add(auth, access, item, body);
  }

  /**
   * Removes a "blocked by" dependency. Permissions: as for editing the item.
   *
   * @param auth The caller.
   * @param access The caller's access.
   * @param item Blocked item uuid or number.
   * @param blockingItemId The blocking item's id.
   * @returns The blocked item.
   */
  @Delete(':item/dependencies/:blockingItemId')
  @RequireProjectPermission([P.EDIT_ANY_ITEM, P.EDIT_OWN_ITEMS])
  removeDependency(
    @CurrentAuth() auth: AuthContext,
    @CurrentProject() access: ProjectAccess,
    @Param('item') item: string,
    @Param('blockingItemId', ParseUUIDPipe) blockingItemId: string,
  ): Promise<WorkItemDetailDto> {
    return this.dependencies.remove(auth, access, item, blockingItemId);
  }
}
