import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import type { MemberCandidateDto } from '@kloister/shared';
import { settle } from '../../testing/fixtures';
import { UserPicker } from './user-picker';

const ann = { id: 'ann', displayName: 'Ann', email: 'ann@example.org' };
const bo = { id: 'bo', displayName: 'Bo', email: 'bo@example.org' };

interface PickerInternals {
  edit(value: string): void;
  search(): Promise<void>;
  choose(user: MemberCandidateDto): void;
  options(): MemberCandidateDto[];
  error(): string;
  loading(): boolean;
}

describe('UserPicker', () => {
  async function render(multiple = false) {
    const search = vi
      .fn<(q: string) => Promise<MemberCandidateDto[]>>()
      .mockResolvedValue([ann, bo]);
    await TestBed.configureTestingModule({ imports: [UserPicker] }).compileComponents();
    const fixture = TestBed.createComponent(UserPicker);
    fixture.componentRef.setInput('searchUsers', search);
    fixture.componentRef.setInput('multiple', multiple);
    await settle(fixture);
    const picker = fixture.componentInstance as unknown as PickerInternals;
    return { fixture, picker, component: fixture.componentInstance, search };
  }

  it('commits identities only from results and invalidates a single choice on editing', async () => {
    const { picker, component, search } = await render();
    picker.edit('  Ann  ');
    expect(component.selected()).toEqual([]);
    picker.choose(ann);
    expect(component.selected()).toEqual([]);
    await picker.search();
    expect(search).toHaveBeenCalledWith('Ann');
    picker.choose(ann);
    expect(component.selected()).toEqual([ann]);
    picker.edit('Bo');
    expect(component.selected()).toEqual([]);
  });

  it('retains multiple chips across queries and excludes selected users from results', async () => {
    const { picker, component } = await render(true);
    await picker.search();
    picker.choose(ann);
    picker.edit('Bo');
    await picker.search();
    expect(picker.options()).toEqual([bo]);
    picker.choose(bo);
    expect(component.selected()).toEqual([ann, bo]);
  });

  it('commits a highlighted result with Enter without starting a second search', async () => {
    const { fixture, picker, component, search } = await render();
    const input = (fixture.nativeElement as HTMLElement).querySelector('input');
    if (!input) throw new Error('Missing input');
    input.focus();
    await picker.search();
    await settle(fixture);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await settle(fixture);
    input.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        keyCode: 40,
        bubbles: true,
        cancelable: true,
      }),
    );
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }),
    );
    await settle(fixture);
    expect(component.selected()).toEqual([ann]);
    expect(search).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('discards older responses and queries invalidated by editing', async () => {
    const { picker, search } = await render();
    let finish: (users: MemberCandidateDto[]) => void = () => undefined;
    search.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    picker.edit('old');
    const old = picker.search();
    picker.edit('new');
    search.mockResolvedValueOnce([bo]);
    await picker.search();
    finish([ann]);
    await old;
    expect(picker.options()).toEqual([bo]);
    expect(picker.loading()).toBe(false);
  });

  it('shows a current search failure and keeps an empty result selectable only as guidance', async () => {
    const { picker, search, component } = await render();
    search.mockRejectedValueOnce(
      new HttpErrorResponse({ status: 503, error: { message: 'Directory unavailable' } }),
    );
    await picker.search();
    expect(picker.error()).toContain('Directory unavailable');
    expect(component.selected()).toEqual([]);
    search.mockResolvedValueOnce([]);
    await picker.search();
    expect(picker.options()).toEqual([]);
    expect(picker.error()).toBe('');
  });
});
