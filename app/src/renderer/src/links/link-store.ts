/**
 * Renderer-side cache and IPC access for the link domain.
 *
 * The store keeps one index in memory, de-duplicates concurrent loads, and
 * lets the integration layer invalidate it after saves, renames or watcher
 * events without knowing about IPC details.
 */

import type { MarkdownLiteLinksApi } from '../../../shared/api';
import type { BacklinkReport, LinkGraph } from '../../../shared/contracts';
import type { IpcResult } from '../../../shared/ipc';
import type { LinkIndexView } from './contracts';

export class LinkApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'LinkApiError';
    this.code = code;
  }
}

export interface LinkStoreOptions {
  /** Explicit API, mainly for tests. */
  api?: MarkdownLiteLinksApi;
  /** Lazy resolver; defaults to `globalThis.markdownLite.links`. */
  apiFactory?: () => MarkdownLiteLinksApi;
}

export type LinkStoreListener = (index: LinkIndexView | null) => void;

export class LinkStore {
  private readonly options: LinkStoreOptions;
  private cachedIndex: LinkIndexView | null = null;
  private indexRequest: Promise<LinkIndexView> | null = null;
  private readonly listeners = new Set<LinkStoreListener>();

  constructor(options: LinkStoreOptions = {}) {
    this.options = options;
  }

  async getIndex(options: { refresh?: boolean } = {}): Promise<LinkIndexView> {
    if (options.refresh) this.invalidate();
    if (this.cachedIndex) return this.cachedIndex;
    if (!this.indexRequest) {
      this.indexRequest = this.resolveApi()
        .index()
        .then((result) => unwrap(result))
        .then((index) => {
          const view: LinkIndexView = index;
          this.cachedIndex = view;
          this.notify(view);
          return view;
        })
        .finally(() => {
          this.indexRequest = null;
        });
    }
    return this.indexRequest;
  }

  async getBacklinks(path: string): Promise<BacklinkReport> {
    return unwrap(await this.resolveApi().backlinks({ path }));
  }

  async getGraph(focusPath: string | null, depth: number): Promise<LinkGraph> {
    return unwrap(await this.resolveApi().graph({ focusPath, depth }));
  }

  /** Drops the cached index so the next read re-enumerates the workspace. */
  invalidate(): void {
    this.cachedIndex = null;
    this.notify(null);
  }

  subscribe(listener: LinkStoreListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.cachedIndex = null;
    this.indexRequest = null;
    this.listeners.clear();
  }

  private resolveApi(): MarkdownLiteLinksApi {
    if (this.options.api) return this.options.api;
    if (this.options.apiFactory) return this.options.apiFactory();
    const scope = globalThis as { markdownLite?: { links?: MarkdownLiteLinksApi } };
    const links = scope.markdownLite?.links;
    if (links) return links;
    throw new LinkApiError('no_api', 'the Markdown Lite link API is not available');
  }

  private notify(index: LinkIndexView | null): void {
    for (const listener of [...this.listeners]) listener(index);
  }
}

function unwrap<T>(result: IpcResult<T>): T {
  if (!result.ok) throw new LinkApiError(result.error.code, result.error.message);
  return result.value;
}
