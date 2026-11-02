/**
 * CodeMirror 6 host for one or more open documents.
 *
 * Responsibilities:
 * - keep one `EditorState` per tab (undo history survives tab switches),
 * - route document/selection updates into `DocumentSession` state,
 * - debounce autosave and run it through the same serial save chain as the
 *   manual save path,
 * - apply external-change decisions: clean docs reload, dirty docs conflict,
 *   deleted docs become missing, and saves are blocked in both cases.
 *
 * The integration layer mounts this into its own layout; this module never
 * touches the application shell, sidebar or preview.
 */

import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { history } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { closeSearchPanel, openSearchPanel, search } from '@codemirror/search';
import {
  Compartment,
  EditorSelection,
  EditorState,
  type Extension,
} from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  lineNumbers,
  placeholder as placeholderExtension,
  type ViewUpdate,
} from '@codemirror/view';
import type {
  DocumentChangeEvent,
  DocumentContent,
  DocumentState,
  ImageAsset,
  SaveDocumentResult,
  SaveImageRequest,
  WorkspaceRelativePath,
} from '../../../shared/contracts';
import type { IpcResult } from '../../../shared/ipc';
import { workspaceBasename } from '../../../shared/paths';
import { AutosaveDebouncer } from './autosave';
import { createEditorKeymap } from './keymap';
import {
  buildImageMarkdown,
  detectPastedImage,
  encodeBase64FromBuffer,
  pastedImageFileName,
  type PastedFileLike,
  type PastedImageMediaType,
} from './paste';
import { SerialQueue } from './queue';
import { clampSelection, DocumentSession } from './session';
import { EditorTabs } from './tabs';
import type {
  EditorHost,
  EditorHostOptions,
  EditorOpenDocument,
  EditorPersistenceFragment,
  EditorSaveOptions,
  EditorSaveOutcome,
  EditorTabInfo,
} from './types';

const DEFAULT_AUTOSAVE_DELAY_MS = 1_200;

interface PasteSaveInput {
  documentId: string;
  documentPath: string;
  file: PastedFileLike;
  mediaType: PastedImageMediaType;
  start: number;
  end: number;
  saveImage: (request: SaveImageRequest) => Promise<IpcResult<ImageAsset>>;
}

export class CodeMirrorEditorHost implements EditorHost {
  readonly view: EditorView;

  private readonly options: EditorHostOptions;
  private readonly sessions = new Map<string, DocumentSession>();
  private readonly states = new Map<string, EditorState>();
  private readonly queues = new Map<string, SerialQueue>();
  private readonly timers = new Map<string, AutosaveDebouncer>();
  private readonly tabs = new EditorTabs();
  private readonly readOnlyCompartment = new Compartment();
  private activeId: string | null = null;
  private readOnly: boolean;
  private autoSaveEnabled = true;
  private applyingRemote = false;
  private destroyed = false;

  constructor(options: EditorHostOptions) {
    this.options = options;
    this.readOnly = options.readOnly ?? false;
    this.view = new EditorView({
      state: EditorState.create({ doc: '', extensions: this.buildExtensions(true) }),
      parent: options.parent,
    });
  }

  open(document: EditorOpenDocument, options: { activate?: boolean } = {}): void {
    if (this.sessions.has(document.id)) {
      if (options.activate ?? true) this.activate(document.id);
      return;
    }
    const existing = this.tabs.findByPath(document.path);
    if (existing) {
      if (options.activate ?? true) this.activate(existing.id);
      return;
    }

    const session = new DocumentSession({
      id: document.id,
      path: document.path,
      markdown: document.markdown,
      baseHash: document.baseHash,
      diskHash: document.diskHash ?? document.baseHash,
      mtimeMs: document.mtimeMs ?? null,
      selection: document.selection ?? null,
      scrollTop: document.scrollTop ?? 0,
      viewMode: document.viewMode ?? 'edit',
      exportedSignature: document.exportedSignature ?? null,
    });

    this.sessions.set(session.id, session);
    this.states.set(session.id, this.createState(session.markdown, session.selection));
    this.queues.set(session.id, new SerialQueue());
    this.timers.set(session.id, this.createDebouncer(session.id));
    this.tabs.add(this.tabInfo(session));

    if (options.activate ?? true) this.activate(session.id);
    else this.emitState();
  }

