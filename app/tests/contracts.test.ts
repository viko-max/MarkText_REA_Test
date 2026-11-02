import { describe, expect, it } from 'vitest';
import type { DocumentState, LinkGraph, WorkspaceTree } from '../src/shared/contracts';
import { createDefaultWorkspaceUiState } from '../src/shared/defaults';
import { IPC_CHANNELS, IPC_CHANNEL_LIST, ipcFail, ipcOk } from '../src/shared/ipc';
import { MARKDOWN_LITE_GLOBAL } from '../src/shared/api';
import { validateWorkspaceUiState } from '../src/shared/validation';

describe('IPC registry', () => {
  it('exposes a frozen, unique channel list', () => {
    expect(Object.isFrozen(IPC_CHANNEL_LIST)).toBe(true);
    expect(new Set(IPC_CHANNEL_LIST).size).toBe(IPC_CHANNEL_LIST.length);
    expect(IPC_CHANNEL_LIST).toHaveLength(Object.keys(IPC_CHANNELS).length);
  });

  it('uses namespaced channel names', () => {
    for (const channel of IPC_CHANNEL_LIST) {
      expect(channel).toMatch(/^[a-z]+:[a-z]+$/);
    }
  });

  it('keeps the renderer global name stable', () => {
    expect(MARKDOWN_LITE_GLOBAL).toBe('markdownLite');
  });
});

describe('IpcResult helpers', () => {
  it('wraps success values', () => {
    expect(ipcOk(42)).toEqual({ ok: true, value: 42 });
  });

  it('wraps failures with a stable code', () => {
    expect(ipcFail('no_workspace', 'no workspace is open')).toEqual({
      ok: false,
      error: { code: 'no_workspace', message: 'no workspace is open' },
    });
  });

  it('keeps optional details', () => {
    expect(ipcFail('conflict', 'file changed', { path: 'a.md' })).toMatchObject({
      error: { code: 'conflict', details: { path: 'a.md' } },
    });
  });
});

describe('shared contracts', () => {
  it('describes a document state and a workspace tree', () => {
    const document: DocumentState = {
      id: 'doc-1',
      path: 'notes/a.md',
      markdown: '# a\n',
      baseHash: 'a'.repeat(64),
      diskHash: 'a'.repeat(64),
      mtimeMs: 1_700_000_000_000,
      dirty: false,
      saving: false,
      conflict: false,
      missing: false,
      selection: { anchor: 0, head: 0 },
      scrollTop: 0,
      viewMode: 'edit',
      exportedSignature: null,
    };
    expect(document.path).toBe('notes/a.md');
    expect(document.dirty).toBe(false);
  });

  it('describes a workspace tree with lazy children', () => {
    const tree: WorkspaceTree = {
      workspace: { rootPath: 'C:/workspace', name: 'workspace', openedAt: '2026-11-02T00:00:00.000Z' },
      path: '',
      nodes: [
        { kind: 'directory', name: 'notes', path: 'notes', children: null, size: null, mtimeMs: null },
      ],
      truncated: false,
      scannedAt: '2026-11-02T00:00:00.000Z',
    };
    expect(tree.nodes[0]?.children).toBeNull();
  });

  it('describes a link graph built only from notes and links', () => {
    const graph: LinkGraph = {
      generatedAt: '2026-11-02T00:00:00.000Z',
      focusPath: null,
      nodes: [{ id: 'notes/a.md', label: 'a', kind: 'note', inDegree: 0, outDegree: 1 }],
      edges: [
        {
          id: 'notes/a.md->notes/b.md',
          source: 'notes/a.md',
          target: 'notes/b.md',
          count: 1,
          resolution: 'resolved',
        },
      ],
    };
    expect(graph.edges[0]?.resolution).toBe('resolved');
  });

  it('produces a valid default persisted state', () => {
    const state = createDefaultWorkspaceUiState(null);
    const result = validateWorkspaceUiState(state);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.theme.customVariables).toEqual({});
      expect(result.value.layout.sidebar.visible).toBe(true);
    }
  });
});
