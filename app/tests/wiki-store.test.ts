import { describe, expect, it, vi } from 'vitest';
import type { MarkdownLiteLinksApi } from '../src/shared/api';
import type { BacklinkReport, LinkGraph } from '../src/shared/contracts';
import { ipcFail, ipcOk } from '../src/shared/ipc';
import type { LinkIndexView } from '../src/renderer/src/links/contracts';
import { LinkApiError, LinkStore } from '../src/renderer/src/links/link-store';

function makeIndex(generatedAt: string): LinkIndexView {
  return {
    workspaceRootPath: '/workspace',
    generatedAt,
    documents: [
      {
        path: '笔记.md',
        title: '我的笔记',
        outboundCount: 1,
        inboundCount: 0,
        missingOutboundCount: 0,
      },
    ],
    links: [],
  };
}

const BACKLINKS: BacklinkReport = {
  targetPath: '笔记.md',
  backlinks: [{ sourcePath: '首页.md', sourceTitle: '首页', occurrences: 2 }],
  ambiguousSources: [],
};

const GRAPH: LinkGraph = {
  generatedAt: 't',
  focusPath: '笔记.md',
  nodes: [{ id: '笔记.md', label: '我的笔记', kind: 'note', inDegree: 0, outDegree: 0 }],
  edges: [],
};

function makeApi(overrides: Partial<MarkdownLiteLinksApi> = {}) {
  const api: MarkdownLiteLinksApi = {
    index: vi.fn(async () => ipcOk(makeIndex('t1'))),
    backlinks: vi.fn(async () => ipcOk(BACKLINKS)),
    graph: vi.fn(async () => ipcOk(GRAPH)),
    ...overrides,
  };
  return api;
}

describe('renderer link store', () => {
  it('loads the index once and de-duplicates concurrent reads', async () => {
    const api = makeApi();
    const store = new LinkStore({ api });

    const [first, second] = await Promise.all([store.getIndex(), store.getIndex()]);
    const third = await store.getIndex();

    expect(first.generatedAt).toBe('t1');
    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(api.index).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cache and can force a refresh', async () => {
    const api = makeApi();
    const store = new LinkStore({ api });
    const listener = vi.fn();
    store.subscribe(listener);

    await store.getIndex();
    await store.getIndex({ refresh: true });
    store.invalidate();
    await store.getIndex();

    expect(api.index).toHaveBeenCalledTimes(3);
    expect(listener).toHaveBeenCalledWith(null);
  });

  it('forwards backlink and graph requests', async () => {
    const api = makeApi();
    const store = new LinkStore({ api });

    expect(await store.getBacklinks('笔记.md')).toEqual(BACKLINKS);
    expect(await store.getGraph('笔记.md', 2)).toEqual(GRAPH);
    expect(api.backlinks).toHaveBeenCalledWith({ path: '笔记.md' });
    expect(api.graph).toHaveBeenCalledWith({ focusPath: '笔记.md', depth: 2 });
  });

  it('surfaces IPC failures as LinkApiError', async () => {
    const api = makeApi({
      index: vi.fn(async () => ipcFail('no_workspace', 'no workspace is open')),
    });
    const store = new LinkStore({ api });

    await expect(store.getIndex()).rejects.toBeInstanceOf(LinkApiError);
    await expect(store.getIndex()).rejects.toMatchObject({ code: 'no_workspace' });
  });

  it('reports no_api in Node when no global bridge exists', async () => {
    // `tsconfig.node.json` has no DOM lib: resolving the API must not touch
    // `window`, and absence must still surface as the stable `no_api` code.
    const store = new LinkStore();

    await expect(store.getIndex()).rejects.toBeInstanceOf(LinkApiError);
    await expect(store.getIndex()).rejects.toMatchObject({
      code: 'no_api',
      message: 'the Markdown Lite link API is not available',
    });
  });

  it('unsubscribes listeners and clears them on dispose', async () => {
    const api = makeApi();
    const store = new LinkStore({ api });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    await store.getIndex();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    store.invalidate();
    expect(listener).toHaveBeenCalledTimes(1);

    store.dispose();
    await store.getIndex();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
