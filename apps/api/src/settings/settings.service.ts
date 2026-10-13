import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/** Session and lockout settings (SPEC §5), all admin-configurable from M6. */
export interface SecuritySettings {
  /** Sessions idle longer than this are ended. Default 8h. */
  idleTimeoutMinutes: number;
  /** Sessions end this long after login regardless of activity. Default 7d. */
  absoluteTimeoutMinutes: number;
  /** Consecutive failed logins that trigger a lockout. Default 5. */
  lockoutThreshold: number;
  /** How long a locked account stays locked. Default 15 minutes. */
  lockoutMinutes: number;
}

/** Values used until an admin saves different ones. */
export const DEFAULT_SECURITY_SETTINGS: SecuritySettings = {
  idleTimeoutMinutes: 8 * 60,
  absoluteTimeoutMinutes: 7 * 24 * 60,
  lockoutThreshold: 5,
  lockoutMinutes: 15,
};

/** `AppSetting.key` holding {@link SecuritySettings}. */
export const SECURITY_SETTINGS_KEY = 'security';

/**
 * Attachment limits (SPEC §5), admin-configurable from M6. Inline images use
 * the same size limit and count toward the same quota.
 */
export interface StorageSettings {
  /** Largest accepted file, in MB. Default 25. */
  maxFileSizeMb: number;
  /** Total size of a project's attachments and inline images, in MB. Default 2048 (2 GB). */
  projectQuotaMb: number;
}

/** Values used until an admin saves different ones. */
export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  maxFileSizeMb: 25,
  projectQuotaMb: 2048,
};

/** `AppSetting.key` holding {@link StorageSettings}. */
export const STORAGE_SETTINGS_KEY = 'storage';

/**
 * Reads admin-editable settings from the `AppSetting` table, falling back to
 * defaults for anything not yet saved. Editing arrives with the admin screens
 * in M6.
 */
@Injectable()
export class SettingsService {
  /**
   * Receives its collaborators through Nest dependency injection.
   *
   * @param prisma Database access.
   */
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns the effective security settings. Stored values that are missing
   * or not positive integers are replaced by defaults, so a bad row can never
   * disable lockout or make sessions immortal.
   *
   * @returns The merged settings.
   */
  getSecurity(): Promise<SecuritySettings> {
    return this.positiveIntegers(SECURITY_SETTINGS_KEY, DEFAULT_SECURITY_SETTINGS);
  }

  /**
   * Returns the effective attachment limits. Stored values that are missing
   * or not positive integers are replaced by defaults, so a bad row can never
   * lift the limits.
   *
   * @returns The merged settings.
   */
  getStorage(): Promise<StorageSettings> {
    return this.positiveIntegers(STORAGE_SETTINGS_KEY, DEFAULT_STORAGE_SETTINGS);
  }

  /**
   * Reads a settings object whose fields are all positive integers, field by
   * field over the defaults.
   *
   * @param key `AppSetting.key`.
   * @param defaults Default for every field.
   * @returns The merged settings.
   */
  private async positiveIntegers<T extends SecuritySettings | StorageSettings>(
    key: string,
    defaults: T,
  ): Promise<T> {
    const row = await this.prisma.appSetting.findUnique({ where: { key } });
    const stored =
      row !== null &&
      typeof row.value === 'object' &&
      row.value !== null &&
      !Array.isArray(row.value)
        ? (row.value as Record<string, unknown>)
        : {};
    const merged: Record<string, unknown> = { ...defaults };
    for (const name of Object.keys(defaults)) {
      const value = stored[name];
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) merged[name] = value;
    }
    return merged as T;
  }
}
