import type { AuditEntryDto } from '@kloister/shared';
import { toRow } from './admin-audit';

const entry: AuditEntryDto = {
  id: 'a1',
  actorId: 'u1',
  actorEmail: 'pm@example.org',
  actorName: 'Pat',
  action: 'ITEM_UPDATED',
  entityType: 'WorkItem',
  entityId: '11111111-1111-4111-8111-111111111111',
  projectId: 'p1',
  projectKey: 'KLO',
  projectName: 'Kanban',
  entityLabel: 'KLO-4',
  meta: { changes: { status: { from: 'NOT_STARTED', to: 'DONE' } } },
  createdAt: '2026-10-23T10:00:00.000Z',
};

describe('audit rows (M8.5)', () => {
  it('names the action, person, project and item', () => {
    const row = toRow(entry);
    expect(row).toMatchObject({
      action: 'Item changed',
      actor: 'Pat',
      project: 'KLO · Kanban',
      entity: 'KLO-4',
    });
    expect(row.details).toEqual([{ label: 'Changed status', value: 'NOT_STARTED → DONE' }]);
  });

  it('falls back for system entries and deleted entities', () => {
    const row = toRow({
      ...entry,
      actorId: null,
      actorEmail: null,
      actorName: null,
      projectId: null,
      projectKey: null,
      projectName: null,
      entityLabel: null,
      action: 'SOMETHING_NEW',
    });
    expect(row).toMatchObject({ actor: 'System', project: '', action: 'SOMETHING_NEW' });
    expect(row.entity).toBe('WorkItem 11111111… (deleted)');
    const setting = toRow({
      ...entry,
      entityType: 'AppSetting',
      entityId: 'theme',
      entityLabel: null,
    });
    expect(setting.entity).toBe('AppSetting theme');
  });
});
