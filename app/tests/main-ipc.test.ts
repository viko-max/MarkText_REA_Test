import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { AppError } from '../src/main/errors';
import { registerIpcHandlers } from '../src/main/ipc';
import type { Services } from '../src/main/services';
import { DocumentService } from '../src/main/services/document-service';
import { LinkService } from '../src/main/services/link-service';
import { RenameCoordinator } from '../src/main/services/rename-coordinator';
import { StateService } from '../src/main/services/state-service';
import { WorkspaceService } from '../src/main/services/workspace-service';
import { WorkspacePathGuardError } from '../src/main/security/workspace-paths';
import type { RuntimePaths } from '../src/main/runtime-paths';
import type {
  OpenWorkspaceResult,
  RenameDocumentResult,
  WorkspaceTree,
  WorkspaceUiState,
} from '../src/shared/contracts';
import { createDefaultWorkspaceUiState } from '../src/shared/defaults';
import { IPC_CHANNELS, type IpcResult } from '../src/shared/ipc';
import { createTestWorkspace, type TestWorkspace } from './workspace-fixture';

type Handler = (event: unknown, payload: unknown) => Promise<unknown>;

const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  exposed: { current: null as unknown },
  invokes: [] as Array<{ channel: string; payload: unknown }>,
}));

vi.mock('electron', () => ({
  app: {
    getName: () => 'markdown-lite-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
  },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      electron.handlers.set(channel, handler);
    },
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  },
  contextBridge: {
    exposeInMainWorld: (_key: string, value: unknown) => {
      electron.exposed.current = value;
    },
  },
  ipcRenderer: {
    invoke: async (channel: string, payload: unknown) => {
      electron.invokes.push({ channel, payload });
      return { ok: true, value: null };
    },
    on: () => undefined,
    removeListener: () => undefined,
  },
}));

const NOW = '2026-11-02T10:00:00.000Z';
const created: TestWorkspace[] = [];

afterAll(async () => {
  await Promise.all(created.map((workspace) => workspace.cleanup()));
});

const runtime = {
  root: 'C:/runtime',
  source: 'env',
  userData: 'C:/runtime/user-data',
  sessionData: 'C:/runtime/session',
  logs: 'C:/runtime/logs',
  crashDumps: 'C:/runtime/crashes',
  temp: 'C:/runtime/temp',
  state: 'C:/runtime/state',
} as RuntimePaths;

const sender = { mainFrame: { frameId: 1 } };
const fakeWindow = {
  isDestroyed: () => false,
  webContents: sender,
} as unknown as BrowserWindow;
const trustedEvent = { sender, senderFrame: sender.mainFrame };
const untrustedEvent = {
  sender: { mainFrame: { frameId: 2 } },
  senderFrame: { frameId: 2 },
};

function register(services: Services): void {
  electron.handlers.clear();
  registerIpcHandlers(services, () => fakeWindow, runtime);
}

async function invoke<T>(
  channel: string,
  payload?: unknown,
  event: unknown = trustedEvent,
): Promise<IpcResult<T>> {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`channel is not registered: ${channel}`);
  return (await handler(event, payload)) as IpcResult<T>;
}

interface StubOptions {
  storedRoot: string | null;
  setRootError?: Error;
}

/** Recording stand-in for the services that `workspace:restore` touches. */
function createStub(options: StubOptions): { services: Services; calls: string[] } {
  const calls: string[] = [];
  const state = createDefaultWorkspaceUiState(options.storedRoot, NOW);
  const services = {
    workspace: {
      setRoot: async (root: string) => {
        calls.push(`setRoot:${root}`);
        if (options.setRootError) throw options.setRootError;
        return { rootPath: root, name: 'workspace', openedAt: NOW };
      },
    },
    documents: {
      setEventSink: () => undefined,
      refreshWorkspace: () => {
        calls.push('refreshWorkspace');
      },
      rename: async () => {
        calls.push('documents.rename');
        throw new Error('documents.rename must not be called directly');
      },
    },
    state: {
      load: async () => {
        calls.push('load');
        return state;
      },
    },
    links: {
      invalidate: () => {
        calls.push('invalidate');
      },
    },
    renames: {
      rename: async (request: unknown) => {
        calls.push(`renames.rename:${JSON.stringify(request)}`);
        return {
          path: '新.md',
          referenceEdits: [],
          skippedReferences: [],
          referencesDeferred: false,
        } satisfies RenameDocumentResult;
      },
    },
  } as unknown as Services;
  return { services, calls };
}

