/**
 * DOM-free editor types shared with tests and non-CodeMirror code.
 */

import type {
  DocumentContent,
  DocumentState,
  DocumentViewState,
  ImageAsset,
  ReadDocumentRequest,
  SaveDocumentCopyRequest,
  SaveDocumentRequest,
  SaveDocumentResult,
  SaveImageRequest,
  TextSelection,
  ViewMode,
  WorkspaceRelativePath,
} from '../../../shared/contracts';
import type { IpcFailure, IpcResult } from '../../../shared/ipc';

export interface EditorSaveOptions {
  /** Automatic saves skip unchanged buffers; manual saves always write. */
  automatic?: boolean;
}

export type EditorBlockReason = 'conflict' | 'missing' | 'not_ready';

export type EditorSaveOutcome =
  | { status: 'saved'; result: SaveDocumentResult; automatic: boolean }
  | { status: 'blocked'; reason: EditorBlockReason }
  | { status: 'skipped'; reason: 'unchanged' | 'no_document' }
  | { status: 'failed'; failure: IpcFailure; automatic: boolean };

export interface EditorOpenDocument {
  id: string;
  path: WorkspaceRelativePath;
  markdown: string;
  /** Hash of the bytes the buffer was loaded from; CAS basis for saves. */
  baseHash: string;
  diskHash?: string | null;
  mtimeMs?: number | null;
  selection?: TextSelection | null;
  scrollTop?: number;
  viewMode?: ViewMode;
  exportedSignature?: string | null;
}

export interface EditorTabInfo {
  id: string;
  path: WorkspaceRelativePath;
  title: string;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  missing: boolean;
  viewMode: ViewMode;
}

export interface EditorHostCallbacks {
  save(request: SaveDocumentRequest): Promise<IpcResult<SaveDocumentResult>>;
  saveCopy(request: SaveDocumentCopyRequest): Promise<IpcResult<SaveDocumentResult>>;
  read(request: ReadDocumentRequest): Promise<IpcResult<DocumentContent>>;
  /** Stores pasted image bytes; the editor only inserts after a success. */
  saveImage?(request: SaveImageRequest): Promise<IpcResult<ImageAsset>>;
}

export interface EditorPersistenceFragment {
  openDocuments: WorkspaceRelativePath[];
  activeDocument: WorkspaceRelativePath | null;
  documentViews: Record<WorkspaceRelativePath, DocumentViewState>;
}

export type { DocumentContent, DocumentState, DocumentViewState };
