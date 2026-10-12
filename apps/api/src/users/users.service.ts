import { HttpStatus, Injectable } from '@nestjs/common';
import {
  AuditAction,
  ErrorCode,
  type Page,
  SystemRole,
  type TemporaryPasswordResponse,
  type UserDto,
} from '@kloister/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth-context.js';
import { PasswordService } from '../auth/password.service.js';
import { SessionService } from '../auth/session.service.js';
import { ApiException } from '../common/api-exception.js';
import { pageArgs, toPage } from '../common/pagination.js';
import { isUniqueViolation, mapTransactionConflict } from '../common/prisma-errors.js';
import type { Prisma, User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { normalizeEmail, toUserDto } from './user.mapper.js';
import type { CreateUserDto, ListUsersQueryDto, UpdateMeDto, UpdateUserDto } from './users.dto.js';

/** Outcome of {@link UsersService.bootstrapAdmin}. */
export type BootstrapResult =
  | { created: true; user: UserDto; temporaryPassword: string }
  | { created: false; reason: 'admin_exists' };

/**
 * Account management: admin user administration (SPEC §3.1), the caller's
 * own profile, and the first-admin bootstrap used by install.sh.
 */
@Injectable()
export class UsersService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   * @param passwords Hashing and temporary passwords.
   * @param sessions Session revocation.
   * @param audit Audit log.
   */
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Lists users, newest first.
   *
   * Permissions: admins only (enforced by the controller).
   *
   * @param query Search text and pagination.
   * @returns One page of users.
   */
  async list(query: ListUsersQueryDto): Promise<Page<UserDto>> {
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput =
      q === undefined || q === ''
        ? {}
        : {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { displayName: { contains: q, mode: 'insensitive' } },
            ],
          };
    const rows = await this.prisma.user.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...pageArgs(query),
    });
    return toPage(rows, query, toUserDto);
  }

  /**
   * Fetches one user.
   *
   * Permissions: admins only (enforced by the controller).
   *
   * @param id User id.
   * @returns The user.
   */
  async get(id: string): Promise<UserDto> {
    return toUserDto(await this.findOrThrow(id));
  }

  /**
   * Creates an account with a random temporary password that must be
   * changed at first login (SPEC §5).
   *
   * Permissions: admins only (enforced by the controller).
   *
   * @param actor The admin.
   * @param dto Email, name and optional role.
   * @returns The user and the temporary password, to be shown once.
   */
  async create(actor: AuthContext, dto: CreateUserDto): Promise<TemporaryPasswordResponse> {
    const email = normalizeEmail(dto.email);
    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            displayName: dto.displayName,
            systemRole: dto.systemRole ?? SystemRole.USER,
            passwordHash,
            mustChangePassword: true,
          },
        });
        await this.audit.record(
          {
            actorId: actor.user.id,
            action: AuditAction.USER_CREATED,
            entityType: 'User',
            entityId: created.id,
            meta: { email, systemRole: created.systemRole },
          },
          tx,
        );
        return created;
      });
      return { user: toUserDto(user), temporaryPassword };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          ErrorCode.CONFLICT,
          'A user with this email already exists',
        );
      }
      throw error;
    }
  }

  /**
   * Updates name, system role or active state.
   *
   * Deactivating ends all of the user's sessions. The last active admin can
   * be neither demoted nor deactivated (409 `LAST_ADMIN`), so the system can
   * never be left without an administrator; the check runs in a serializable
   * transaction so two admins demoting each other cannot both succeed (the
   * loser gets 409 `CONFLICT` and may retry).
   *
   * Permissions: admins only (enforced by the controller).
   *
   * @param actor The admin.
   * @param id Target user id.
   * @param dto Fields to change.
   * @returns The updated user.
   */
  async update(actor: AuthContext, id: string, dto: UpdateUserDto): Promise<UserDto> {
    let updated: User;
    try {
      updated = await this.prisma.$transaction(
        async (tx) => {
          const current = await tx.user.findUnique({ where: { id } });
          if (current === null) throw this.notFound();

          const changes: Record<
            string,
            { from: Prisma.InputJsonValue; to: Prisma.InputJsonValue }
          > = {};
          const data: Prisma.UserUpdateInput = {};
          if (dto.displayName !== undefined && dto.displayName !== current.displayName) {
            changes['displayName'] = { from: current.displayName, to: dto.displayName };
            data.displayName = dto.displayName;
          }
          if (dto.systemRole !== undefined && dto.systemRole !== current.systemRole) {
            changes['systemRole'] = { from: current.systemRole, to: dto.systemRole };
            data.systemRole = dto.systemRole;
          }
          if (dto.isActive !== undefined && dto.isActive !== current.isActive) {
            changes['isActive'] = { from: current.isActive, to: dto.isActive };
            data.isActive = dto.isActive;
          }
          if (Object.keys(changes).length === 0) return current;

          const losesAdmin =
            current.systemRole === SystemRole.ADMIN &&
            current.isActive &&
            (data.systemRole === SystemRole.USER || data.isActive === false);
          if (losesAdmin) {
            const otherAdmins = await tx.user.count({
              where: { systemRole: SystemRole.ADMIN, isActive: true, id: { not: id } },
            });
            if (otherAdmins === 0) {
              throw new ApiException(
                HttpStatus.CONFLICT,
                ErrorCode.LAST_ADMIN,
                'The last active administrator cannot be demoted or deactivated',
              );
            }
          }

          const user = await tx.user.update({ where: { id }, data });
          let sessionsEnded = 0;
          if (data.isActive === false) {
            sessionsEnded = await this.sessions.revokeAllForUser(id, undefined, tx);
          }
          await this.audit.record(
            {
              actorId: actor.user.id,
              action: AuditAction.USER_UPDATED,
              entityType: 'User',
              entityId: id,
              meta: { changes, ...(sessionsEnded > 0 ? { sessionsEnded } : {}) },
            },
            tx,
          );
          return user;
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      throw mapTransactionConflict(error);
    }
    return toUserDto(updated);
  }

  /**
   * Issues a new temporary password, forces a change at next login, clears
   * any lockout and ends all of the user's sessions (SPEC §5).
   *
   * Admins cannot reset their own password this way (it would sign them out
   * with a password they must then change); they use change-password.
   *
   * Permissions: admins only (enforced by the controller).
   *
   * @param actor The admin.
   * @param id Target user id.
   * @returns The user and the temporary password, to be shown once.
   */
  async resetPassword(actor: AuthContext, id: string): Promise<TemporaryPasswordResponse> {
    if (id === actor.user.id) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_FAILED,
        'Use change password to change your own password',
      );
    }
    await this.findOrThrow(id);
    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
      });
      const sessionsEnded = await this.sessions.revokeAllForUser(id, undefined, tx);
      await this.audit.record(
        {
          actorId: actor.user.id,
          action: AuditAction.PASSWORD_RESET,
          entityType: 'User',
          entityId: id,
          meta: { sessionsEnded },
        },
        tx,
      );
      return updated;
    });
    return { user: toUserDto(user), temporaryPassword };
  }

  /**
   * Updates the caller's own profile.
   *
   * Permissions: any signed-in user, for themselves only.
   *
   * @param auth The caller.
   * @param dto Fields to change.
   * @returns The updated user.
   */
  async updateMe(auth: AuthContext, dto: UpdateMeDto): Promise<UserDto> {
    if (dto.displayName === undefined || dto.displayName === auth.user.displayName) {
      return toUserDto(auth.user);
    }
    const displayName = dto.displayName;
    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id: auth.user.id }, data: { displayName } });
      await this.audit.record(
        {
          actorId: auth.user.id,
          action: AuditAction.USER_UPDATED,
          entityType: 'User',
          entityId: auth.user.id,
          meta: { changes: { displayName: { from: auth.user.displayName, to: displayName } } },
        },
        tx,
      );
      return updated;
    });
    return toUserDto(user);
  }

  /**
   * Creates the first administrator (SPEC §9.4 step 10). Idempotent: if an
   * active admin already exists nothing changes, so install.sh can be re-run.
   *
   * Permissions: only reachable from the server-side CLI, which requires
   * shell access as the app user; there is no HTTP route for it.
   *
   * @param rawEmail Admin email.
   * @param displayName Admin display name.
   * @returns Whether an admin was created, with the temporary password if so.
   */
  async bootstrapAdmin(rawEmail: string, displayName: string): Promise<BootstrapResult> {
    const email = normalizeEmail(rawEmail);
    const temporaryPassword = this.passwords.generateTemporary();
    const passwordHash = await this.passwords.hash(temporaryPassword);
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const admins = await tx.user.count({
            where: { systemRole: SystemRole.ADMIN, isActive: true },
          });
          if (admins > 0) return { created: false, reason: 'admin_exists' } as const;
          const user = await tx.user.create({
            data: {
              email,
              displayName,
              systemRole: SystemRole.ADMIN,
              passwordHash,
              mustChangePassword: true,
            },
          });
          await this.audit.record(
            {
              actorId: null,
              action: AuditAction.ADMIN_BOOTSTRAPPED,
              entityType: 'User',
              entityId: user.id,
              meta: { email },
            },
            tx,
          );
          return { created: true, user: toUserDto(user), temporaryPassword } as const;
        },
        { isolationLevel: 'Serializable' },
      );
    } catch (error) {
      throw mapTransactionConflict(error);
    }
  }

  /**
   * Loads a user or throws 404.
   *
   * @param id User id.
   * @returns The user row.
   */
  private async findOrThrow(id: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (user === null) throw this.notFound();
    return user;
  }

  /**
   * Builds the standard 404 for a missing user.
   *
   * @returns The exception to throw.
   */
  private notFound(): ApiException {
    return new ApiException(HttpStatus.NOT_FOUND, ErrorCode.NOT_FOUND, 'User not found');
  }
}
