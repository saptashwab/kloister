import { TestBed } from '@angular/core/testing';
import type { BucketDto } from '@kloister/shared';
import { makeBucket, makeProject, settle } from '../../../testing/fixtures';
import { ItemsApiService } from '../../core/items-api.service';
import { ProjectsApiService } from '../../core/projects-api.service';
import { Dialogs } from '../../ui/dialogs';
import { ProjectBoardSettings } from './project-board-settings';

interface SettingsInternals {
  moveTarget: { set(value: string): void; (): string };
  deleting: { (): BucketDto | null };
  deleteBucket(bucket: BucketDto): Promise<void>;
}

describe('ProjectBoardSettings regressions', () => {
  async function render(section: 'board' | 'labels' = 'board') {
    const buckets = [makeBucket('b1', 'To Do', 1), makeBucket('b2', 'Done', 2)];
    const api = {
      labels: vi.fn().mockResolvedValue([]),
      deleteBucket: vi.fn().mockResolvedValue(undefined),
    };
    const confirm = vi.fn().mockResolvedValue(true);
    await TestBed.configureTestingModule({
      imports: [ProjectBoardSettings],
      providers: [
        { provide: ItemsApiService, useValue: api },
        {
          provide: ProjectsApiService,
          useValue: { get: vi.fn().mockResolvedValue(makeProject()) },
        },
        { provide: Dialogs, useValue: { confirm } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(ProjectBoardSettings);
    fixture.componentRef.setInput('project', makeProject());
    fixture.componentRef.setInput('buckets', buckets);
    fixture.componentRef.setInput('canManageBoard', true);
    fixture.componentRef.setInput('section', section);
    await settle(fixture);
    return {
      fixture,
      root: fixture.nativeElement as HTMLElement,
      api,
      confirm,
      buckets,
      component: fixture.componentInstance as unknown as SettingsInternals,
    };
  }

  it('gives the empty labels their own full row', async () => {
    const { root } = await render('labels');
    expect(root.querySelector('.labels-empty app-empty-state')?.textContent).toContain(
      'No labels yet',
    );
    expect(root.querySelectorAll('.label-list li:not(.labels-empty)')).toHaveLength(0);
  });

  it('resets the destination on each delete trigger and confirms before deletion', async () => {
    const { root, component, fixture, api, confirm, buckets } = await render();
    component.moveTarget.set('b2');
    // Each bucket row has one actions menu (M8.5); Delete… is inside it.
    root.querySelector<HTMLButtonElement>('button[aria-label="Actions for To Do"]')?.click();
    await settle(fixture);
    const items = [...document.querySelectorAll<HTMLButtonElement>('.mat-mdc-menu-item')];
    expect(items.map((b) => b.textContent?.trim())).toEqual(['Move up', 'Move down', 'Delete…']);
    expect(items[0]?.disabled).toBe(true);
    const trigger = items.find((b) => b.textContent?.trim() === 'Delete…');
    if (!trigger) throw new Error('Missing delete trigger');
    trigger.click();
    await settle(fixture);
    expect(component.moveTarget()).toBe('');
    expect(
      root.querySelector('mat-form-field mat-select[aria-label="Bucket receiving the cards"]'),
    ).not.toBeNull();
    await component.deleteBucket(buckets[0]);
    expect(api.deleteBucket).not.toHaveBeenCalled();
    component.moveTarget.set('b2');
    confirm.mockResolvedValueOnce(false);
    await component.deleteBucket(buckets[0]);
    expect(api.deleteBucket).not.toHaveBeenCalled();
    await component.deleteBucket(buckets[0]);
    expect(api.deleteBucket).toHaveBeenCalledWith('p1', 'b1', 'b2');
  });
});
