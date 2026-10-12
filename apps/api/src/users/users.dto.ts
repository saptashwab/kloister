import {
  type CreateUserRequest,
  SystemRole,
  type UpdateMeRequest,
  type UpdateUserRequest,
} from '@kloister/shared';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../common/pagination.js';

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
 * still validated (and rejected), because these columns are NOT NULL and
 * `null` would otherwise reach the database as an invalid update.
 *
 * @returns The property decorator.
 */
const OmittableNotNull = (): PropertyDecorator =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

/** Display names: 1–100 characters after trimming. */
const DISPLAY_NAME_MAX = 100;

/** Body of `POST /admin/users`. */
export class CreateUserDto implements CreateUserRequest {
  /** Login email. TLDs are optional because internal mail domains often lack one. */
  @Transform(trim)
  @IsEmail({ require_tld: false })
  @MaxLength(254)
  email: string;

  /** Name shown in the UI. */
  @Transform(trim)
  @IsString()
  @Length(1, DISPLAY_NAME_MAX)
  displayName: string;

  /** Defaults to `USER`. */
  @IsOptional()
  @IsIn(Object.values(SystemRole))
  systemRole?: SystemRole;
}

/** Body of `PATCH /admin/users/:id`. */
export class UpdateUserDto implements UpdateUserRequest {
  /** New display name. */
  @OmittableNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, DISPLAY_NAME_MAX)
  displayName?: string;

  /** Promote or demote. */
  @OmittableNotNull()
  @IsIn(Object.values(SystemRole))
  systemRole?: SystemRole;

  /** Deactivate or reactivate. */
  @OmittableNotNull()
  @IsBoolean()
  isActive?: boolean;
}

/** Body of `PATCH /me`. */
export class UpdateMeDto implements UpdateMeRequest {
  /** New display name. */
  @OmittableNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, DISPLAY_NAME_MAX)
  displayName?: string;
}

/** Query string of `GET /admin/users`. */
export class ListUsersQueryDto extends PageQueryDto {
  /** Case-insensitive substring match on email or display name. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}
