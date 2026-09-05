import { describe, expect, it, vi } from 'vitest';
import { createNavigationGuard } from './navigation-guard.js';

describe('navigation guard', () => {
  it('does not prompt when there is no unsaved work', () => {
    const ask = vi.fn(() => false);
    expect(createNavigationGuard().confirm(ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it('keeps parent work protected after a configuration dialog closes', () => {
    const guard = createNavigationGuard();
    const page = guard.register();
    const dialog = guard.register();
    const ask = vi.fn(() => false);
    expect(guard.confirm(ask)).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    dialog();
    dialog();
    expect(guard.confirm(ask)).toBe(false);
    page();
    expect(guard.confirm(ask)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('allows confirmed navigation without prematurely clearing pending edits', () => {
    const guard = createNavigationGuard();
    const release = guard.register();
    expect(guard.confirm(() => true)).toBe(true);
    expect(guard.confirm(() => false)).toBe(false);
    release();
    expect(guard.confirm(() => false)).toBe(true);
  });
});
