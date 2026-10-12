/**
 * System-wide roles (SPEC §3.1). Everything else is decided per project.
 */
export const SystemRole = {
  ADMIN: 'ADMIN',
  USER: 'USER',
} as const;

/** One of the {@link SystemRole} values. */
export type SystemRole = (typeof SystemRole)[keyof typeof SystemRole];

/**
 * Header the web app must send on every state-changing request (SPEC §5).
 *
 * Together with `SameSite=Strict` cookies this blocks cross-site request
 * forgery: a cross-origin form cannot set custom headers.
 */
export const CSRF_HEADER = 'x-requested-with';

/** Required value of {@link CSRF_HEADER}. */
export const CSRF_HEADER_VALUE = 'kloister';

/** Minimum password length; no other composition rules apply (SPEC §5). */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * Upper bound on password length. argon2 handles long inputs, but an
 * unbounded body would let a caller burn CPU on hashing.
 */
export const PASSWORD_MAX_LENGTH = 256;

/**
 * A user as the API returns it. The password hash and lockout counters are
 * never exposed.
 */
export interface UserDto {
  /** User id (uuid). */
  id: string;
  /** Login email, always lowercased. */
  email: string;
  /** Name shown in the UI. */
  displayName: string;
  /** System role. */
  systemRole: SystemRole;
  /** True until the user replaces an admin-issued temporary password. */
  mustChangePassword: boolean;
  /** Deactivated users cannot sign in. */
  isActive: boolean;
  /** ISO timestamp of the last successful login, or null. */
  lastLoginAt: string | null;
  /** ISO timestamp of account creation. */
  createdAt: string;
}

/** Body of `POST /auth/login`. */
export interface LoginRequest {
  /** Login email (case-insensitive). */
  email: string;
  /** Plain-text password. */
  password: string;
}

/** Body of `POST /auth/change-password`. */
export interface ChangePasswordRequest {
  /** The password the user signed in with (possibly a temporary one). */
  currentPassword: string;
  /** The replacement, at least {@link PASSWORD_MIN_LENGTH} characters. */
  newPassword: string;
}

/** Body of `PATCH /me`. */
export interface UpdateMeRequest {
  /** New display name. */
  displayName?: string;
}

/** Body of `POST /admin/users`. */
export interface CreateUserRequest {
  /** Login email; must be unique (case-insensitive). */
  email: string;
  /** Name shown in the UI. */
  displayName: string;
  /** Defaults to `USER`. */
  systemRole?: SystemRole;
}

/**
 * Response of `POST /admin/users` and `POST /admin/users/:id/reset-password`.
 *
 * The temporary password is shown once and is not stored anywhere in plain text.
 */
export interface TemporaryPasswordResponse {
  /** The affected user. */
  user: UserDto;
  /** Random password the user must change at next login. */
  temporaryPassword: string;
}

/** Body of `PATCH /admin/users/:id`. Omitted fields are left unchanged. */
export interface UpdateUserRequest {
  /** New display name. */
  displayName?: string;
  /** Promote to or demote from admin. */
  systemRole?: SystemRole;
  /** Deactivate (false) or reactivate (true) the account. */
  isActive?: boolean;
}
