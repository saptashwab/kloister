import { DestroyRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { SessionStore } from './session.store';
import { Shortcuts } from './shortcuts';

describe('Shortcuts', () => {
  beforeEach(() => localStorage.removeItem('k-shortcuts'));
  afterEach(() => localStorage.removeItem('k-shortcuts'));
  function setup() {
    const session = TestBed.inject(SessionStore);
    session.set({
      id: 'u1',
      email: 'a@example.org',
      displayName: 'A',
      systemRole: 'USER',
      mustChangePassword: false,
      isActive: true,
      lastLoginAt: null,
      createdAt: '',
    });
    const service = TestBed.inject(Shortcuts);
    const handler = vi.fn(() => true);
    service.register(handler, TestBed.inject(DestroyRef));
    return { service, session, handler };
  }

  it('dispatches once and ignores modifiers, composing input and text fields', () => {
    const { handler } = setup();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    expect(handler).toHaveBeenCalledExactlyOnceWith('c');
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }),
    );
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'c', isComposing: true, bubbles: true }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    input.remove();
  });

  it('does not invoke actions while signed out or forced to change password', () => {
    const { session, handler } = setup();
    const user = session.user();
    if (!user) throw new Error('Expected a user');
    session.set({ ...user, mustChangePassword: true });
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    session.set(null);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('gives the most recently opened context priority', () => {
    const { service, handler } = setup();
    const drawer = vi.fn(() => true);
    service.register(drawer, TestBed.inject(DestroyRef));
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', bubbles: true }));
    expect(drawer).toHaveBeenCalledExactlyOnceWith('m');
    expect(handler).not.toHaveBeenCalled();
  });

  it('can disable character shortcuts and retains the browser preference', () => {
    const { service, handler } = setup();
    service.setEnabled(false);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    expect(handler).not.toHaveBeenCalled();
    expect(localStorage.getItem('k-shortcuts')).toBe('off');
    service.setEnabled(true);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true }));
    expect(handler).toHaveBeenCalledOnce();
  });
});
