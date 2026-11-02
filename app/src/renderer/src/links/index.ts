/**
 * Public entry point for the link feature.
 *
 * Integration recipe:
 * 1. `const links = createLinkWorkspace({ onOpenNote, onInsertLink })`.
 * 2. `const backlinks = links.mountBacklinks(container)` and call
 *    `backlinks.setActiveNote(path)` when the active document changes.
 * 3. `const graph = links.mountGraph(container, { getActiveNote })` and call
 *    `graph.setFocus(path)` alongside the backlinks panel.
 * 4. On editor input, call
 *    `links.wikiLinks.query({ text, caret, anchor })`; forward keydown to
 *    `links.wikiLinks.handleKeyDown(event)`; insert `accept()`'s replacement.
 * 5. Call `links.wikiLinks.decorate(previewContainer)` after rendering HTML and
 *    `links.invalidate()` after saves, renames or watcher events.
 */

export { createLinkWorkspace } from './link-workspace';
export type { LinkWorkspaceController, LinkWorkspaceOptions } from './link-workspace';

export { mountBacklinksPanel } from './backlinks-panel';
export type { BacklinksPanelController, BacklinksPanelOptions } from './backlinks-panel';

export { mountGraphView } from './graph-view';
export type { GraphViewOptions, GraphViewController } from './graph-view';

export { createWikiLinkController } from './wiki-link-controller';
export type {
  WikiLinkActivation,
  WikiLinkCompletionState,
  WikiLinkController,
  WikiLinkControllerOptions,
  WikiLinkInputContext,
} from './wiki-link-controller';

export { applyWikiLinkStates } from './wiki-link-state';
export { ensureLinkStyles } from './styles';
export { LinkApiError, LinkStore } from './link-store';
export type { LinkStoreListener, LinkStoreOptions } from './link-store';

export {
  buildCompletionInsertion,
  completeNotes,
  detectWikiLinkQuery,
} from './completion';
export type {
  WikiCompletionInsertion,
  WikiCompletionItem,
  WikiNoteSummary,
  WikiQuery,
} from './completion';

export {
  describeNotePaths,
  lookupWikiTarget,
  normalizeWikiTarget,
  uniqueTargetFor,
} from './lookup';
export type { NoteDescriptorView, WikiTargetLookup } from './lookup';

export type { LinkIndexView, LinkIndexWarningView, WikiLinkView } from './contracts';
