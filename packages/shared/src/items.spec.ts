import { fitTypeUnder, naturalChildType } from './index.js';

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
