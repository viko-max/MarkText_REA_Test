/**
 * Wiki-link interaction controller.
 *
 * Provides, without touching the app shell:
 * - completion popup for an unfinished `[[...]]` (keyboard + mouse);
 * - jumping to a resolved note;
 * - an explicit candidate chooser for ambiguous same-name targets;
 * - a missing-target notice and callback.
 *
 * The editor integration calls `query({ text, caret, anchor })` on input,
 * forwards keydown events to `handleKeyDown`, and performs the text
 * replacement returned by `accept()` through `onInsertLink`.
 */

import type { LinkResolution } from '../../../shared/contracts';
import {
  buildCompletionInsertion,
  completeNotes,
  detectWikiLinkQuery,
  type WikiCompletionItem,
  type WikiNoteSummary,
  type WikiQuery,
} from './completion';
import type { LinkIndexView } from './contracts';
import { LinkStore } from './link-store';
import { describeNotePaths, lookupWikiTarget, stemOf } from './lookup';
import { ensureLinkStyles, LINK_CLASSES } from './styles';
import { applyWikiLinkStates } from './wiki-link-state';

export interface WikiLinkInputContext {
  /** Text of the editor document (or current line); caret is relative to it. */
  text: string;
  /** Caret offset inside `text`. */
  caret: number;
  /** Viewport position for the popup, usually the caret rectangle. */
  anchor?: { left: number; top: number };
}

export interface WikiLinkCompletionState {
  query: string;
  items: WikiCompletionItem[];
  selectedIndex: number;
  /** Offsets of the whole `[[...]]` expression in the editor text. */
  start: number;
  end: number;
}

export interface WikiLinkActivation {
  target: string;
  resolution: LinkResolution;
  resolvedPath: string | null;
  candidates: string[];
}

export interface WikiLinkControllerOptions {
  store: LinkStore;
  /** Element that receives the popup; defaults to `document.body`. */
  host?: HTMLElement;
  maxResults?: number;
  onOpenNote?: (path: string) => void;
  onMissingTarget?: (target: string) => void;
  onInsertLink?: (text: string, start: number, end: number) => void;
}

export interface WikiLinkController {
  /** Opens/updates completion for the caret; `null` closes it. */
  query(context: WikiLinkInputContext): Promise<WikiLinkCompletionState | null>;
  getCompletion(): WikiLinkCompletionState | null;
  /** Returns true when the event was consumed by the popup. */
  handleKeyDown(event: KeyboardEvent): boolean;
  select(index: number): void;
  /** Accepts the selected completion and returns the replacement range. */
  accept(): { text: string; start: number; end: number } | null;
  /** Resolves and opens a target, asks for a candidate, or reports missing. */
  activate(target: string): Promise<WikiLinkActivation>;
  /** Delegated click handling for `[data-wikilink-target]` elements. */
  attach(container: HTMLElement): () => void;
  /** Adds resolved/ambiguous/missing classes to rendered wiki links. */
  decorate(container: HTMLElement): Promise<void>;
  close(): void;
  destroy(): void;
}

interface Runtime {
  query: WikiQuery;
  notes: WikiNoteSummary[];
  state: WikiLinkCompletionState;
}

