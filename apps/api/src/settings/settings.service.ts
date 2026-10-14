import { Injectable } from '@nestjs/common';
import {
  APP_NAME_MAX,
  BACKUP_TIME_PATTERN,
  type BackupSettingsDto,
  DEFAULT_APP_NAME,
  DEFAULT_THEME,
  HEX_COLOUR_PATTERN,
  type LogSettingsDto,
  type SecuritySettingsDto,
  type StorageSettingsDto,
  type ThemeDto,
  ThemeMode,
  UiFont,
} from '@kloister/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Session and lockout settings (SPEC §5), admin-configurable. */
export type SecuritySettings = SecuritySettingsDto;

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
 * Attachment limits (SPEC §5), admin-configurable. Inline images use the
 * same size limit and count toward the same quota.
 */
export type StorageSettings = StorageSettingsDto;

/** Values used until an admin saves different ones. */
export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
  maxFileSizeMb: 25,
  projectQuotaMb: 2048,
};

/** `AppSetting.key` holding {@link StorageSettings}. */
export const STORAGE_SETTINGS_KEY = 'storage';

/** Log retention used until an admin saves a different one. */
export const DEFAULT_LOG_SETTINGS: LogSettingsDto = { retentionDays: 30 };

/** `AppSetting.key` holding {@link LogSettingsDto}. */
export const LOG_SETTINGS_KEY = 'logs';

/**
 * Backup schedule used until an admin saves a different one: on, nightly
 * at 02:00 server time, two weeks kept.
 */
export const DEFAULT_BACKUP_SETTINGS: BackupSettingsDto = {
  enabled: true,
  time: '02:00',
  retentionDays: 14,
};

/** `AppSetting.key` holding {@link BackupSettingsDto}. */
export const BACKUP_SETTINGS_KEY = 'backups';

/** `AppSetting.key` holding the admin's default {@link ThemeDto}. */
export const THEME_SETTINGS_KEY = 'theme';

/** App name and UI font chosen by an admin. */
export interface BrandingRecord {
  /** App name. */
  appName: string;
  /** The chosen font; `UPLOADED` falls back to Figtree without a regular file. */
  font: UiFont;
}

/** Branding used until an admin saves different values. */
export const DEFAULT_BRANDING: BrandingRecord = { appName: DEFAULT_APP_NAME, font: UiFont.FIGTREE };

/** `AppSetting.key` holding {@link BrandingRecord}. */
export const BRANDING_SETTINGS_KEY = 'branding';

/** One uploaded branding file, as recorded in the database. */
export interface StoredBrandingFile {
  /** Random file name in the branding folder (a uuid), never user input. */
  storedName: string;
  /** Name as uploaded, cleaned, for display only. */
  name: string;
  /** Type detected from the content. */
  type: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** Hex SHA-256 of the content; its prefix versions the public URL. */
  sha256: string;
  /** ISO timestamp of the upload. */
  uploadedAt: string;
}

/** The uploaded logo and font files. */
export interface BrandingFiles {
  /** The logo. */
  logo: StoredBrandingFile | null;
  /** The regular font file. */
  fontRegular: StoredBrandingFile | null;
  /** The optional bold font file. */
  fontBold: StoredBrandingFile | null;
}

/** `AppSetting.key` holding {@link BrandingFiles}. */
export const BRANDING_FILES_KEY = 'brandingFiles';

/** A Prisma client or an interactive transaction client. */
type Db = Prisma.TransactionClient | PrismaService;

/** A stored value as a plain object, or an empty one. */
type Fields = Record<string, unknown>;

/**
 * Checks a positive integer.
 *
 * @param value Anything.
 * @returns True for integers above zero.
 */
function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Checks a `#RRGGBB` colour.
 *
 * @param value Anything.
 * @returns True for a hex colour.
 */
function isHexColour(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOUR_PATTERN.test(value);
}

/**
 * Reads a stored theme, field by field over the defaults.
 *
 * @param stored The stored object.
 * @param defaults Value of every field that is missing or invalid.
 * @returns The theme, colours upper case.
 */
export function parseTheme(stored: Fields, defaults: ThemeDto = DEFAULT_THEME): ThemeDto {
  const mode = Object.values(ThemeMode).find((m) => m === stored['mode']) ?? defaults.mode;
  const primary = isHexColour(stored['primary']) ? stored['primary'] : defaults.primary;
  const accent = isHexColour(stored['accent']) ? stored['accent'] : defaults.accent;
  return { mode, primary: primary.toUpperCase(), accent: accent.toUpperCase() };
}

/**
 * Reads one recorded branding file. Records whose stored name is not a uuid
 * are ignored, so a bad row can never point the app at another path.
 *
 * @param value The stored value.
 * @returns The file, or null.
 */
function parseFile(value: unknown): StoredBrandingFile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const f = value as Fields;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    typeof f['storedName'] !== 'string' ||
    !uuid.test(f['storedName']) ||
    typeof f['name'] !== 'string' ||
    typeof f['type'] !== 'string' ||
    !isPositiveInteger(f['sizeBytes']) ||
    typeof f['sha256'] !== 'string' ||
    !/^[0-9a-f]{64}$/.test(f['sha256']) ||
    typeof f['uploadedAt'] !== 'string'
  ) {
    return null;
  }
  return {
    storedName: f['storedName'],
    name: f['name'],
    type: f['type'],
    sizeBytes: f['sizeBytes'],
    sha256: f['sha256'],
    uploadedAt: f['uploadedAt'],
  };
}

