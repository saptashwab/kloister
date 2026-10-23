import {
  dayOf,
  formatDay,
  formatMinutes,
  formatMoment,
  formatSize,
  parseDay,
  parseTime,
} from './format';

describe('formatSize', () => {
  it('uses bytes, KB, MB and GB', () => {
    expect(formatSize(1)).toBe('1 byte');
    expect(formatSize(820)).toBe('820 bytes');
    expect(formatSize(14540)).toBe('14.2 KB');
    expect(formatSize(3.1 * 1024 * 1024)).toBe('3.1 MB');
    expect(formatSize(12.4 * 1024 * 1024 * 1024)).toBe('12.4 GB');
  });
});

describe('formatMinutes', () => {
  it('names durations in days, hours and minutes', () => {
    expect(formatMinutes(1)).toBe('1 minute');
    expect(formatMinutes(45)).toBe('45 minutes');
    expect(formatMinutes(480)).toBe('8 hours');
    expect(formatMinutes(10_080)).toBe('7 days');
    expect(formatMinutes(2_190)).toBe('1 day 12 hours 30 minutes');
    expect(formatMinutes(Number.NaN)).toBe('0 minutes');
  });
});

describe('app dates (M8.5)', () => {
  it('shows dates and moments in one unambiguous format', () => {
    expect(formatDay('2026-10-23')).toBe('23 Oct 2026');
    expect(formatDay(new Date(2026, 0, 5))).toBe('5 Jan 2026');
    expect(formatMoment(new Date(2026, 9, 23, 14, 5))).toBe('23 Oct 2026, 14:05');
    expect(formatMoment('not a date')).toBe('');
  });

  it('reads typed dates and times and rejects impossible ones', () => {
    expect(parseDay('2026-10-23')).toBe('2026-10-23');
    expect(parseDay(' 23 Oct 2026 ')).toBe('2026-10-23');
    expect(parseDay('3 october 2026')).toBe('2026-10-03');
    expect(parseDay('30 Feb 2026')).toBeNull();
    expect(parseDay('23 Octopus 2026')).toBeNull();
    expect(parseDay('1 Sept 2026')).toBeNull();
    expect(parseDay('23/10/2026')).toBeNull();
    expect(parseTime('9:30')).toBe('09:30');
    expect(parseTime('17:00')).toBe('17:00');
    expect(parseTime('24:00')).toBeNull();
    expect(parseTime('5pm')).toBeNull();
    expect(dayOf(new Date(2026, 9, 3))).toBe('2026-10-03');
  });
});
