import { API_PREFIX } from './api.js';

/**
 * Light or dark mode (SPEC §6). `SYSTEM` follows the operating system's
 * preference.
 */
export const ThemeMode = {
  SYSTEM: 'SYSTEM',
  LIGHT: 'LIGHT',
  DARK: 'DARK',
} as const;

/** One of the {@link ThemeMode} values. */
export type ThemeMode = (typeof ThemeMode)[keyof typeof ThemeMode];

/** A colour as `#RRGGBB`. */
export const HEX_COLOUR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

/**
 * A theme: mode plus primary and accent colour (SPEC §6). The web app derives
 * the soft, line and ink variants of both colours and adjusts them until text
 * on them reaches WCAG AA contrast (docs/DESIGN.md §2.1); the stored colours
 * stay as chosen.
 */
export interface ThemeDto {
  /** Light, dark, or the operating system's choice. */
  mode: ThemeMode;
  /** Primary colour, `#RRGGBB`. */
  primary: string;
  /** Accent colour (unread badge, active sprint), `#RRGGBB`. */
  accent: string;
}

/** The built-in theme, used until an admin saves a default (docs/DESIGN.md §2.1). */
export const DEFAULT_THEME: ThemeDto = {
  mode: ThemeMode.SYSTEM,
  primary: '#4F46E5',
  accent: '#4F46E5',
};

/**
 * Response of `GET /me/theme`: the caller's own theme, or null when they use
 * the admin default.
 */
export interface MyThemeDto {
  /** The caller's theme, or null for "use default". */
  theme: ThemeDto | null;
}

/**
 * The UI font (SPEC §6, docs/DESIGN.md §6): a bundled or installed preset,
 * or the font file an admin uploaded. One font for everyone.
 */
export const UiFont = {
  FIGTREE: 'FIGTREE',
  ATKINSON_HYPERLEGIBLE: 'ATKINSON_HYPERLEGIBLE',
  IBM_PLEX_SANS: 'IBM_PLEX_SANS',
  GEORGIA: 'GEORGIA',
  ARIAL: 'ARIAL',
  UPLOADED: 'UPLOADED',
} as const;

/** One of the {@link UiFont} values. */
export type UiFont = (typeof UiFont)[keyof typeof UiFont];

/** App name shown until an admin sets one. */
export const DEFAULT_APP_NAME = 'Kloister';

/** Longest app name accepted. */
export const APP_NAME_MAX = 60;

/** Largest logo accepted, in bytes (1 MB). */
export const LOGO_MAX_BYTES = 1024 * 1024;

/** Largest font file accepted, in bytes (10 MB). */
export const FONT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Font file types accepted for an uploaded UI font, checked by content
 * (docs/DESIGN.md §6): WOFF2 (recommended), WOFF, TrueType and OpenType.
 */
export const FONT_TYPES = ['font/woff2', 'font/woff', 'font/ttf', 'font/otf'] as const;

/** One of the {@link FONT_TYPES}. */
export type FontType = (typeof FONT_TYPES)[number];

/** The two files of an uploaded font. */
export const FontWeight = {
  REGULAR: 'regular',
  BOLD: 'bold',
} as const;

/** One of the {@link FontWeight} values. */
export type FontWeight = (typeof FontWeight)[keyof typeof FontWeight];

/**
 * What every visitor needs to draw the app, from the public
 * `GET /branding`: the login page shows it before anyone signs in, so it
 * holds nothing beyond the name, the logo and font locations and the default
 * theme.
 */
export interface PublicBrandingDto {
  /** App name for the shell and the page title. */
  appName: string;
  /** App-relative URL of the logo (changes with each upload), or null. */
  logoUrl: string | null;
  /**
   * The UI font in use. `UPLOADED` only when the uploaded regular file
   * exists; otherwise the chosen preset, or Figtree.
   */
  font: UiFont;
  /** App-relative URLs of the uploaded font files, when `font` is `UPLOADED`. */
  fontFiles: { regular: string; bold: string | null } | null;
  /** The admin's default theme. */
  theme: ThemeDto;
}

/** A stored branding file, as admins see it. */
export interface BrandingFileDto {
  /** Name of the file as uploaded. */
  name: string;
  /** Type detected from its content. */
  type: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** ISO timestamp of the upload. */
  uploadedAt: string;
}

/** Response of `GET /admin/settings/branding`. */
export interface BrandingSettingsDto {
  /** App name; the default when never set. */
  appName: string;
  /** The chosen font (`UPLOADED` may be chosen only with a regular file). */
  font: UiFont;
  /** The logo, or null. */
  logo: BrandingFileDto | null;
  /** The uploaded font files. */
  fontFiles: { regular: BrandingFileDto | null; bold: BrandingFileDto | null };
}

/** Body of `PUT /admin/settings/branding`. */
export interface UpdateBrandingRequest {
  /** App name, 1 to {@link APP_NAME_MAX} characters. */
  appName: string;
  /** UI font. */
  font: UiFont;
}

/**
 * URL of a public branding file. The version (a prefix of the file's
 * SHA-256) changes with every upload, so browsers never show a stale file.
 *
 * @param file `logo`, or `fonts/regular` / `fonts/bold`.
 * @param version Content version.
 * @returns E.g. `api/v1/branding/logo?v=1a2b3c4d`.
 */
