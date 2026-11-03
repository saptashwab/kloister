import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { makeItem, makeMember, settle } from '../../../testing/fixtures';
import { ProjectContext } from '../../core/project-context';
import { ItemCard } from './item-card';

describe('ItemCard (v1.3.3)', () => {
  it('draws avatars without shares and gives a share below 100% to screen readers', async () => {
    const members = [makeMember('u1', 'Ann Lee'), makeMember('u2', 'Bo Chen')];
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: ProjectContext,
          useValue: {
            project: signal(null),
            labelsById: signal(new Map()),
            membersById: signal(new Map(members.map((m) => [m.userId, m]))),
            flashing: signal(new Set()),
            recent: signal(0),
            changedBy: () => null,
            presenceByItem: signal(new Map()),
            // For the card's duplicate action, which stays hidden here.
            has: () => false,
            writable: () => false,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ItemCard);
    fixture.componentRef.setInput(
      'item',
      makeItem(1, {
        assigneeIds: ['u1', 'u2'],
        assigneeShares: [
          { userId: 'u1', share: 100 },
          { userId: 'u2', share: 50 },
        ],
      }),
    );
    fixture.componentRef.setInput('today', '2026-11-03');
    await settle(fixture);
    const stack = (fixture.nativeElement as HTMLElement).querySelector('.k-avatars')!;
    expect(stack.querySelectorAll('button.k-avatar')).toHaveLength(2);
    // Nothing visible beside the avatars; the share is in the hover card.
    const hidden = [...stack.querySelectorAll('.visually-hidden')].map((e) => e.textContent);
    expect(hidden).toEqual(['50% of this item']);
    const visible = [...stack.childNodes]
      .filter((n) => !(n instanceof HTMLElement && n.classList.contains('visually-hidden')))
      .map((n) => n.textContent ?? '')
      .join('');
    expect(visible).not.toContain('%');
  });
});
