/**
 * Composition root for the link UI.
 *
 * The integration layer creates one `LinkWorkspaceController` per window and
 * mounts the panels it needs. Nothing here touches the app shell, the editor or
 * the HTML render pipeline.
 */

import type { MarkdownLiteLinksApi } from '../../../shared/api';
import {
  mountBacklinksPanel,
  type BacklinksPanelController,
  type BacklinksPanelOptions,
} from './backlinks-panel';
import type { LinkIndexView } from './contracts';
import { mountGraphView, type GraphViewController, type GraphViewOptions } from './graph-view';
import { LinkStore } from './link-store';
import { createWikiLinkController, type WikiLinkController } from './wiki-link-controller';

export interface LinkWorkspaceOptions {
  /** Defaults to `window.markdownLite.links`. */
  api?: MarkdownLiteLinksApi;
  onOpenNote?: (path: string) => void;
  onMissingTarget?: (target: string) => void;
  onInsertLink?: (text: string, start: number, end: number) => void;
}

export interface LinkWorkspaceController {
  readonly store: LinkStore;
  readonly wikiLinks: WikiLinkController;
  mountBacklinks(
    host: HTMLElement,
    options?: Omit<BacklinksPanelOptions, 'store'>,
  ): BacklinksPanelController;
  mountGraph(
    host: HTMLElement,
    options?: Omit<GraphViewOptions, 'store'>,
  ): GraphViewController;
  /** Reloads the index from the main process and notifies subscribers. */
  refresh(): Promise<LinkIndexView>;
  /** Marks the cached index stale (call after save/rename/watcher events). */
  invalidate(): void;
  destroy(): void;
}

export function createLinkWorkspace(options: LinkWorkspaceOptions = {}): LinkWorkspaceController {
  const store = new LinkStore({ api: options.api });
  const wikiLinks = createWikiLinkController({
    store,
    onOpenNote: options.onOpenNote,
    onMissingTarget: options.onMissingTarget,
    onInsertLink: options.onInsertLink,
  });
  const mounted: Array<{ destroy(): void }> = [];

  return {
    store,
    wikiLinks,
    mountBacklinks(host, panelOptions = {}) {
      const controller = mountBacklinksPanel(host, {
        ...panelOptions,
        store,
        onOpenNote: panelOptions.onOpenNote ?? options.onOpenNote,
      });
      mounted.push(controller);
      return controller;
    },
    mountGraph(host, graphOptions = {}) {
      const controller = mountGraphView(host, {
        ...graphOptions,
        store,
        onOpenNote: graphOptions.onOpenNote ?? options.onOpenNote,
      });
      mounted.push(controller);
      return controller;
    },
    refresh() {
      return store.getIndex({ refresh: true });
    },
    invalidate() {
      store.invalidate();
    },
    destroy() {
      for (const controller of mounted.splice(0)) controller.destroy();
      wikiLinks.destroy();
      store.dispose();
    },
  };
}
