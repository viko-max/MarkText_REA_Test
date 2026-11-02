/**
 * Public entry point for the editor module.
 *
 * Integration code mounts `mountEditor` into its own container, passes the
 * IPC-backed save/read callbacks, and uses the returned host to open, switch
 * and persist tabs. Pure state helpers are exported too for tests and for
 * persistence glue.
 */

export { AutosaveDebouncer, defaultTimerApi } from './autosave';
export type { TimerApi, TimerHandle } from './autosave';
export { CodeMirrorEditorHost, mountEditor } from './host';
export { isCompositionEvent, shouldDeferToIme } from './ime';
export type { KeyEventLike } from './ime';
export { composeSafeBindings, createEditorKeymap } from './keymap';
export {
  buildImageMarkdown,
  detectPastedImage,
  encodeBase64,
  encodeBase64FromBuffer,
  escapeMarkdownImagePath,
  PASTED_IMAGE_MEDIA_TYPES,
  pastedImageFileName,
  pastedImageMediaType,
  relativeWorkspacePath,
  SVG_PASTE_MESSAGE,
} from './paste';
export type { PastedFileLike, PastedImageDetection, PastedImageMediaType } from './paste';
export { SerialQueue } from './queue';
export { clampSelection, DocumentSession } from './session';
export type {
  DocumentSessionInit,
  ExternalChangeDecision,
  SaveSnapshot,
} from './session';
export { EditorTabs } from './tabs';
export type { AddTabResult } from './tabs';
export type {
  EditorBlockReason,
  EditorHost,
  EditorHostCallbacks,
  EditorHostOptions,
  EditorOpenDocument,
  EditorPersistenceFragment,
  EditorSaveOptions,
  EditorSaveOutcome,
  EditorTabInfo,
} from './types';
