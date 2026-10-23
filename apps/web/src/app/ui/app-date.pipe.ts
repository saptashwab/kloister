import { Pipe, type PipeTransform } from '@angular/core';
import { formatDay, formatMoment } from '../core/format';

/**
 * Shows dates and moments in the app's one format (DESIGN §15, M8.5):
 * `day` gives "23 Oct 2026", `moment` (default) "23 Oct 2026, 14:05" in the
 * viewer's time zone. Empty input gives empty text.
 */
@Pipe({ name: 'appDate' })
export class AppDatePipe implements PipeTransform {
  /**
   * Formats one value.
   *
   * @param value ISO timestamp, `YYYY-MM-DD`, Date, or nothing.
   * @param kind `day` or `moment`.
   * @returns The text.
   */
  transform(value: string | Date | null | undefined, kind: 'day' | 'moment' = 'moment'): string {
    if (value === null || value === undefined || value === '') return '';
    return kind === 'day' ? formatDay(value) : formatMoment(value);
  }
}
