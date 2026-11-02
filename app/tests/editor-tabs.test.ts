import { describe, expect, it } from 'vitest';
import { EditorTabs } from '../src/renderer/src/editor/tabs';
import type { EditorTabInfo } from '../src/renderer/src/editor/model-types';

function tab(id: string, path: string): EditorTabInfo {
  return {
    id,
    path,
    title: '',
    dirty: false,
    saving: false,
    conflict: false,
    missing: false,
    viewMode: 'edit',
  };
}

describe('EditorTabs', () => {
  it('adds tabs in order and activates the first one', () => {
    const tabs = new EditorTabs();
    expect(tabs.add(tab('a', 'notes/a.md'))).toEqual({ id: 'a' });
    tabs.add(tab('b', 'notes/b.md'));

    expect(tabs.activeId).toBe('a');
    expect(tabs.list().map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(tabs.get('a')?.title).toBe('a.md');
  });

  it('returns the existing tab for a duplicate path, ignoring case', () => {
    const tabs = new EditorTabs();
    tabs.add(tab('a', 'notes/a.md'));
    const duplicate = tabs.add(tab('other', 'Notes/A.MD'));
    expect(duplicate).toEqual({ id: 'a', existingId: 'a' });
    expect(tabs.size).toBe(1);
  });

  it('activates and closes with neighbour selection', () => {
    const tabs = new EditorTabs();
    tabs.add(tab('a', 'a.md'));
    tabs.add(tab('b', 'b.md'));
    tabs.add(tab('c', 'c.md'));

    expect(tabs.activate('b')).toBe(true);
    expect(tabs.getActive()?.id).toBe('b');

    expect(tabs.remove('b')).toBe('c');
    expect(tabs.activeId).toBe('c');
    expect(tabs.list().map((entry) => entry.id)).toEqual(['a', 'c']);

    expect(tabs.remove('c')).toBe('a');
    expect(tabs.activeId).toBe('a');

    expect(tabs.remove('a')).toBeNull();
    expect(tabs.list()).toEqual([]);
  });

  it('keeps the active tab when closing another one and updates flags', () => {
    const tabs = new EditorTabs();
    tabs.add(tab('a', 'a.md'));
    tabs.add(tab('b', 'b.md'));
    tabs.activate('a');

    expect(tabs.remove('b')).toBe('a');
    expect(tabs.activeId).toBe('a');

    tabs.update('a', { dirty: true, conflict: true, title: 'renamed.md' });
    expect(tabs.get('a')).toMatchObject({ dirty: true, conflict: true, title: 'renamed.md' });
    expect(tabs.findByPath('a.md')?.id).toBe('a');
  });

  it('ignores unknown ids', () => {
    const tabs = new EditorTabs();
    expect(tabs.activate('missing')).toBe(false);
    expect(tabs.remove('missing')).toBeNull();
    expect(tabs.update('missing', { dirty: true })).toBe(false);
    expect(tabs.findByPath('missing.md')).toBeUndefined();
  });
});
