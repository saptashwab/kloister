import { TestBed } from '@angular/core/testing';
import { Today, untilNextMinute } from './today';

describe('Today (v1.4.0)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits until just after the next whole minute', () => {
    expect(untilNextMinute(0)).toBe(60_050);
    expect(untilNextMinute(59_990)).toBe(60);
  });

  it('moves to the next day at midnight and updates the minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 3, 23, 58, 30));
    const today = TestBed.inject(Today);
    expect(today.date()).toBe('2026-11-03');
    expect(today.minutes()).toBe(23 * 60 + 58);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(today.minutes()).toBe(23 * 60 + 59);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(today.date()).toBe('2026-11-04');
    expect(today.minutes()).toBe(0);
  });

  it('reads the clock again when the tab is shown', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 3, 9, 0, 0));
    const today = TestBed.inject(Today);
    vi.setSystemTime(new Date(2026, 10, 5, 8, 0, 0));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(today.date()).toBe('2026-11-05');
  });

  it('stops ticking with the application', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 3, 9, 0, 0));
    const today = TestBed.inject(Today);
    TestBed.resetTestingModule();
    vi.setSystemTime(new Date(2026, 10, 3, 9, 5, 0));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(today.minutes()).toBe(9 * 60);
  });
});