export function brandingFileUrl(file: string, version: string): string {
  return `${API_PREFIX}/branding/${file}?v=${version}`;
}

/** Session and lockout settings (SPEC §5), `GET`/`PUT /admin/settings/security`. */
export interface SecuritySettingsDto {
  /** Sessions idle longer than this end. Default 480 (8 hours). */
  idleTimeoutMinutes: number;
  /** Sessions end this long after sign-in. Default 10080 (7 days). */
  absoluteTimeoutMinutes: number;
  /** Failed sign-ins in a row that lock an account. Default 5. */
  lockoutThreshold: number;
  /** How long a locked account stays locked. Default 15. */
  lockoutMinutes: number;
}

/** Accepted ranges of {@link SecuritySettingsDto}, inclusive. */
export const SECURITY_LIMITS = {
  idleTimeoutMinutes: { min: 5, max: 43_200 },
  absoluteTimeoutMinutes: { min: 5, max: 525_600 },
  lockoutThreshold: { min: 1, max: 100 },
  lockoutMinutes: { min: 1, max: 1_440 },
} as const;

/** Attachment limits (SPEC §5), `GET`/`PUT /admin/settings/storage`. */
export interface StorageSettingsDto {
  /** Largest file accepted, in MB. Default 25. */
  maxFileSizeMb: number;
  /** Space per project for attachments and inline images, in MB. Default 2048. */
  projectQuotaMb: number;
}

/** Accepted ranges of {@link StorageSettingsDto}, inclusive. */
export const STORAGE_LIMITS = {
  maxFileSizeMb: { min: 1, max: 1_024 },
  projectQuotaMb: { min: 1, max: 1_048_576 },
} as const;

/** Space used by one folder. */
export interface FolderUsageDto {
  /** The folder on the server. */
  path: string;
  /** Total size of its files, in bytes. */
  bytes: number;
  /** Number of files. */
  files: number;
}

/** Response of `GET /admin/settings/storage/usage` (SPEC §6 storage). */
export interface DiskUsageDto {
  /** The app's folder (`/app/<app_name>`), everything below it included. */
  app: FolderUsageDto;
  /** Attachments and inline images. */
  attachments: FolderUsageDto;
  /** Database backups. */
  backups: FolderUsageDto;
  /** Backend and backup logs. */
  logs: FolderUsageDto;
  /** The file system holding the app's folder, or null when unknown. */
  disk: { totalBytes: number; freeBytes: number } | null;
  /** ISO timestamp of the measurement. */
  measuredAt: string;
}

/** Log retention (SPEC §6 logs), `GET`/`PUT /admin/settings/logs`. */
export interface LogSettingsDto {
  /** Daily log files older than this many days are deleted. Default 30. */
  retentionDays: number;
}

/** Accepted range of {@link LogSettingsDto.retentionDays}, inclusive. */
export const LOG_RETENTION_LIMITS = { min: 1, max: 3_650 } as const;

/** Backup schedule (SPEC §6 backups), `PUT /admin/backups/settings`. */
export interface BackupSettingsDto {
  /** Whether the daily backup runs. Default true. */
  enabled: boolean;
  /** Server-local time of the daily backup, `HH:MM`. Default `02:00`. */
  time: string;
  /** Backups older than this many days are deleted after a successful backup. Default 14. */
  retentionDays: number;
}

/** `HH:MM`, 00:00 to 23:59. */
export const BACKUP_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Accepted range of {@link BackupSettingsDto.retentionDays}, inclusive. */
export const BACKUP_RETENTION_LIMITS = { min: 1, max: 3_650 } as const;

/** What started a backup. */
export const BackupTrigger = {
  SCHEDULED: 'SCHEDULED',
  MANUAL: 'MANUAL',
} as const;

/** One of the {@link BackupTrigger} values. */
export type BackupTrigger = (typeof BackupTrigger)[keyof typeof BackupTrigger];

/** One finished backup, from the audit log. */
export interface BackupRunDto {
  /** Audit entry id. */
  id: string;
  /** Daily schedule or "run now". */
  trigger: BackupTrigger;
  /** Whether pg_dump succeeded. */
  succeeded: boolean;
  /** ISO timestamp the run started. */
  startedAt: string;
  /** ISO timestamp the run ended. */
  finishedAt: string;
  /** Backup file name, when it succeeded. */
  file: string | null;
  /** Backup size in bytes, when it succeeded. */
  sizeBytes: number | null;
  /** Why it failed, when it failed. */
  error: string | null;
  /** Old backups deleted afterwards under the retention setting. */
  pruned: number;
}

/** A backup file in the backups folder. */
export interface BackupFileDto {
  /** File name, `<app_name>-<yyyymmdd-hhmmss>.dump`. */
  name: string;
  /** Size in bytes. */
  sizeBytes: number;
  /** ISO timestamp of its last change. */
  modifiedAt: string;
}

/** Response of `GET /admin/backups`. */
export interface BackupsDto {
  /** The schedule. */
  settings: BackupSettingsDto;
  /** True while a backup is running. */
  running: boolean;
  /** ISO timestamp of the next scheduled run, or null when disabled. */
  nextRunAt: string | null;
  /** The latest runs, newest first. */
  runs: BackupRunDto[];
  /** Backup files on the server, newest first. */
  files: BackupFileDto[];
  /** The backups folder on the server. */
  folder: string;
}
