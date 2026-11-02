import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { app, ipcMain } from 'electron';
import type { AppInfo } from '../shared/contracts';
import type { IpcResult } from '../shared/ipc';
import { IPC_CHANNELS, ipcFail, ipcOk, type IpcChannel } from '../shared/ipc';
import {
  validateBacklinksRequest,
  validateCreateDocumentRequest,
  validateExportHtmlRequest,
  validateGetWorkspaceTreeRequest,
  validateGraphRequest,
  validateReadDocumentRequest,
  validateReadImageRequest,
  validateReloadDocumentRequest,
  validateRenameDocumentRequest,
  validateSaveDocumentCopyRequest,
  validateSaveDocumentRequest,
  validateSaveImageRequest,
  validateWorkspaceUiState,
  type Validation,
} from '../shared/validation';
import { AppError } from './errors';
import type { RuntimePaths } from './runtime-paths';
import { WorkspacePathGuardError } from './security/workspace-paths';
import type { Services } from './services';

type Handler<TRequest, TResponse> = (request: TRequest) => Promise<TResponse> | TResponse;

const noPayload = (): Validation<undefined> => ({ ok: true, value: undefined });

function buildAppInfo(runtime: RuntimePaths): AppInfo {
  return {
    name: app.getName(),
    version: app.getVersion(),
    environment: app.isPackaged ? 'production' : 'development',
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    runtimeDataDir: runtime.root,
    runtimeDataSource: runtime.source,
  };
}

/** Node filesystem errno codes worth surfacing with a readable IPC code. */
const ERRNO_FAILURES: Record<string, { code: 'forbidden' | 'too_large' | 'conflict'; message: string }> = {
  EPERM: { code: 'forbidden', message: 'file access denied' },
  EACCES: { code: 'forbidden', message: 'file access denied' },
  EROFS: { code: 'forbidden', message: 'file access denied' },
  ENOSPC: { code: 'too_large', message: 'not enough disk space' },
  EBUSY: { code: 'conflict', message: 'file is busy' },
};

function errnoCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function toFailure(error: unknown): IpcResult<never> {
  if (error instanceof AppError) {
    return ipcFail(error.code, error.message, error.details);
  }
  if (error instanceof WorkspacePathGuardError) {
    return ipcFail(error.code, error.message);
  }
  const errno = errnoCodeOf(error);
  if (errno !== null) {
    const mapping = ERRNO_FAILURES[errno];
    if (mapping !== undefined) return ipcFail(mapping.code, mapping.message, { reason: errno });
  }
  console.error('[ipc] unhandled handler error', error);
  return ipcFail('internal_error', 'unexpected internal error');
}

/**
 * Registers one channel. Every request is validated, every sender is checked,
 * and errors are converted to `IpcResult` instead of rejecting the invoke.
 */
export function registerIpcHandlers(
  services: Services,
  getWindow: () => BrowserWindow | null,
  runtime: RuntimePaths,
): void {
  function isTrustedSender(event: IpcMainInvokeEvent): boolean {
    const window = getWindow();
    if (!window || window.isDestroyed()) return false;
    if (event.sender !== window.webContents) return false;
    return event.senderFrame === event.sender.mainFrame;
  }

  function handle<TRequest, TResponse>(
    channel: IpcChannel,
    parse: (value: unknown) => Validation<TRequest>,
    handler: Handler<TRequest, TResponse>,
  ): void {
    ipcMain.handle(channel, async (event, raw: unknown): Promise<IpcResult<TResponse>> => {
      if (!isTrustedSender(event)) {
        return ipcFail('forbidden', 'IPC sender is not trusted');
      }
      const parsed = parse(raw);
      if (!parsed.ok) {
        return ipcFail('invalid_request', parsed.message);
      }
      try {
        return ipcOk(await handler(parsed.value));
      } catch (error) {
        return toFailure(error);
      }
    });
  }

  handle(IPC_CHANNELS.appInfo, noPayload, () => buildAppInfo(runtime));

  services.documents.setEventSink((change) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return;
    window.webContents.send(IPC_CHANNELS.documentExternalChange, change);
  });

  handle(IPC_CHANNELS.workspaceOpen, noPayload, async () => {
    const result = await services.workspace.open();
    services.documents.refreshWorkspace();
    return result;
  });
  /**
   * Reopens the last workspace without accepting a path from the renderer.
   *
   * Order is fixed: read persisted state, make the stored root active, restart
   * the watcher, then drop the stale link index. A root that no longer exists
   * surfaces the guard's `not_found` instead of a fake success.
   */
  handle(IPC_CHANNELS.workspaceRestore, noPayload, async () => {
    const state = await services.state.load();
    const root = state.workspaceRootPath;
    if (root === null) {
      return { cancelled: true, workspace: null };
    }
    const workspace = await services.workspace.setRoot(root);
    services.documents.refreshWorkspace();
    services.links.invalidate();
    return { cancelled: false, workspace };
  });
  handle(IPC_CHANNELS.workspaceTree, validateGetWorkspaceTreeRequest, (request) =>
    services.workspace.getTree(request),
  );
  handle(IPC_CHANNELS.workspaceClose, noPayload, () => {
    services.workspace.close();
    services.documents.shutdown();
    return undefined;
  });

  handle(IPC_CHANNELS.documentRead, validateReadDocumentRequest, (request) =>
    services.documents.read(request),
  );
  handle(IPC_CHANNELS.documentCreate, validateCreateDocumentRequest, (request) =>
    services.documents.create(request),
  );
  handle(IPC_CHANNELS.documentSave, validateSaveDocumentRequest, (request) =>
    services.documents.save(request),
  );
  handle(IPC_CHANNELS.documentSaveCopy, validateSaveDocumentCopyRequest, (request) =>
    services.documents.saveCopy(request),
  );
  handle(IPC_CHANNELS.documentReload, validateReloadDocumentRequest, (request) =>
    services.documents.reload(request),
  );
  handle(IPC_CHANNELS.documentRename, validateRenameDocumentRequest, (request) =>
    services.renames.rename(request),
  );

  handle(IPC_CHANNELS.imageSave, validateSaveImageRequest, (request) => services.images.save(request));
  handle(IPC_CHANNELS.imageRead, validateReadImageRequest, (request) => services.images.read(request));

  /** The picker owns the path; the renderer sends no payload at all. */
  handle(IPC_CHANNELS.backgroundChoose, noPayload, () => services.background.choose());

  handle(IPC_CHANNELS.exportHtml, validateExportHtmlRequest, (request) =>
    services.exporter.html(request),
  );

  handle(IPC_CHANNELS.stateLoad, noPayload, () => services.state.load());
  handle(IPC_CHANNELS.stateSave, validateWorkspaceUiState, (state) => services.state.save(state));

  handle(IPC_CHANNELS.linksIndex, noPayload, () => services.links.index());
  handle(IPC_CHANNELS.linksBacklinks, validateBacklinksRequest, (request) =>
    services.links.backlinks(request),
  );
  handle(IPC_CHANNELS.linksGraph, validateGraphRequest, (request) => services.links.graph(request));
}
