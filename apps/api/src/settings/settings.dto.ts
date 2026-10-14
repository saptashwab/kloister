import {
  APP_NAME_MAX,
  BACKUP_RETENTION_LIMITS,
  BACKUP_TIME_PATTERN,
  type BackupSettingsDto,
  HEX_COLOUR_PATTERN,
  LOG_RETENTION_LIMITS,
  type LogSettingsDto,
  SECURITY_LIMITS,
  type SecuritySettingsDto,
  STORAGE_LIMITS,
  type StorageSettingsDto,
  type ThemeDto,
  ThemeMode,
  UiFont,
  type UpdateBrandingRequest,
} from '@kloister/shared';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsString, Length, Matches, Max, Min } from 'class-validator';
import { trim } from '../common/dto-helpers.js';

/**
 * An integer within an inclusive range.
 *
 * @param limits Lowest and highest value.
 * @param limits.min Lowest value.
 * @param limits.max Highest value.
 * @returns The property decorators.
 */
function IntIn(limits: { min: number; max: number }): PropertyDecorator {
  return (target, key) => {
    IsInt()(target, key);
    Min(limits.min)(target, key);
    Max(limits.max)(target, key);
  };
}

/** Body of `PUT /admin/settings/security`; every field is required. */
export class SecuritySettingsBody implements SecuritySettingsDto {
  /** Idle timeout in minutes. */
  @IntIn(SECURITY_LIMITS.idleTimeoutMinutes)
  idleTimeoutMinutes: number;

  /** Absolute timeout in minutes; at least the idle timeout (checked by the service). */
  @IntIn(SECURITY_LIMITS.absoluteTimeoutMinutes)
  absoluteTimeoutMinutes: number;

  /** Failed sign-ins in a row before a lockout. */
  @IntIn(SECURITY_LIMITS.lockoutThreshold)
  lockoutThreshold: number;

  /** Lockout length in minutes. */
  @IntIn(SECURITY_LIMITS.lockoutMinutes)
  lockoutMinutes: number;
}

/** Body of `PUT /admin/settings/storage`; every field is required. */
export class StorageSettingsBody implements StorageSettingsDto {
  /** Largest file in MB. */
  @IntIn(STORAGE_LIMITS.maxFileSizeMb)
  maxFileSizeMb: number;

  /** Per-project space in MB; at least the file size limit (checked by the service). */
  @IntIn(STORAGE_LIMITS.projectQuotaMb)
  projectQuotaMb: number;
}

/** Body of `PUT /admin/settings/logs`. */
export class LogSettingsBody implements LogSettingsDto {
  /** Days daily log files are kept. */
  @IntIn(LOG_RETENTION_LIMITS)
  retentionDays: number;
}

/** Body of `PUT /admin/backups/settings`; every field is required. */
export class BackupSettingsBody implements BackupSettingsDto {
  /** Whether the daily backup runs. */
  @IsBoolean()
  enabled: boolean;

  /** Server-local time, `HH:MM`. */
  @IsString()
  @Matches(BACKUP_TIME_PATTERN, { message: 'time must be HH:MM, 00:00 to 23:59' })
  time: string;

  /** Days backups are kept. */
  @IntIn(BACKUP_RETENTION_LIMITS)
  retentionDays: number;
}

/**
 * Body of `PUT /admin/settings/theme` (the default theme) and
 * `PUT /me/theme` (a user's own theme).
 */
export class ThemeBody implements ThemeDto {
  /** Light, dark or the operating system's choice. */
  @IsIn(Object.values(ThemeMode))
  mode: ThemeMode;

  /** Primary colour, `#RRGGBB`. */
  @IsString()
  @Matches(HEX_COLOUR_PATTERN, { message: 'primary must be a colour like #4F46E5' })
  primary: string;

  /** Accent colour, `#RRGGBB`. */
  @IsString()
  @Matches(HEX_COLOUR_PATTERN, { message: 'accent must be a colour like #4F46E5' })
  accent: string;
}

/** Body of `PUT /admin/settings/branding`. */
export class BrandingBody implements UpdateBrandingRequest {
  /** App name, shown in the shell and the page title. Control and format characters are refused. */
  @Transform(trim)
  @IsString()
  @Length(1, APP_NAME_MAX)
  @Matches(/^[^\p{Cc}\p{Cf}]+$/u, { message: 'appName must not contain control characters' })
  appName: string;

  /** The UI font; `UPLOADED` needs an uploaded regular file (checked by the service). */
  @IsIn(Object.values(UiFont))
  font: UiFont;
}
