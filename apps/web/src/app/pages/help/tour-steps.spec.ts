import { makeProject } from '../../../testing/fixtures';
import { HELP_ARTICLES } from './help-content';
import { tourSteps } from './tour-steps';

describe('capability-composed introduction', () => {
  it('handles no memberships without creating a personal space or linking unavailable projects', () => {
    const steps = tourSteps(null, false);
    expect(steps.some((step) => step.text.includes('no selected project'))).toBe(true);
    expect(steps.flatMap((step) => step.route ?? []).join('/')).not.toContain('personal');
    expect(steps.some((step) => step.route?.includes('admin'))).toBe(false);
  });

  it('keeps Viewer and system administrator capabilities independent', () => {
    const steps = tourSteps(makeProject({ myRole: 'VIEWER', myPermissions: ['VIEW_ITEMS'] }), true);
    expect(steps.some((step) => step.text.includes('read-only'))).toBe(true);
    expect(steps.some((step) => step.title === 'Your system administrator tools')).toBe(true);
    expect(steps.some((step) => step.title.endsWith('project management'))).toBe(false);
    expect(steps.some((step) => step.text.includes('You can create items'))).toBe(false);
  });

  it('limits team Lead instructions to relevant teams and recomposes after permission changes', () => {
    const project = makeProject({
      myRole: 'MEMBER',
      myPermissions: ['VIEW_ITEMS', 'CREATE_ITEMS'],
      myTeams: [{ teamId: 'team-a', role: 'LEAD' }],
    });
    expect(
      tourSteps(project, false).some((step) =>
        step.text.includes('only to the teams you lead (1)'),
      ),
    ).toBe(true);
    const changed = tourSteps({ ...project, myTeams: [], myPermissions: ['VIEW_ITEMS'] }, false);
    expect(changed.some((step) => step.title.includes('planning'))).toBe(false);
  });

  it('gives archived projects a read/export explanation and omits write visits', () => {
    const steps = tourSteps(makeProject({ archivedAt: '2026-01-01' }), false);
    expect(steps.some((step) => step.text.includes('archived'))).toBe(true);
    expect(steps.some((step) => step.route?.includes('settings'))).toBe(false);
  });

  it('keeps the usual path short and help limited to implemented, searchable procedures', () => {
    expect(tourSteps(makeProject(), true).length).toBeLessThanOrEqual(10);
    expect(new Set(HELP_ARTICLES.map((article) => article.id)).size).toBe(HELP_ARTICLES.length);
    expect(
      HELP_ARTICLES.every((article) => article.role.length > 0 && article.text.length > 50),
    ).toBe(true);
    expect(
      HELP_ARTICLES.filter((article) => article.id !== 'ado')
        .map((article) => article.text)
        .join(' '),
    ).not.toMatch(/ADO|Azure DevOps/);
    const transfer = HELP_ARTICLES.find((article) => article.id === 'ado');
    expect(transfer?.role).toContain('project PM only');
    // The guide's steps live in sections; check the whole article.
    const guide = [
      transfer?.text ?? '',
      ...(transfer?.sections ?? []).flatMap((s) => [s.heading, s.text ?? '', ...(s.steps ?? [])]),
    ].join(' ');
    expect(guide).toContain('Link returned IDs only');
    expect(guide).toContain('Quick review is the default');
    expect(guide).toContain('Kloister never connects to ADO and uses no token');
    expect(guide).toContain('Starting in ADO');
    expect(HELP_ARTICLES.find((article) => article.id === 'snapshots')?.text).toContain(
      'Every matching page',
    );
  });
});
