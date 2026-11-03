import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { makeItem, makeMember, settle } from '../../../testing/fixtures';
import { ProjectContext } from '../../core/project-context';
import { ItemCard } from './item-card';
import { Today } from '../../core/today';

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

  it('keeps the due pill current on an open tab (v1.4.0)', async () => {
    const now = signal({ date: '2026-11-03', minutes: 16 * 60 });
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: Today, useValue: { now } },
        {
          provide: ProjectContext,
          useValue: {
            project: signal(null),
            labelsById: signal(new Map()),
            membersById: signal(new Map()),
            flashing: signal(new Set()),
            recent: signal(0),
            changedBy: () => null,
            presenceByItem: signal(new Map()),
            has: () => false,
            writable: () => false,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ItemCard);
    fixture.componentRef.setInput('item', makeItem(1, { dueDate: '2026-11-04', dueTime: '17:00' }));
    await settle(fixture);
    const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text()).toContain('Due tomorrow 17:00');
    now.set({ date: '2026-11-04', minutes: 16 * 60 });
    await settle(fixture);
    expect(text()).toContain('Due today 17:00');
    now.set({ date: '2026-11-04', minutes: 17 * 60 + 1 });
    await settle(fixture);
    expect(text()).toContain('Overdue since 17:00');
  });

  it('marks a card someone moves, and says so to screen readers once (DESIGN §9.1)', async () => {
    const members = [makeMember('u1', 'Ann Lee')];
    const presence = signal(
      new Map([
        ['i1', [{ userId: 'u1', itemId: 'i1', action: 'moving', field: null, view: 'board' }]],
      ]),
    );
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
            presenceByItem: presence,
            has: () => false,
            writable: () => false,
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(ItemCard);
    fixture.componentRef.setInput('item', makeItem(1));
    await settle(fixture);
    const card = fixture.nativeElement as HTMLElement;
    expect(card.classList).toContain('k-pm-strong');
    const tag = card.querySelector('app-presence-tag')!;
    expect(tag.getAttribute('title')).toBe('Ann Lee is moving this card');
    expect(tag.getAttribute('aria-hidden')).toBe('true');
    const named = [...card.querySelectorAll('[role="img"]')].filter(
      (e) => e.getAttribute('aria-label') === 'Ann Lee is moving this card',
    );
    expect(named).toHaveLength(1);
  });
});
