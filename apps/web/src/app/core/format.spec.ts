import { formatMinutes, formatSize } from './format';

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
