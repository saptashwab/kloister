import { burndownChart, statusBars } from './report-charts';

describe('report charts (M13)', () => {
  it('scales status bars to the largest count', () => {
    const bars = statusBars([
      { status: 'NOT_STARTED', label: 'Not started', value: 4 },
      { status: 'DONE', label: 'Done', value: 2 },
      { status: 'BLOCKED', label: 'Blocked', value: 0 },
    ]);
    expect(bars.map((b) => [b.width, b.tone])).toEqual([
      [100, 'not_started'],
      [50, 'done'],
      [0, 'blocked'],
    ]);
  });

  it('draws the burndown up to today against the ideal line', () => {
    const chart = burndownChart([
      { date: '2026-11-02', remaining: 4, ideal: 4 },
      { date: '2026-11-03', remaining: 3, ideal: 2 },
      { date: '2026-11-04', remaining: null, ideal: 0 },
    ])!;
    expect(chart.max).toBe(4);
    expect(chart.dots).toHaveLength(2);
    expect(chart.ideal.split(' ')).toHaveLength(3);
    expect(chart.dots[0]).toEqual({ x: 0, y: 16 });
    expect(chart.ideal.split(' ')[2]).toBe('600,200');
    expect(burndownChart([])).toBeNull();
  });
});