  activate(id: string): boolean {
    const session = this.sessions.get(id);
    const state = this.states.get(id);
    if (!session || !state) return false;
    if (this.activeId === id) {
      this.view.focus();
      return true;
    }

    this.captureActiveViewState();
    this.activeId = id;
    this.applyState(state);
    this.view.scrollDOM.scrollTop = session.scrollTop;
    this.tabs.activate(id);
    this.emitState();
    this.view.focus();
    return true;
  }

  close(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    const wasActive = this.activeId === id;
    if (wasActive) this.captureActiveViewState();

    this.cancelTimer(id);
    this.timers.delete(id);
    this.queues.delete(id);
    this.states.delete(id);
    this.sessions.delete(id);
    const next = this.tabs.remove(id);

    if (wasActive) {
      this.activeId = null;
      if (next) this.activate(next);
      else this.setEmptyState();
    }
    this.emitState();
    return true;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  getTabs(): EditorTabInfo[] {
    this.captureActiveViewState();
    this.syncTabs();
    return this.tabs.list();
  }

  getDocumentState(id?: string): DocumentState | null {
    const documentId = id ?? this.activeId;
    if (!documentId) return null;
    if (documentId === this.activeId) this.captureActiveViewState();
    const session = this.sessions.get(documentId);
    return session ? session.toDocumentState() : null;
  }

  getPersistenceFragment(): EditorPersistenceFragment {
    this.captureActiveViewState();
    const tabs = this.tabs.list();
    const documentViews: EditorPersistenceFragment['documentViews'] = {};
    for (const tab of tabs) {
      const session = this.sessions.get(tab.id);
      if (session) documentViews[tab.path] = session.toViewState();
    }
    const active = this.activeId ? this.sessions.get(this.activeId) : undefined;
    return {
      openDocuments: tabs.map((tab) => tab.path),
      activeDocument: active?.path ?? null,
      documentViews,
    };
  }

  /**
   * Serial per document: autosave and manual save share this queue, so a
   * second save always observes the hash written by the first.
   */
  save(id?: string, options: EditorSaveOptions = {}): Promise<EditorSaveOutcome> {
    const documentId = id ?? this.activeId;
    if (!documentId) return Promise.resolve({ status: 'skipped', reason: 'no_document' });
    const session = this.sessions.get(documentId);
    if (!session) return Promise.resolve({ status: 'skipped', reason: 'no_document' });
    const queue = this.queues.get(documentId) ?? new SerialQueue();
    this.queues.set(documentId, queue);
    return queue.run(() => this.performSave(session, options));
  }

  async reload(id?: string): Promise<IpcResult<DocumentContent> | null> {
    const documentId = id ?? this.activeId;
    const session = documentId ? this.sessions.get(documentId) : undefined;
    if (!session) return null;

    const response = await this.options.read({ path: session.path });
    if (!response.ok) {
      if (response.error.code === 'not_found') {
        session.markMissing();
        this.cancelTimer(session.id);
        this.emitState();
      }
      this.options.onError?.(response.error, 'reload');
      return response;
    }
    this.applyReload(session, response.value);
    return response;
  }

  saveCopy(
    id: string | null,
    targetPath: WorkspaceRelativePath,
  ): Promise<IpcResult<SaveDocumentResult>> {
    const documentId = id ?? this.activeId;
    const session = documentId ? this.sessions.get(documentId) : undefined;
    if (!session) {
      return Promise.resolve({
        ok: false,
        error: { code: 'not_found', message: 'no open document to copy' },
      });
    }
    return this.options.saveCopy({
      documentId: session.id,
      path: session.path,
      targetPath,
      markdown: session.markdown,
    });
  }

  async applyExternalChange(change: DocumentChangeEvent): Promise<void> {
    const tab = this.tabs.findByPath(change.path);
    if (!tab) return;
    const session = this.sessions.get(tab.id);
    if (!session) return;

    const decision = session.applyExternalChange(change);
    if (decision === 'ignored') return;

    if (decision === 'conflict') {
      this.cancelTimer(session.id);
      this.emitState();
      return;
    }
    if (decision === 'deleted') {
      this.cancelTimer(session.id);
      this.emitState();
      return;
    }

    await this.reload(session.id);
  }

  setAutoSaveEnabled(enabled: boolean): void {
    this.autoSaveEnabled = enabled;
    if (!enabled) {
      for (const timer of this.timers.values()) timer.cancel();
      return;
    }
    for (const session of this.sessions.values()) {
      if (session.dirty && session.canSave()) this.scheduleAutosave(session.id);
    }
  }

  isAutoSaveEnabled(): boolean {
    return this.autoSaveEnabled;
  }

  setReadOnly(readOnly: boolean): void {
    if (this.readOnly === readOnly) return;
    this.readOnly = readOnly;
    const effect = this.readOnlyCompartment.reconfigure(this.readOnlyExtensions());
    for (const [id, state] of [...this.states]) {
      if (id === this.activeId) continue;
      this.states.set(id, state.update({ effects: effect }).state);
    }
    if (this.activeId) {
      this.view.dispatch({ effects: effect });
      this.states.set(this.activeId, this.view.state);
    }
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  openSearch(): boolean {
    if (!this.activeId) return false;
    return openSearchPanel(this.view);
  }

  closeSearch(): void {
    closeSearchPanel(this.view);
  }

  /**
   * Replaces `[start, end)` in the active tab and leaves the caret after the
   * inserted text. Offsets are clamped to the current document, so a stale
   * completion range or a paste that raced an edit can never throw.
   */
  insertText(text: string, start: number, end: number): boolean {
    const id = this.activeId;
    if (!id) return false;
    const session = this.sessions.get(id);
    if (!session || this.readOnly) return false;

    const length = this.view.state.doc.length;
    const from = Math.max(0, Math.min(length, Math.trunc(start)));
    const to = Math.max(from, Math.min(length, Math.trunc(end)));
    this.view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
    });
    this.view.focus();
    return true;
  }

