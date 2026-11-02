import { describe, expect, it } from 'vitest';
import { isCompositionEvent, shouldDeferToIme } from '../src/renderer/src/editor/ime';

describe('IME composition guard', () => {
  it('detects composing events in every browser dialect', () => {
    expect(isCompositionEvent({ isComposing: true, key: 'Enter' })).toBe(true);
    expect(isCompositionEvent({ keyCode: 229, key: 'Process' })).toBe(true);
    expect(isCompositionEvent({ isComposing: false, keyCode: 13, key: 'Enter' })).toBe(false);
  });

  it('defers to the IME while the editor reports an active composition', () => {
    expect(shouldDeferToIme(true, { key: 'Enter', keyCode: 13 })).toBe(true);
    expect(shouldDeferToIme(false, { isComposing: true, key: ' ' })).toBe(true);
    expect(shouldDeferToIme(false, { key: 's', keyCode: 83 })).toBe(false);
  });
});
