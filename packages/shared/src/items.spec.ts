import { compareOutline, fitTypeUnder, naturalChildType } from './index.js';

describe('outline order (v1.3.1)', () => {
  it('puts placed items first by position, then the rest by type and number', () => {
    const items = [
      { id: 'a', type: 'TASK' as const, number: 3, outlinePosition: null },
      { id: 'b', type: 'STORY' as const, number: 9, outlinePosition: null },
      { id: 'c', type: 'TASK' as const, number: 5, outlinePosition: 2048 },
      { id: 'd', type: 'BUG' as const, number: 1, outlinePosition: 1024 },
    ];
    expect([...items].sort(compareOutline).map((i) => i.id)).toEqual(['d', 'c', 'b', 'a']);
  });
});

describe('placing items in the hierarchy (v1.3.1)', () => {
  it('keeps a type that is allowed under the parent', () => {
    expect(fitTypeUnder('TASK', 'FEATURE', [])).toEqual({ type: 'TASK' });
    expect(fitTypeUnder('FEATURE', null, ['STORY'])).toEqual({ type: 'FEATURE' });
  });

  it('turns an item into the natural child of its new parent', () => {
    expect(fitTypeUnder('FEATURE', 'FEATURE', [])).toEqual({ type: 'STORY' });
    expect(fitTypeUnder('STORY', 'EPIC', ['TASK'])).toEqual({ type: 'FEATURE' });
    expect(fitTypeUnder('EPIC', 'STORY', [])).toEqual({ type: 'TASK' });
    expect(naturalChildType('TASK')).toBeNull();
  });

  it('refuses parents without children and children that would no longer fit', () => {
    expect(fitTypeUnder('STORY', 'TASK', [])).toEqual({
      error: 'A Task cannot have child items',
    });
    expect(fitTypeUnder('FEATURE', 'FEATURE', ['STORY'])).toEqual({
      error: 'It would become a User Story, which cannot hold its User Story items',
    });
  });
});
