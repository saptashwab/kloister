import {
  type ChangePasswordRequest,
  type LoginRequest,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@kloister/shared';
import { IsString, Length, MaxLength } from 'class-validator';

/** Body of `POST /auth/login`. */
export class LoginDto implements LoginRequest {
  /** Not checked as an email here: any mismatch is just a failed login. */
  @IsString()
  @MaxLength(254)
  email: string;

  /** No minimum on login, so old or temporary passwords still work. */
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  password: string;
}

/** Body of `POST /auth/change-password`. */
export class ChangePasswordDto implements ChangePasswordRequest {
  /** The password the user currently has. */
  @IsString()
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword: string;

  /** At least 12 characters; no composition rules (SPEC §5). */
  @IsString()
  @Length(PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH)
  newPassword: string;
}
