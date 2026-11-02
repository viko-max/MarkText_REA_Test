/**
 * Input-method (IME) guard.
 *
 * Chinese/Japanese/Korean composition must reach the browser: key bindings the
 * editor owns must not run while a composition is active. CodeMirror exposes
 * `view.composing`; some browsers additionally report `isComposing` or the
 * legacy key-code 229 on the keydown itself.
 */

export interface KeyEventLike {
  isComposing?: boolean;
  keyCode?: number;
  key?: string;
}

export function isCompositionEvent(event: KeyEventLike): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/** True when a key event should be left to the IME and browser. */
export function shouldDeferToIme(viewComposing: boolean, event: KeyEventLike): boolean {
  return viewComposing || isCompositionEvent(event);
}