describe('workspace:restore channel', () => {
  it('uses the fixed channel name and takes no payload', async () => {
    expect(IPC_CHANNELS.workspaceRestore).toBe('workspace:restore');
    const { services } = createStub({ storedRoot: 'C:/notes' });
    register(services);
    expect(electron.handlers.has(IPC_CHANNELS.workspaceRestore)).toBe(true);
  });

  it('restores the stored root in the fixed order and ignores any renderer path', async () => {
    const { services, calls } = createStub({ storedRoot: 'C:/notes' });
    register(services);

    const injected = 'C:/Windows/System32';
    const result = await invoke<OpenWorkspaceResult>(IPC_CHANNELS.workspaceRestore, {
      rootPath: injected,
      path: injected,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        cancelled: false,
        workspace: { rootPath: 'C:/notes', name: 'workspace', openedAt: NOW },
      },
    });
    // State -> root -> watcher -> stale link index; the payload never appears.
    expect(calls).toEqual(['load', 'setRoot:C:/notes', 'refreshWorkspace', 'invalidate']);
  });

  it('reports a cancellation when no workspace root was stored', async () => {
    const { services, calls } = createStub({ storedRoot: null });
    register(services);

    const result = await invoke<OpenWorkspaceResult>(IPC_CHANNELS.workspaceRestore);

    expect(result).toEqual({ ok: true, value: { cancelled: true, workspace: null } });
    expect(calls).toEqual(['load']);
  });

  it('maps a vanished root to not_found instead of a fake success', async () => {
    const { services, calls } = createStub({
      storedRoot: 'C:/gone',
      setRootError: new WorkspacePathGuardError('not_found', 'workspace root does not exist'),
    });
    register(services);

    const result = await invoke<OpenWorkspaceResult>(IPC_CHANNELS.workspaceRestore);

    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(calls).toEqual(['load', 'setRoot:C:/gone']);
  });

  it('refuses senders other than the main window main frame', async () => {
    const { services, calls } = createStub({ storedRoot: 'C:/notes' });
    register(services);

    const result = await invoke<OpenWorkspaceResult>(
      IPC_CHANNELS.workspaceRestore,
      undefined,
      untrustedEvent,
    );

    expect(result).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(calls).toEqual([]);
  });
});

describe('workspace:restore over real services', () => {
  it('reopens the last workspace, refreshes documents and serves its tree', async () => {
    const workspace = await createTestWorkspace('restore');
    created.push(workspace);
    await mkdir(join(workspace.root, 'notes'), { recursive: true });
    await writeFile(join(workspace.root, 'notes', 'note.md'), '# Note\n', 'utf8');

    const workspaceService = new WorkspaceService(() => null);
    const documents = new DocumentService(workspaceService, { watch: false });
    const links = new LinkService(workspaceService);
    const state = new StateService(workspaceService, {
      stateDir: join(workspace.base, 'state'),
      now: () => new Date(NOW),
    });
    const services = {
      workspace: workspaceService,
      documents,
      state,
      links,
      renames: new RenameCoordinator(documents, links),
    } as unknown as Services;

    await workspaceService.setRoot(workspace.root);
    const canonicalRoot = workspaceService.current?.summary.rootPath;
    await state.save(createDefaultWorkspaceUiState(workspace.root, NOW));
    workspaceService.close();
    expect(workspaceService.current).toBeNull();

    const refresh = vi.spyOn(documents, 'refreshWorkspace');
    const invalidate = vi.spyOn(links, 'invalidate');
    register(services);

    const restored = await invoke<OpenWorkspaceResult>(IPC_CHANNELS.workspaceRestore);

    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.value.cancelled).toBe(false);
    expect(restored.value.workspace?.rootPath).toBe(canonicalRoot);
    expect(workspaceService.current?.summary.rootPath).toBe(canonicalRoot);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);

    const tree = await invoke<WorkspaceTree>(IPC_CHANNELS.workspaceTree, { path: '', depth: 2 });
    expect(tree.ok).toBe(true);
    if (!tree.ok) return;
    expect(tree.value.nodes.map((node) => node.name)).toEqual(['notes']);
  });

  it('reports a stored root that no longer exists', async () => {
    const workspace = await createTestWorkspace('restore-gone');
    created.push(workspace);
    await writeFile(join(workspace.root, 'note.md'), '# Note\n', 'utf8');

    const workspaceService = new WorkspaceService(() => null);
    const documents = new DocumentService(workspaceService, { watch: false });
    const links = new LinkService(workspaceService);
    const state = new StateService(workspaceService, {
      stateDir: join(workspace.base, 'state'),
      now: () => new Date(NOW),
    });
    const services = {
      workspace: workspaceService,
      documents,
      state,
      links,
      renames: new RenameCoordinator(documents, links),
    } as unknown as Services;

    await workspaceService.setRoot(workspace.root);
    await state.save(createDefaultWorkspaceUiState(workspace.root, NOW));
    workspaceService.close();
    await rm(workspace.root, { recursive: true, force: true });

    register(services);
    const restored = await invoke<OpenWorkspaceResult>(IPC_CHANNELS.workspaceRestore);

    expect(restored).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(workspaceService.current).toBeNull();
  });

  it('keeps the restored UI state available to the renderer', async () => {
    const workspace = await createTestWorkspace('restore-state');
    created.push(workspace);
    await writeFile(join(workspace.root, 'note.md'), '# Note\n', 'utf8');

    const workspaceService = new WorkspaceService(() => null);
    const documents = new DocumentService(workspaceService, { watch: false });
    const links = new LinkService(workspaceService);
    const state = new StateService(workspaceService, {
      stateDir: join(workspace.base, 'state'),
      now: () => new Date(NOW),
    });
    const services = {
      workspace: workspaceService,
      documents,
      state,
      links,
      renames: new RenameCoordinator(documents, links),
    } as unknown as Services;

    await workspaceService.setRoot(workspace.root);
    await state.save({
      ...createDefaultWorkspaceUiState(workspace.root, NOW),
      openDocuments: ['note.md'],
      activeDocument: 'note.md',
    });
    workspaceService.close();

    register(services);
    await invoke<OpenWorkspaceResult>(IPC_CHANNELS.workspaceRestore);
    const loaded = await invoke<WorkspaceUiState>(IPC_CHANNELS.stateLoad);

    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.workspaceRootPath).toBe(workspaceService.current?.summary.rootPath);
    expect(loaded.value.activeDocument).toBe('note.md');
  });
});