/**
 * Reads and writes admin-editable settings in the `AppSetting` table,
 * falling back to defaults for anything not yet saved or invalid. Stored
 * values are checked field by field, so a bad row can never disable
 * lockout, lift a limit or break the app's look.
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
   * or not positive integers are replaced by defaults.
   *
   * @param db Database client, e.g. a transaction.
   * @returns The merged settings.
   */
  getSecurity(db: Db = this.prisma): Promise<SecuritySettings> {
    return this.positiveIntegers(SECURITY_SETTINGS_KEY, DEFAULT_SECURITY_SETTINGS, db);
  }

  /**
   * Returns the effective attachment limits. Stored values that are missing
   * or not positive integers are replaced by defaults.
   *
   * @param db Database client, e.g. a transaction.
   * @returns The merged settings.
   */
  getStorage(db: Db = this.prisma): Promise<StorageSettings> {
    return this.positiveIntegers(STORAGE_SETTINGS_KEY, DEFAULT_STORAGE_SETTINGS, db);
  }

  /**
   * Returns the effective log retention.
   *
   * @returns The merged settings.
   */
  getLogs(): Promise<LogSettingsDto> {
    return this.positiveIntegers(LOG_SETTINGS_KEY, DEFAULT_LOG_SETTINGS, this.prisma);
  }

  /**
   * Returns the effective backup schedule.
   *
   * @returns The merged settings.
   */
  async getBackups(): Promise<BackupSettingsDto> {
    const stored = await this.read(BACKUP_SETTINGS_KEY, this.prisma);
    const d = DEFAULT_BACKUP_SETTINGS;
    return {
      enabled: typeof stored['enabled'] === 'boolean' ? stored['enabled'] : d.enabled,
      time:
        typeof stored['time'] === 'string' && BACKUP_TIME_PATTERN.test(stored['time'])
          ? stored['time']
          : d.time,
      retentionDays: isPositiveInteger(stored['retentionDays'])
        ? stored['retentionDays']
        : d.retentionDays,
    };
  }

  /**
   * Returns the admin's default theme, or the built-in one.
   *
   * @returns The theme.
   */
  async getTheme(): Promise<ThemeDto> {
    return parseTheme(await this.read(THEME_SETTINGS_KEY, this.prisma));
  }

  /**
   * Returns the app name and chosen font.
   *
   * @param db Database client, e.g. a transaction.
   * @returns The branding.
   */
  async getBranding(db: Db = this.prisma): Promise<BrandingRecord> {
    const stored = await this.read(BRANDING_SETTINGS_KEY, db);
    const name = typeof stored['appName'] === 'string' ? stored['appName'].trim() : '';
    const font = Object.values(UiFont).find((f) => f === stored['font']);
    return {
      appName: name === '' || name.length > APP_NAME_MAX ? DEFAULT_BRANDING.appName : name,
      font: font ?? DEFAULT_BRANDING.font,
    };
  }

  /**
   * Returns the records of the uploaded logo and font files.
   *
   * @param db Database client, e.g. a transaction.
   * @returns The files; null where none is recorded.
   */
  async getBrandingFiles(db: Db = this.prisma): Promise<BrandingFiles> {
    const stored = await this.read(BRANDING_FILES_KEY, db);
    return {
      logo: parseFile(stored['logo']),
      fontRegular: parseFile(stored['fontRegular']),
      fontBold: parseFile(stored['fontBold']),
    };
  }

  /**
   * Stores a settings value, replacing the previous one. Callers validate
   * the value and write the audit entry.
   *
   * @param key `AppSetting.key`.
   * @param value The new value.
   * @param db Database client; pass a transaction to write atomically.
   * @returns Resolves once stored.
   */
  async save(key: string, value: Prisma.InputJsonObject, db: Db = this.prisma): Promise<void> {
    await db.appSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    });
  }

  /**
   * Reads a stored settings object.
   *
   * @param key `AppSetting.key`.
   * @param db Database client.
   * @returns Its fields, or an empty object when missing or not an object.
   */
  private async read(key: string, db: Db): Promise<Fields> {
    const row = await db.appSetting.findUnique({ where: { key } });
    return row !== null &&
      typeof row.value === 'object' &&
      row.value !== null &&
      !Array.isArray(row.value)
      ? row.value
      : {};
  }

  /**
   * Reads a settings object whose fields are all positive integers, field by
   * field over the defaults.
   *
   * @param key `AppSetting.key`.
   * @param defaults Default for every field.
   * @param db Database client.
   * @returns The merged settings.
   */
  private async positiveIntegers<T extends object>(key: string, defaults: T, db: Db): Promise<T> {
    const stored = await this.read(key, db);
    const merged: Fields = { ...(defaults as Fields) };
    for (const name of Object.keys(defaults)) {
      const value = stored[name];
      if (isPositiveInteger(value)) merged[name] = value;
    }
    return merged as T;
  }
}