export function createWikiLinkController(options: WikiLinkControllerOptions): WikiLinkController {
  const store = options.store;
  const maxResults = options.maxResults ?? 8;
  const host = options.host ?? document.body;
  const doc = host.ownerDocument;
  ensureLinkStyles(doc);

  let runtime: Runtime | null = null;
  let requestToken = 0;
  let anchor: { left: number; top: number } | null = null;
  let list: HTMLUListElement | null = null;
  let popover: HTMLDivElement | null = null;
  const detachers = new Set<() => void>();

  function ensureList(): HTMLUListElement {
    if (list) return list;
    list = doc.createElement('ul');
    list.className = LINK_CLASSES.completion;
    list.id = 'mdl-wikilink-completion';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', '笔记补全');
    list.hidden = true;
    host.appendChild(list);
    return list;
  }

  function ensurePopover(): HTMLDivElement {
    if (popover) return popover;
    popover = doc.createElement('div');
    popover.className = LINK_CLASSES.popover;
    popover.setAttribute('role', 'dialog');
    popover.hidden = true;
    host.appendChild(popover);
    return popover;
  }

  function place(element: HTMLElement): void {
    if (!anchor) return;
    element.style.left = `${Math.round(anchor.left)}px`;
    element.style.top = `${Math.round(anchor.top)}px`;
  }

  function renderCompletion(): void {
    if (!runtime) return;
    const element = ensureList();
    place(element);
    element.replaceChildren();
    const { state } = runtime;

    for (const [index, item] of state.items.entries()) {
      const row = doc.createElement('li');
      row.className = LINK_CLASSES.completionItem;
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(index === state.selectedIndex));

      const title = doc.createElement('span');
      title.className = 'mdl-completion-title';
      title.textContent = item.title;

      const detail = doc.createElement('span');
      detail.className = 'mdl-completion-detail';
      detail.textContent = item.detail;

      row.append(title, detail);
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        acceptAt(index);
      });
      element.append(row);
    }

    element.hidden = state.items.length === 0;
  }

  function updateSelection(): void {
    if (!runtime || !list) return;
    const rows = list.children;
    for (let index = 0; index < rows.length; index += 1) {
      rows[index]?.setAttribute('aria-selected', String(index === runtime.state.selectedIndex));
    }
    list.children[runtime.state.selectedIndex]?.scrollIntoView?.({ block: 'nearest' });
  }

  function showPopoverContent(
    titleText: string,
    body: HTMLElement,
    hint?: string,
  ): void {
    const element = ensurePopover();
    place(element);
    element.replaceChildren();

    const title = doc.createElement('p');
    title.className = 'mdl-link-popover-title';
    title.textContent = titleText;
    element.append(title, body);

    if (hint) {
      const hintElement = doc.createElement('p');
      hintElement.className = 'mdl-link-popover-hint';
      hintElement.textContent = hint;
      element.append(hintElement);
    }
    element.hidden = false;
  }

  function showChooser(candidates: readonly string[], index: LinkIndexView): void {
    const titles = new Map(index.documents.map((document) => [document.path, document.title]));
    const listElement = doc.createElement('ul');
    listElement.className = 'mdl-link-popover-list';

    for (const path of candidates) {
      const item = doc.createElement('li');
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'mdl-link-popover-option';
      button.textContent = `${titles.get(path) ?? stemOf(path)} — ${path}`;
      button.addEventListener('click', () => {
        options.onOpenNote?.(path);
        close();
      });
      item.append(button);
      listElement.append(item);
    }

    showPopoverContent('选择同名笔记', listElement, '存在多篇同名笔记，请选择要打开的一篇。');
  }

  function showMissing(target: string): void {
    const body = doc.createElement('p');
    body.className = 'mdl-link-popover-hint';
    body.textContent = `没有找到「${target}」对应的笔记。`;
    showPopoverContent('未找到笔记', body, '可以检查路径，或先创建这篇笔记。');
  }

  function acceptAt(index: number): { text: string; start: number; end: number } | null {
    if (!runtime) return null;
    const item = runtime.state.items[index];
    if (!item) return null;
    const insertion = buildCompletionInsertion(runtime.query, item, runtime.notes);
    options.onInsertLink?.(insertion.text, insertion.start, insertion.end);
    close();
    return insertion;
  }

  function close(): void {
    runtime = null;
    if (list) {
      list.hidden = true;
      list.replaceChildren();
    }
    if (popover) {
      popover.hidden = true;
      popover.replaceChildren();
    }
  }

  const controller: WikiLinkController = {
    async query(context) {
      const token = (requestToken += 1);
      const parsed = detectWikiLinkQuery(context.text, context.caret);
      if (!parsed) {
        close();
        return null;
      }
      if (context.anchor) anchor = context.anchor;

      let index: LinkIndexView;
      try {
        index = await store.getIndex();
      } catch (error) {
        console.warn('[links] completion is unavailable', error);
        close();
        return null;
      }
      if (token !== requestToken) return null;

      const notes: WikiNoteSummary[] = index.documents.map((document) => ({
        path: document.path,
        title: document.title,
      }));
      const items = completeNotes(notes, parsed.query, maxResults);
      const state: WikiLinkCompletionState = {
        query: parsed.query,
        items,
        selectedIndex: items.length > 0 ? 0 : -1,
        start: parsed.start,
        end: parsed.end,
      };
      runtime = { query: parsed, notes, state };
      renderCompletion();
      return state;
    },

    getCompletion() {
      return runtime?.state ?? null;
    },

    handleKeyDown(event) {
      if (event.key === 'Escape') {
        const wasOpen = runtime !== null || (popover?.hidden === false);
        close();
        if (wasOpen) event.preventDefault();
        return wasOpen;
      }
      if (!runtime || runtime.state.items.length === 0) return false;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        controller.select(runtime.state.selectedIndex + 1);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        controller.select(runtime.state.selectedIndex - 1);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        controller.accept();
        return true;
      }
      return false;
    },

    select(index) {
      if (!runtime) return;
      const last = runtime.state.items.length - 1;
      if (last < 0) return;
      runtime.state.selectedIndex = Math.max(0, Math.min(index, last));
      updateSelection();
    },

    accept() {
      if (!runtime) return null;
      return acceptAt(runtime.state.selectedIndex);
    },

    async activate(target) {
      const index = await store.getIndex();
      const notes = describeNotePaths(index.documents.map((document) => document.path));
      const lookup = lookupWikiTarget(target, notes);
      const activation: WikiLinkActivation = {
        target,
        resolution: lookup.resolution,
        resolvedPath: lookup.resolvedPath,
        candidates: lookup.candidates,
      };

      if (lookup.resolution === 'resolved' && lookup.resolvedPath !== null) {
        close();
        options.onOpenNote?.(lookup.resolvedPath);
      } else if (lookup.resolution === 'ambiguous') {
        showChooser(lookup.candidates, index);
      } else {
        showMissing(target);
        options.onMissingTarget?.(target);
      }
      return activation;
    },

    attach(container) {
      const handler = (event: Event): void => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const element = target.closest('[data-wikilink-target]');
        if (!(element instanceof HTMLElement) || !container.contains(element)) return;
        const value = element.dataset.wikilinkTarget ?? '';
        if (value.trim().length === 0) return;
        event.preventDefault();
        void controller.activate(value).catch((error: unknown) => {
          console.warn('[links] could not activate wiki link', error);
        });
      };
      container.addEventListener('click', handler);
      const detach = (): void => {
        container.removeEventListener('click', handler);
        detachers.delete(detach);
      };
      detachers.add(detach);
      return detach;
    },

    async decorate(container) {
      const index = await store.getIndex();
      applyWikiLinkStates(container, index);
    },

    close,

    destroy() {
      requestToken += 1;
      close();
      for (const detach of [...detachers]) detach();
      detachers.clear();
      list?.remove();
      popover?.remove();
      list = null;
      popover = null;
    },
  };

  return controller;
}
