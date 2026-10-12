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
  async getSecurity(): Promise<SecuritySettings> {
    const row = await this.prisma.appSetting.findUnique({ where: { key: SECURITY_SETTINGS_KEY } });
    const stored =
      row !== null &&
      typeof row.value === 'object' &&
      row.value !== null &&
      !Array.isArray(row.value)
        ? (row.value as Record<string, unknown>)
        : {};
    const pick = (name: keyof SecuritySettings): number => {
      const value = stored[name];
      return typeof value === 'number' && Number.isInteger(value) && value > 0
        ? value
        : DEFAULT_SECURITY_SETTINGS[name];
    };
    return {
      idleTimeoutMinutes: pick('idleTimeoutMinutes'),
      absoluteTimeoutMinutes: pick('absoluteTimeoutMinutes'),
      lockoutThreshold: pick('lockoutThreshold'),
      lockoutMinutes: pick('lockoutMinutes'),
    };
  }
}
