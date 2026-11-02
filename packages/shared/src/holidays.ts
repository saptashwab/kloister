/** Longest holiday name accepted. */
export const HOLIDAY_NAME_MAX = 100;

/** Longest holiday range accepted, in calendar days. */
export const HOLIDAY_MAX_DAYS = 366;

/** A whole-day holiday (SPEC §6.4, docs/M9-PLAN.md §14). */
export interface HolidayDto {
  /** Holiday id. */
  id: string;
  /** Name, e.g. "New Year". */
  name: string;
  /** First day, `YYYY-MM-DD`. */
  startDate: string;
  /** Last day, `YYYY-MM-DD`, inclusive. */
  endDate: string;
  /** An instance-wide holiday from the admin settings, or one of the project. */
  scope: 'INSTANCE' | 'PROJECT';
  /** ISO timestamp of creation. */
  createdAt: string;
  /** ISO timestamp of removal, or null; only removed instance holidays are listed, as changes. */
  deletedAt: string | null;
}

/** Response of `GET /projects/:id/holidays`. */
export interface ProjectHolidaysDto {
  /** The project's calendar: its own holidays plus, when used, the instance ones. */
  holidays: HolidayDto[];
  /** The project uses the instance holidays. */
  useInstanceHolidays: boolean;
  /**
   * Instance holidays added or removed since the project's PMs and Leads last
   * reviewed them (empty when the project does not use them).
   */
  instanceChanges: HolidayDto[];
}

/** Body of `POST /projects/:id/holidays` and `POST /admin/holidays`. */
export interface CreateHolidayRequest {
  /** Name. */
  name: string;
  /** First day, `YYYY-MM-DD`. */
  startDate: string;
  /** Last day, `YYYY-MM-DD`, not before the first. */
  endDate: string;
}

/** Body of `POST /projects/:id/holidays/reviewed`. */
export interface ReviewHolidaysRequest {
  /** The newest instance change the caller saw; later changes stay unreviewed. */
  through?: string;
}
