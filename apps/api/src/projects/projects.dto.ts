import {
  type AddMemberRequest,
  type CreateProjectRequest,
  ItemStatus,
  LabelStyle,
  MAX_INITIAL_PMS,
  PROJECT_DESCRIPTION_MAX,
  PROJECT_KEY_PATTERN,
  PROJECT_NAME_MAX,
  ProjectRole,
  type ProjectSettings,
  type StatusToBucket,
  type UpdateMemberRequest,
  type UpdateProjectRequest,
  Visibility,
} from '@kloister/shared';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  isUUID,
  Length,
  Matches,
  MaxLength,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';
import { LowercaseUuid } from '../common/uuid.js';

/**
 * Trims string input; leaves anything else for the validators to reject.
 *
 * @param params class-transformer callback parameters.
 * @param params.value Raw value.
 * @returns The trimmed value.
 */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Like `@IsOptional()` but only for absent fields: an explicit `null` is
 * still validated (and rejected), because these columns are NOT NULL.
 *
 * @returns The property decorator.
 */
const OmittableNotNull = (): PropertyDecorator =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

/** Largest number of buckets a `BUCKETS` scope may list. */
const MAX_ALLOWED_BUCKETS = 200;

/** Body of `POST /projects`. */
export class CreateProjectDto implements CreateProjectRequest {
  /** 2–6 letters; lowercase input is uppercased. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(PROJECT_KEY_PATTERN, { message: 'key must be 2 to 6 letters' })
  key: string;

  /** Display name. */
  @Transform(trim)
  @IsString()
  @Length(1, PROJECT_NAME_MAX)
  name: string;

  /** Optional plain-text description. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(PROJECT_DESCRIPTION_MAX)
  description?: string;

  /** The Project Managers: one or more distinct users. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_INITIAL_PMS)
  @ArrayUnique()
  @LowercaseUuid()
  @IsUUID('all', { each: true })
  pmUserIds: string[];
}

/**
 * Accepts a status → bucket map: an object whose keys are item statuses and
 * whose values are bucket uuids. Whether the buckets belong to the project is
 * checked by the service.
 *
 * @returns The property decorator.
 */
const IsStatusToBucket = (): PropertyDecorator =>
  ValidateBy({
    name: 'isStatusToBucket',
    validator: {
      validate: (value: unknown) =>
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.entries(value).every(
          ([status, bucketId]) =>
            (Object.values(ItemStatus) as string[]).includes(status) &&
            typeof bucketId === 'string' &&
            isUUID(bucketId),
        ),
      defaultMessage: () => '$property must map item statuses to bucket ids',
    },
  });

/** The settings part of `PATCH /projects/:id`. */
export class ProjectSettingsChangeDto implements Partial<ProjectSettings> {
  /** Lets Members assign items to others. */
  @OmittableNotNull()
  @IsBoolean()
  membersCanAssignOthers?: boolean;

  /** Replaces the status → bucket map (SPEC §4.2); `{}` clears it. */
  @OmittableNotNull()
  @IsStatusToBucket()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, typeof v === 'string' ? v.toLowerCase() : v]),
        )
      : value,
  )
  statusToBucket?: StatusToBucket;

  /** Label style for the whole project (SPEC §4, §6). */
  @OmittableNotNull()
  @IsIn(Object.values(LabelStyle))
  labelStyle?: LabelStyle;
}

/** Body of `PATCH /projects/:id`. */
export class UpdateProjectDto implements UpdateProjectRequest {
  /** New display name. */
  @OmittableNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, PROJECT_NAME_MAX)
  name?: string;

  /** New description. */
  @OmittableNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(PROJECT_DESCRIPTION_MAX)
  description?: string;

  /** Settings to change. */
  @OmittableNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => ProjectSettingsChangeDto)
  settings?: ProjectSettingsChangeDto;
}

/** Query string of `GET /projects`. */
export class ListProjectsQueryDto extends PageQueryDto {
  /** `mine` (default) or `all`; `all` is for system admins only. */
  @IsOptional()
  @IsIn(['mine', 'all'])
  scope?: 'mine' | 'all';

  /** Include archived projects (default false). */
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeArchived?: boolean;

  /** Case-insensitive substring match on key or name. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

/** Body of `POST /projects/:id/members`. */
export class AddMemberDto implements AddMemberRequest {
  /** User to add. */
  @LowercaseUuid()
  @IsUUID()
  userId: string;

  /** Project role. */
  @IsIn(Object.values(ProjectRole))
  role: ProjectRole;

  /** Visibility scope; defaults to `ALL`. */
  @IsOptional()
  @IsIn(Object.values(Visibility))
  visibility?: Visibility;

  /** Buckets visible under `BUCKETS` scope. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ALLOWED_BUCKETS)
  @LowercaseUuid()
  @IsUUID('all', { each: true })
  allowedBucketIds?: string[];
}

/** Body of `PATCH /projects/:id/members/:userId`. */
export class UpdateMemberDto implements UpdateMemberRequest {
  /** New role. */
  @OmittableNotNull()
  @IsIn(Object.values(ProjectRole))
  role?: ProjectRole;

  /** New visibility scope. */
  @OmittableNotNull()
  @IsIn(Object.values(Visibility))
  visibility?: Visibility;

  /** New bucket list. */
  @OmittableNotNull()
  @IsArray()
  @ArrayMaxSize(MAX_ALLOWED_BUCKETS)
  @LowercaseUuid()
  @IsUUID('all', { each: true })
  allowedBucketIds?: string[];
}

/** Query string of `GET /projects/:id/member-candidates`. */
export class MemberCandidatesQueryDto {
  /** Case-insensitive substring match on email or display name. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
