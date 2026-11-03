import { TestBed } from '@angular/core/testing';
import { Layout } from './layout';
import { SessionStore } from './session.store';

/** Presses a key on the document. */
function press(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

/** Signs a user in, as the shortcut only works for signed-in users. */
function signIn(): void {
  TestBed.inject(SessionStore).set({
    id: 'u1',
    email: 'a@example.org',
    displayName: 'A',
    systemRole: 'USER',
    mustChangePassword: false,
    isActive: true,
    lastLoginAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('Layout (v1.4.0)', () => {
  beforeEach(() => {
    localStorage.removeItem('k-rail');
    localStorage.removeItem('k-fold');
  });

  afterEach(() => {
    localStorage.removeItem('k-rail');
    localStorage.removeItem('k-fold');
  });

  it('starts open and remembers each choice in this browser', () => {
    const layout = TestBed.inject(Layout);
    expect(layout.rail()).toBe(false);
    expect(layout.folded()).toBe(false);
    layout.setRail();
    layout.setFolded(true);
    expect(localStorage.getItem('k-rail')).toBe('on');
    expect(localStorage.getItem('k-fold')).toBe('on');
    TestBed.resetTestingModule();
    const again = TestBed.inject(Layout);
    expect(again.rail()).toBe(true);
    expect(again.folded()).toBe(true);
    again.setRail();
    expect(again.rail()).toBe(false);
    expect(localStorage.getItem('k-rail')).toBe('off');
  });

  it('folds both with Ctrl+\\ (or ⌘\\), and opens both when either is folded', () => {
    const layout = TestBed.inject(Layout);
    signIn();
    const event = press({ key: '\\', code: 'Backslash', ctrlKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect([layout.rail(), layout.folded()]).toEqual([true, true]);
    press({ key: '\\', code: 'Backslash', metaKey: true });
    expect([layout.rail(), layout.folded()]).toEqual([false, false]);
    layout.setFolded(true);
    press({ key: '\\', code: 'Backslash', ctrlKey: true });
    expect([layout.rail(), layout.folded()]).toEqual([false, false]);
  });

  it('leaves other keys alone, including a plain backslash typed in text', () => {
    const layout = TestBed.inject(Layout);
    signIn();
    expect(press({ key: '\\', code: 'Backslash' }).defaultPrevented).toBe(false);
    press({ key: '\\', code: 'Backslash', ctrlKey: true, shiftKey: true });
    press({ key: 'b', code: 'KeyB', ctrlKey: true });
    expect([layout.rail(), layout.folded()]).toEqual([false, false]);
  });

  it('ignores the shortcut when signed out and while the keys are held', () => {
    const layout = TestBed.inject(Layout);
    press({ key: '\\', code: 'Backslash', ctrlKey: true });
    expect([layout.rail(), layout.folded()]).toEqual([false, false]);
    signIn();
    press({ key: '\\', code: 'Backslash', ctrlKey: true, repeat: true });
    expect([layout.rail(), layout.folded()]).toEqual([false, false]);
  });

  it('ignores a remembered rail where it does not show, so a press always changes the page', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    try {
      localStorage.setItem('k-rail', 'on');
      const layout = TestBed.inject(Layout);
      signIn();
      press({ key: '\\', code: 'Backslash', ctrlKey: true });
      expect(layout.folded()).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('still works when the browser refuses storage', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const layout = TestBed.inject(Layout);
      expect(layout.rail()).toBe(false);
      layout.setRail(true);
      expect(layout.rail()).toBe(true);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
