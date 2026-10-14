import { HEX_COLOUR_PATTERN, type ThemeDto, ThemeMode, type UserDto } from '@kloister/shared';
import type { User } from '../generated/prisma/client.js';

/**
 * Converts a user row to its API representation, dropping the password hash,
 * lockout counters and anything else clients must not see.
 *
 * @param user Database row.
 * @returns The public DTO.
 */
export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    systemRole: user.systemRole,
    mustChangePassword: user.mustChangePassword,
    isActive: user.isActive,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

/**
 * Normalises an email for storage and lookup (SPEC §4: unique, lowercased).
 *
 * @param email Raw input.
 * @returns Trimmed, lowercased email.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Reads a user's own theme from `User.themePrefs` (SPEC §4). Only a complete,
 * valid theme counts; anything else (including the empty object) means
 * "use default".
 *
 * @param prefs The stored JSON.
 * @returns The theme, colours upper case, or null.
 */
export function userTheme(prefs: unknown): ThemeDto | null {
  if (typeof prefs !== 'object' || prefs === null || Array.isArray(prefs)) return null;
  const { mode, primary, accent } = prefs as Record<string, unknown>;
  const modes: unknown[] = Object.values(ThemeMode);
  if (
    !modes.includes(mode) ||
    typeof primary !== 'string' ||
    !HEX_COLOUR_PATTERN.test(primary) ||
    typeof accent !== 'string' ||
    !HEX_COLOUR_PATTERN.test(accent)
  ) {
    return null;
  }
  return {
    mode: mode as ThemeMode,
    primary: primary.toUpperCase(),
    accent: accent.toUpperCase(),
  };
}
