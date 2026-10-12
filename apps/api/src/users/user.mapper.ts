import type { UserDto } from '@kloister/shared';
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
