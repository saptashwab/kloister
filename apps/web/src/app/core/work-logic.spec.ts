import type { WorkSummaryDto } from '@kloister/shared';
import { filterWork, groupWork, workDueGroup, type WorkFilter } from './work-logic';

const base: WorkSummaryDto = {
  id: 'a',
  number: 1,
  key: 'KLO-1',
  projectId: 'p1',
  projectKey: 'KLO',
  projectName: 'Project',
  personal: false,
  title: 'Task',
  type: 'TASK',
  status: 'NOT_STARTED',
  priority: 2,
  dueDate: null,
  dueTime: null,
  labels: [{ id: 'l1', name: 'Same name', colour: '#123456' }],
  labelStyle: 'SOLID',
  bucket: { id: 'b1', name: 'Same bucket' },
  canEdit: true,
};
const filter: WorkFilter = { source: 'ALL', projectId: '', type: '', labelId: '', due: '' };
describe('work grouping and filters', () => {
  it('separates Today from the remaining Monday–Sunday week and never marks Done overdue', () => {
    for (const [date, group] of [
      ['2026-10-11', 'Overdue'],
      ['2026-10-12', 'Today'],
      ['2026-10-18', 'This week'],
      ['2026-10-19', 'Later'],
      [null, 'No date'],
    ] as const)
      expect(workDueGroup({ ...base, dueDate: date }, '2026-10-12')).toBe(group);
    expect(workDueGroup({ ...base, status: 'DONE', dueDate: '2026-10-11' }, '2026-10-12')).toBe(
      'Later',
    );
    expect(workDueGroup({ ...base, dueDate: '2026-10-19' }, '2026-10-18')).toBe('Later');
  });
  it('keeps projects, personal sources and label identities distinct when their names match', () => {
    const personal = {
      ...base,
      id: 'b',
      projectId: 'p2',
      projectKey: null,
      projectName: 'Personal',
      personal: true,
      key: '#1',
      labels: [{ id: 'l2', name: 'Same name', colour: '#123456' }],
    };
    const items = [base, personal];
    expect(filterWork(items, { ...filter, source: 'PERSONAL' }, '2026-10-12')).toEqual([personal]);
    expect(filterWork(items, { ...filter, source: 'PROJECTS' }, '2026-10-12')).toEqual([base]);
    expect(filterWork(items, { ...filter, labelId: 'l2' }, '2026-10-12')).toEqual([personal]);
    expect(filterWork(items, { ...filter, projectId: 'p1', type: 'BUG' }, '2026-10-12')).toEqual(
      [],
    );
    expect(groupWork(items, true, '2026-10-12').map((g) => g.id)).toEqual(['p2', 'p1']);
    expect(groupWork(items, false, '2026-10-12')[0]?.name).toBe('No date');
  });
});
