/**
 * Keyboard bindings for the editor.
 *
 * Every binding that the editor owns is wrapped so it does nothing while an
 * IME composition is active. Returning `false` lets the browser/IME handle the
 * key instead of calling `preventDefault`, which is what keeps Chinese input
 * from being interrupted mid-composition.
 */

import { markdownKeymap } from '@codemirror/lang-markdown';
import { defaultKeymap, historyKeymap, redo } from '@codemirror/commands';
import { searchKeymap } from '@codemirror/search';
import { Prec, type Extension } from '@codemirror/state';
import { keymap, type Command, type EditorView, type KeyBinding } from '@codemirror/view';

function guardCommand(command: Command): Command {
  return (view: EditorView) => (view.composing ? false : command(view));
}

/** Clone bindings so no binding runs during composition. */
export function composeSafeBindings(bindings: readonly KeyBinding[]): KeyBinding[] {
  return bindings.map((binding) => {
    const next: KeyBinding = { ...binding };
    if (binding.run) next.run = guardCommand(binding.run);
    if (binding.shift) next.shift = guardCommand(binding.shift);
    return next;
  });
}

export interface EditorKeymapHandlers {
  save(): void;
}

export function createEditorKeymap(handlers: EditorKeymapHandlers): Extension {
  const saveBinding: KeyBinding = {
    key: 'Mod-s',
    run: (view) => {
      if (view.composing) return false;
      handlers.save();
      return true;
    },
  };

  // `historyKeymap` binds redo to `Mod-y` everywhere and to `Ctrl-Shift-z`
  // only on Linux, so Windows needs the platform-style redo binding added here.
  const windowsRedoBinding: KeyBinding = {
    key: 'Ctrl-Shift-z',
    run: guardCommand(redo),
  };

  return [
    Prec.highest(keymap.of([saveBinding, windowsRedoBinding])),
    keymap.of([
      ...composeSafeBindings(defaultKeymap),
      ...composeSafeBindings(historyKeymap),
      ...composeSafeBindings(searchKeymap),
      ...composeSafeBindings(markdownKeymap),
    ]),
  ];
}