  getActiveMarkdown(): string | null {
    const id = this.activeId;
    if (!id) return null;
    return this.sessions.get(id)?.markdown ?? null;
  }

  focus(): void {
    this.view.focus();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const timer of this.timers.values()) timer.cancel();
    this.timers.clear();
    this.sessions.clear();
    this.states.clear();
    this.queues.clear();
    this.view.destroy();
  }

  // -- save chain -----------------------------------------------------------

  private async performSave(
    session: DocumentSession,
    options: EditorSaveOptions,
  ): Promise<EditorSaveOutcome> {
    const automatic = options.automatic ?? false;
    if (session.conflict || session.missing) {
      this.cancelTimer(session.id);
      return { status: 'blocked', reason: session.conflict ? 'conflict' : 'missing' };
    }
    if (automatic && !session.dirty) return { status: 'skipped', reason: 'unchanged' };

    const snapshot = session.beginSave();
    if (!snapshot) return { status: 'blocked', reason: 'not_ready' };
    this.emitState();

    let response: IpcResult<SaveDocumentResult>;
    try {
      response = await this.options.save({
        documentId: session.id,
        path: session.path,
        markdown: snapshot.markdown,
        baseHash: snapshot.baseHash,
      });
    } catch {
      session.failSave('internal_error');
      this.emitState();
      return {
        status: 'failed',
        automatic,
        failure: { code: 'internal_error', message: 'save request failed' },
      };
    }

    if (response.ok) {
      session.completeSave(snapshot, response.value);
      this.emitState();
      // Edits made while the write was in flight are still dirty.
      if (session.dirty) this.scheduleAutosave(session.id);
      return { status: 'saved', result: response.value, automatic };
    }

    session.failSave(response.error.code);
    this.cancelTimer(session.id);
    this.emitState();
    this.options.onError?.(response.error, 'save');
    return { status: 'failed', failure: response.error, automatic };
  }

  private scheduleAutosave(id: string): void {
    if (!this.autoSaveEnabled || this.destroyed) return;
    const session = this.sessions.get(id);
    if (!session || !session.canSave()) return;
    this.timers.get(id)?.schedule();
  }

  private createDebouncer(id: string): AutosaveDebouncer {
    return new AutosaveDebouncer(
      this.options.autoSaveDelayMs ?? DEFAULT_AUTOSAVE_DELAY_MS,
      () => {
        void this.save(id, { automatic: true });
      },
    );
  }

  private cancelTimer(id: string): void {
    this.timers.get(id)?.cancel();
  }

  // -- CodeMirror wiring ----------------------------------------------------

  private buildExtensions(forceReadOnly = false): Extension[] {
    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      bracketMatching(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      markdown({ base: markdownLanguage, addKeymap: false }),
      EditorState.allowMultipleSelections.of(true),
      EditorState.tabSize.of(2),
      search({ top: true }),
      EditorView.lineWrapping,
      createEditorKeymap({ save: () => void this.save() }),
      this.readOnlyCompartment.of(this.readOnlyExtensions(forceReadOnly)),
      EditorView.updateListener.of((update) => {
        this.handleUpdate(update);
      }),
      EditorView.domEventHandlers({
        paste: (event) => this.handlePaste(event),
        compositionend: () => {
          this.handleCompositionEnd();
          return false;
        },
      }),
    ];
    if (this.options.placeholder) extensions.push(placeholderExtension(this.options.placeholder));
    return extensions;
  }

  private readOnlyExtensions(forceReadOnly = false): Extension {
    if (!this.readOnly && !forceReadOnly) return [];
    return [EditorState.readOnly.of(true), EditorView.editable.of(false)];
  }

  private createState(markdown: string, selection: { anchor: number; head: number } | null): EditorState {
    const clamped = clampSelection(selection, markdown.length);
    return EditorState.create({
      doc: markdown,
      selection: clamped ? EditorSelection.single(clamped.anchor, clamped.head) : undefined,
      extensions: this.buildExtensions(),
    });
  }

  private handleUpdate(update: ViewUpdate): void {
    if (this.destroyed || this.applyingRemote) return;
    const id = this.activeId;
    if (!id) return;
    const session = this.sessions.get(id);
    if (!session) return;

    let changed = false;
    if (update.docChanged) {
      session.setContent(update.state.doc.toString());
      this.states.set(id, update.state);
      this.scheduleAutosave(id);
      changed = true;
    }
    if (update.selectionSet) {
      session.setSelection(this.currentSelection());
      changed = true;
    }
    if (changed) this.emitState();
  }

  private handleCompositionEnd(): void {
    const id = this.activeId;
    if (!id) return;
    const session = this.sessions.get(id);
    if (session) session.setContent(this.view.state.doc.toString());
    this.scheduleAutosave(id);
    this.emitState();
  }

  // -- image paste ----------------------------------------------------------

  /**
   * Takes over the paste only for PNG/JPEG/GIF/WebP files. Bytes are stored
   * through `images.save` first; Markdown is inserted only after the main
   * process confirms the asset, so a failed save leaves the document untouched.
   */
  private handlePaste(event: ClipboardEvent): boolean {
    if ((event as Event & { isComposing?: boolean }).isComposing === true) return false;
    const data = event.clipboardData;
    if (!data) return false;

    const detection = detectPastedImage(Array.from(data.files ?? []));
    if (detection.kind === 'none') return false;

    event.preventDefault();
    if (detection.kind === 'svg') {
      this.options.onError?.({ code: 'invalid_request', message: detection.message }, 'paste');
      return true;
    }

    const id = this.activeId;
    const session = id ? this.sessions.get(id) : undefined;
    if (!id || !session) {
      this.options.onError?.({ code: 'not_found', message: '没有可插入图片的文档' }, 'paste');
      return true;
    }
    const saveImage = this.options.saveImage;
    if (!saveImage) {
      this.options.onError?.({ code: 'not_implemented', message: '图片保存接口不可用' }, 'paste');
      return true;
    }

    const { anchor, head } = this.view.state.selection.main;
    void this.savePastedImage({
      documentId: id,
      documentPath: session.path,
      file: detection.file,
      mediaType: detection.mediaType,
      start: Math.min(anchor, head),
      end: Math.max(anchor, head),
      saveImage,
    });
    return true;
  }

  private async savePastedImage(input: PasteSaveInput): Promise<void> {
    const reader = input.file.arrayBuffer;
    let buffer: ArrayBuffer;
    try {
      if (typeof reader !== 'function') throw new Error('clipboard image exposes no bytes');
      buffer = await reader.call(input.file);
    } catch {
      this.options.onError?.(
        { code: 'internal_error', message: '无法读取剪贴板图片内容' },
        'paste',
      );
      return;
    }
    if (buffer.byteLength === 0) {
      this.options.onError?.({ code: 'invalid_request', message: '剪贴板图片内容为空' }, 'paste');
      return;
    }

    let response: IpcResult<ImageAsset>;
    try {
      response = await input.saveImage({
        documentPath: input.documentPath,
        fileName: pastedImageFileName(input.mediaType, new Date()),
        mediaType: input.mediaType,
        dataBase64: encodeBase64FromBuffer(buffer),
      });
    } catch {
      this.options.onError?.(
        { code: 'internal_error', message: '图片保存请求失败' },
        'paste',
      );
      return;
    }
    if (!response.ok) {
      this.options.onError?.(response.error, 'paste');
      return;
    }

    const stillActive =
      this.activeId !== null && this.sessions.get(this.activeId)?.id === input.documentId;
    if (!stillActive) {
      this.options.onImageSaved?.(response.value, '');
      return;
    }
    const insertion = buildImageMarkdown(response.value.path, input.documentPath);
    this.insertText(insertion, input.start, input.end);
    this.options.onImageSaved?.(response.value, insertion);
  }

  private currentSelection(): { anchor: number; head: number } {
    const { anchor, head } = this.view.state.selection.main;
    return { anchor, head };
  }

  private captureActiveViewState(): void {
    const id = this.activeId;
    if (!id) return;
    const session = this.sessions.get(id);
    if (!session) return;
    session.setSelection(this.currentSelection());
    session.setScrollTop(this.view.scrollDOM.scrollTop);
    this.states.set(id, this.view.state);
  }

  private applyState(state: EditorState): void {
    this.applyingRemote = true;
    try {
      this.view.setState(state);
    } finally {
      this.applyingRemote = false;
    }
  }

  private setEmptyState(): void {
    this.applyState(EditorState.create({ doc: '', extensions: this.buildExtensions(true) }));
    this.view.scrollDOM.scrollTop = 0;
  }

  private applyReload(session: DocumentSession, content: DocumentContent): void {
    session.applyReload(content);
    const state = this.createState(session.markdown, session.selection);
    this.states.set(session.id, state);
    this.cancelTimer(session.id);
    if (this.activeId === session.id) {
      this.applyState(state);
      this.view.scrollDOM.scrollTop = session.scrollTop;
    }
    this.emitState();
  }

  private tabInfo(session: DocumentSession): EditorTabInfo {
    return {
      id: session.id,
      path: session.path,
      title: workspaceBasename(session.path),
      dirty: session.dirty,
      saving: session.saving,
      conflict: session.conflict,
      missing: session.missing,
      viewMode: session.viewMode,
    };
  }

  private syncTabs(): void {
    for (const session of this.sessions.values()) this.tabs.replace(this.tabInfo(session));
  }

  private emitState(): void {
    this.syncTabs();
    this.options.onStateChange?.(this.tabs.list(), this.activeId);
  }
}

export function mountEditor(options: EditorHostOptions): EditorHost {
  return new CodeMirrorEditorHost(options);
}
