import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutosaveDebouncer } from '../src/renderer/src/editor/autosave';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('AutosaveDebouncer', () => {
  it('fires once after the debounce delay', () => {
    const calls: number[] = [];
    const debouncer = new AutosaveDebouncer(500, () => calls.push(Date.now()));
    debouncer.schedule();
    expect(debouncer.pending).toBe(true);

    vi.advanceTimersByTime(499);
    expect(calls).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(calls).toHaveLength(1);
    expect(debouncer.pending).toBe(false);
  });

  it('restarts the timer when edits keep arriving', () => {
    const calls: number[] = [];
    const debouncer = new AutosaveDebouncer(100, () => calls.push(1));

    debouncer.schedule();
    vi.advanceTimersByTime(60);
    debouncer.schedule();
    vi.advanceTimersByTime(60);
    expect(calls).toHaveLength(0);

    vi.advanceTimersByTime(40);
    expect(calls).toHaveLength(1);
  });

  it('cancels a pending save without firing', () => {
    const calls: number[] = [];
    const debouncer = new AutosaveDebouncer(100, () => calls.push(1));
    debouncer.schedule();
    debouncer.cancel();
    vi.advanceTimersByTime(500);
    expect(calls).toHaveLength(0);
    expect(debouncer.pending).toBe(false);
  });

  it('flushes immediately when requested', () => {
    const calls: number[] = [];
    const debouncer = new AutosaveDebouncer(100, () => calls.push(1));
    debouncer.schedule();
    debouncer.flush();
    expect(calls).toHaveLength(1);
    expect(debouncer.pending).toBe(false);

    debouncer.flush();
    expect(calls).toHaveLength(1);
  });
});
