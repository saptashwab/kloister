import {
  type CreateTeamRequest,
  type SetTeamMemberRequest,
  TEAM_DESCRIPTION_MAX,
  TEAM_NAME_MAX,
  TeamRole,
  type UpdateTeamRequest,
} from '@kloister/shared';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length, MaxLength, ValidateIf } from 'class-validator';

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

/** Body of `POST /projects/:id/teams`. */
export class CreateTeamDto implements CreateTeamRequest {
  /** Name, unique within the project. */
  @Transform(trim)
  @IsString()
  @Length(1, TEAM_NAME_MAX)
  name: string;

  /** Optional description. */
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(TEAM_DESCRIPTION_MAX)
  description?: string;
}

/** Body of `PATCH /projects/:id/teams/:teamId`. */
export class UpdateTeamDto implements UpdateTeamRequest {
  /** New name. */
  @OmittableNotNull()
  @Transform(trim)
  @IsString()
  @Length(1, TEAM_NAME_MAX)
  name?: string;

  /** New description. */
  @OmittableNotNull()
  @Transform(trim)
  @IsString()
  @MaxLength(TEAM_DESCRIPTION_MAX)
  description?: string;
}

/** Body of `PUT /projects/:id/teams/:teamId/members/:userId`. */
export class SetTeamMemberDto implements SetTeamMemberRequest {
  /** Role in the team. */
  @IsIn(Object.values(TeamRole))
  role: TeamRole;
}