describe('preload bridge', () => {
  it('maps workspace.restore to the fixed channel without a payload', async () => {
    await import('../src/preload/index');
    const api = electron.exposed.current as {
      workspace: { restore(): Promise<unknown> };
    };
    expect(typeof api.workspace.restore).toBe('function');

    electron.invokes.length = 0;
    await api.workspace.restore();

    expect(electron.invokes).toEqual([
      { channel: IPC_CHANNELS.workspaceRestore, payload: undefined },
    ]);
  });
});

describe('filesystem errno mapping', () => {
  function createFailingService(error: unknown): Services {
    return {
      workspace: {},
      documents: {
        setEventSink: () => undefined,
        save: async () => {
          throw error;
        },
      },
      links: {},
      state: {},
      renames: {},
    } as unknown as Services;
  }

  function errno(code: string, message = code): Error {
    return Object.assign(new Error(message), { code });
  }

  async function saveFailure(error: unknown): Promise<IpcResult<unknown>> {
    register(createFailingService(error));
    return invoke(IPC_CHANNELS.documentSave, {
      documentId: 'doc-1',
      path: 'note.md',
      markdown: '# Note\n',
      baseHash: 'a'.repeat(64),
    });
  }

  it.each(['EPERM', 'EACCES', 'EROFS'])('reports %s as a readable forbidden failure', async (code) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await saveFailure(errno(code, `${code}: operation not permitted`));

    expect(result).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'file access denied', details: { reason: code } },
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('reports ENOSPC as a readable disk-space failure', async () => {
    const result = await saveFailure(errno('ENOSPC', 'ENOSPC: no space left on device'));

    expect(result).toEqual({
      ok: false,
      error: { code: 'too_large', message: 'not enough disk space', details: { reason: 'ENOSPC' } },
    });
  });

  it('reports EBUSY as a readable conflict', async () => {
    const result = await saveFailure(errno('EBUSY', 'EBUSY: resource busy or locked'));

    expect(result).toEqual({
      ok: false,
      error: { code: 'conflict', message: 'file is busy', details: { reason: 'EBUSY' } },
    });
  });

  it('keeps AppError and guard failures ahead of the generic internal error', async () => {
    const fromAppError = await saveFailure(new AppError('forbidden', 'workspace is read-only'));
    expect(fromAppError).toEqual({
      ok: false,
      error: { code: 'forbidden', message: 'workspace is read-only' },
    });

    const fromGuard = await saveFailure(
      new WorkspacePathGuardError('outside_workspace', 'path escapes the root'),
    );
    expect(fromGuard).toEqual({
      ok: false,
      error: { code: 'outside_workspace', message: 'path escapes the root' },
    });
  });

  it('still hides an unmapped error behind internal_error without detail leakage', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await saveFailure(errno('EWHATEVER', 'EWHATEVER: unknown failure'));

    expect(result).toEqual({
      ok: false,
      error: { code: 'internal_error', message: 'unexpected internal error' },
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });
});

describe('document:rename delegation', () => {
  it('routes the validated request through the rename coordinator', async () => {
    const { services, calls } = createStub({ storedRoot: 'C:/notes' });
    register(services);

    const result = await invoke<RenameDocumentResult>(IPC_CHANNELS.documentRename, {
      documentId: 'doc-7',
      fromPath: '旧.md',
      toPath: '新.md',
      updateReferences: true,
    });

    expect(result).toEqual({
      ok: true,
      value: { path: '新.md', referenceEdits: [], skippedReferences: [], referencesDeferred: false },
    });
    expect(calls).toEqual([
      `renames.rename:${JSON.stringify({
        documentId: 'doc-7',
        fromPath: '旧.md',
        toPath: '新.md',
        updateReferences: true,
      })}`,
    ]);
  });

  it('rejects an invalid rename request before reaching the coordinator', async () => {
    const { services, calls } = createStub({ storedRoot: 'C:/notes' });
    register(services);

    const result = await invoke<RenameDocumentResult>(IPC_CHANNELS.documentRename, {
      documentId: 'doc-7',
      fromPath: '旧.md',
      toPath: '旧.md',
      updateReferences: true,
    });

    expect(result).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
    expect(calls).toEqual([]);
  });
});
