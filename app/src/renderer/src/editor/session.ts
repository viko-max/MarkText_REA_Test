/**
 * Pure document-buffer state for one editor tab.
 *
 * All transitions are synchronous and side-effect free so the tricky parts —
 * dirty tracking across a save, external-change classification, conflict and
 * missing handling — can be unit tested without CodeMirror or Electron.
 */

import type {
  ContentHash,
  DocumentChangeEvent,
  DocumentContent,
  DocumentState,
  DocumentViewState,
  SaveDocumentResult,
  TextSelection,
  ViewMode,
} from '../../../shared/contracts';

export interface DocumentSessionInit {
  id: string;
  path: string;
  markdown: string;
  baseHash: string;
  diskHash?: string | null;
  mtimeMs?: number | null;
  selection?: TextSelection | null;
  scrollTop?: number;
  viewMode?: ViewMode;
  exportedSignature?: string | null;
}

export interface SaveSnapshot {
  markdown: string;
  baseHash: string;
}

export type ExternalChangeDecision = 'ignored' | 'conflict' | 'reload' | 'deleted';

export function clampSelection(selection: TextSelection | null, length: number): TextSelection | null {
  if (!selection) return null;
  const anchor = Math.max(0, Math.min(length, selection.anchor));
  const head = Math.max(0, Math.min(length, selection.head));
  return { anchor, head };
}

export class DocumentSession {
  readonly id: string;
  readonly path: string;
  markdown: string;
  baseHash: ContentHash | null;
  diskHash: ContentHash | null;
  mtimeMs: number | null;
  dirty = false;
  saving = false;
  conflict = false;
  missing = false;
  selection: TextSelection | null;
  scrollTop: number;
  viewMode: ViewMode;
  exportedSignature: string | null;

  private lastSavedMarkdown: string;

  constructor(init: DocumentSessionInit) {
    this.id = init.id;
    this.path = init.path;
    this.markdown = init.markdown;
    this.baseHash = init.baseHash;
    this.diskHash = init.diskHash ?? init.baseHash;
    this.mtimeMs = init.mtimeMs ?? null;
    this.selection = clampSelection(init.selection ?? null, init.markdown.length);
    this.scrollTop = Math.max(0, init.scrollTop ?? 0);
    this.viewMode = init.viewMode ?? 'edit';
    this.exportedSignature = init.exportedSignature ?? null;
    this.lastSavedMarkdown = init.markdown;
  }

  /** Update the buffer and recompute dirty from the last saved content. */
  setContent(markdown: string): boolean {
    this.markdown = markdown;
    this.dirty = markdown !== this.lastSavedMarkdown;
    return this.dirty;
  }

  setSelection(selection: TextSelection | null): void {
    this.selection = clampSelection(selection, this.markdown.length);
  }

  setScrollTop(scrollTop: number): void {
    this.scrollTop = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  }

  setViewMode(viewMode: ViewMode): void {
    this.viewMode = viewMode;
  }

  canSave(): boolean {
    return !this.conflict && !this.missing && this.baseHash !== null && !this.saving;
  }

  /** Reserve the save slot and capture the exact bytes being written. */
  beginSave(): SaveSnapshot | null {
    if (this.conflict || this.missing || this.baseHash === null || this.saving) return null;
    this.saving = true;
    return { markdown: this.markdown, baseHash: this.baseHash };
  }

  /**
   * A save completed. `dirty` stays true when the buffer changed while the
   * write was in flight: only the exact snapshot that reached disk is clean.
   */
  completeSave(snapshot: SaveSnapshot, result: SaveDocumentResult): void {
    this.saving = false;
    this.conflict = false;
    this.missing = false;
    this.baseHash = result.diskHash;
    this.diskHash = result.diskHash;
    this.mtimeMs = result.mtimeMs;
    this.lastSavedMarkdown = snapshot.markdown;
    this.dirty = this.markdown !== snapshot.markdown;
  }

  failSave(code: string): void {
    this.saving = false;
    if (code === 'conflict') this.conflict = true;
    if (code === 'not_found') this.missing = true;
  }

  /**
   * Classify an external watcher event.
   *
   * - `ignored`: the disk hash is one this session already knows about.
   * - `conflict`: the buffer is dirty or a save is in flight; automatic and
   *   manual saves must stop until the user reloads or saves a copy.
   * - `deleted`: the file disappeared; saves are blocked.
   * - `reload`: the document is clean and can be replaced from disk.
   */
  applyExternalChange(change: DocumentChangeEvent): ExternalChangeDecision {
    if (change.kind === 'deleted') {
      this.missing = true;
      this.saving = false;
      return 'deleted';
    }
    if (change.hash !== null && (change.hash === this.baseHash || change.hash === this.diskHash)) {
      return 'ignored';
    }
    if (this.saving || this.dirty) {
      this.conflict = true;
      return 'conflict';
    }
    return 'reload';
  }

  applyReload(content: DocumentContent): void {
    this.markdown = content.markdown;
    this.baseHash = content.hash;
    this.diskHash = content.hash;
    this.mtimeMs = content.mtimeMs;
    this.lastSavedMarkdown = content.markdown;
    this.dirty = false;
    this.saving = false;
    this.conflict = false;
    this.missing = false;
    this.selection = clampSelection(this.selection, content.markdown.length);
  }

  markMissing(): void {
    this.missing = true;
    this.saving = false;
  }

  markConflict(): void {
    this.conflict = true;
    this.saving = false;
  }

  toDocumentState(): DocumentState {
    return {
      id: this.id,
      path: this.path,
      markdown: this.markdown,
      baseHash: this.baseHash,
      diskHash: this.diskHash,
      mtimeMs: this.mtimeMs,
      dirty: this.dirty,
      saving: this.saving,
      conflict: this.conflict,
      missing: this.missing,
      selection: this.selection,
      scrollTop: this.scrollTop,
      viewMode: this.viewMode,
      exportedSignature: this.exportedSignature,
    };
  }

  toViewState(): DocumentViewState {
    return {
      selection: this.selection,
      scrollTop: this.scrollTop,
      viewMode: this.viewMode,
    };
  }
}
