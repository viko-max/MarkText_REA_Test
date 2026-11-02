import { describe, expect, it, vi } from 'vitest';
import { redo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { keymap, type EditorView, type KeyBinding } from '@codemirror/view';
import { createEditorKeymap } from '../src/renderer/src/editor/keymap';

function bindingsFor(save: () => void = () => undefined): {
  top: readonly KeyBinding[];
  all: readonly KeyBinding[];
} {
  const state = EditorState.create({
    doc: 'hello',
    extensions: [createEditorKeymap({ save })],
  });
  const groups = state.facet(keymap);
  return { top: groups[0] ?? [], all: groups.flat() };
}

const fakeView = (composing: boolean): EditorView => ({ composing } as unknown as EditorView);

describe('editor keymap', () => {
  it('binds the Windows redo shortcut Ctrl-Shift-z to a guarded redo', () => {
    const { top, all } = bindingsFor();
    const binding = top.find((entry) => entry.key === 'Ctrl-Shift-z');

    expect(binding).toBeDefined();
    expect(binding?.run).toBeTypeOf('function');
    // Wrapped by guardCommand, so it is not the bare CodeMirror command.
    expect(binding?.run).not.toBe(redo);
    // History keymaps only bind Ctrl-Shift-z on Linux; the explicit binding has
    // to be platform-neutral to reach Windows, and must not be duplicated.
    expect(all.filter((entry) => entry.key === 'Ctrl-Shift-z')).toHaveLength(1);
    expect(all.some((entry) => entry.linux === 'Ctrl-Shift-z')).toBe(true);
  });

  it('does not run redo while an IME composition is active', () => {
    const { top } = bindingsFor();
    const binding = top.find((entry) => entry.key === 'Ctrl-Shift-z');
    expect(binding?.run?.(fakeView(true))).toBe(false);
  });

  it('keeps the existing Mod-y redo binding and the Mod-s save binding', () => {
    const saveHandler = vi.fn();
    const { top, all } = bindingsFor(saveHandler);

    const save = top.find((entry) => entry.key === 'Mod-s');
    expect(save?.run?.(fakeView(false))).toBe(true);
    expect(saveHandler).toHaveBeenCalledTimes(1);

    expect(all.some((entry) => entry.key === 'Mod-y')).toBe(true);
  });
});
