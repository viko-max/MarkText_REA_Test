/**
 * Public types for the editor module's integration surface.
 *
 * DOM-free types live in `model-types.ts` so unit tests can import them
 * without pulling `HTMLElement` (the test tsconfig has no DOM lib).
 */

import type {
  DocumentChangeEvent,
  ImageAsset,
  SaveDocumentResult,
  WorkspaceRelativePath,
} from '../../../shared/contracts';
import type { IpcFailure, IpcResult } from '../../../shared/ipc';
import type {
  EditorHostCallbacks,
  EditorOpenDocument,
  EditorPersistenceFragment,
  EditorSaveOptions,
  EditorSaveOutcome,
  EditorTabInfo,
} from './model-types';

export type {
  EditorBlockReason,
  EditorHostCallbacks,
  EditorOpenDocument,
  EditorPersistenceFragment,
  EditorSaveOptions,
  EditorSaveOutcome,
  EditorTabInfo,
} from './model-types';

export interface EditorHostOptions extends EditorHostCallbacks {
  parent: HTMLElement;
  autoSaveDelayMs?: number;
  readOnly?: boolean;
  placeholder?: string;
  onStateChange?(tabs: EditorTabInfo[], activeId: string | null): void;
  onError?(failure: IpcFailure, context: string): void;
  /** Called after a pasted image was stored and inserted. */
  onImageSaved?(asset: ImageAsset, insertion: string): void;
}

export interface EditorHost {
  readonly view: import('@codemirror/view').EditorView;
  open(document: EditorOpenDocument, options?: { activate?: boolean }): void;
  activate(id: string): boolean;
  close(id: string): boolean;
  getActiveId(): string | null;
  getTabs(): EditorTabInfo[];
  getDocumentState(id?: string): import('../../../shared/contracts').DocumentState | null;
  getPersistenceFragment(): EditorPersistenceFragment;
  /** Replaces `[start, end)` and puts the caret at the end of the insertion. */
  insertText(text: string, start: number, end: number): boolean;
  /** Markdown of the active tab, or `null` when no tab is active. */
  getActiveMarkdown(): string | null;
  save(id?: string, options?: EditorSaveOptions): Promise<EditorSaveOutcome>;
  reload(
    id?: string,
  ): Promise<IpcResult<import('../../../shared/contracts').DocumentContent> | null>;
  saveCopy(
    id: string | null,
    targetPath: WorkspaceRelativePath,
  ): Promise<IpcResult<SaveDocumentResult>>;
  applyExternalChange(change: DocumentChangeEvent): Promise<void>;
  setAutoSaveEnabled(enabled: boolean): void;
  isAutoSaveEnabled(): boolean;
  setReadOnly(readOnly: boolean): void;
  isReadOnly(): boolean;
  openSearch(): boolean;
  focus(): void;
  destroy(): void;
}
