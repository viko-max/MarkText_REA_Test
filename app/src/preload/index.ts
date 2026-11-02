/**
 * The renderer's only privileged surface.
 *
 * There is intentionally no generic `send`/`invoke`/`on` bridge: each method
 * maps to one fixed channel, and the main process validates every payload.
 */
import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type {
  AppInfo,
  BacklinkReport,
  BacklinksRequest,
  ChooseBackgroundResult,
  CreateDocumentRequest,
  DocumentChangeEvent,
  DocumentContent,
  ExportHtmlRequest,
  ExportHtmlResult,
  GetWorkspaceTreeRequest,
  GraphRequest,
  ImageAsset,
  LinkGraph,
  LinkIndex,
  OpenWorkspaceResult,
  ReadDocumentRequest,
  ReadImageRequest,
  ReadImageResult,
  RenameDocumentRequest,
  RenameDocumentResult,
  SaveDocumentCopyRequest,
  SaveDocumentRequest,
  SaveDocumentResult,
  SaveImageRequest,
  WorkspaceTree,
  WorkspaceUiState,
} from '../shared/contracts';
import type { MarkdownLiteApi } from '../shared/api';
import { MARKDOWN_LITE_GLOBAL } from '../shared/api';
import type { IpcChannel, IpcResult } from '../shared/ipc';
import { IPC_CHANNELS } from '../shared/ipc';
import { validateDocumentChangeEvent } from '../shared/validation';

function invoke<T>(channel: IpcChannel, payload?: unknown): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<T>>;
}

const api: MarkdownLiteApi = {
  app: {
    getInfo: () => invoke<AppInfo>(IPC_CHANNELS.appInfo),
  },
  workspace: {
    open: () => invoke<OpenWorkspaceResult>(IPC_CHANNELS.workspaceOpen),
    restore: () => invoke<OpenWorkspaceResult>(IPC_CHANNELS.workspaceRestore),
    getTree: (request: GetWorkspaceTreeRequest) =>
      invoke<WorkspaceTree>(IPC_CHANNELS.workspaceTree, request),
    close: () => invoke<void>(IPC_CHANNELS.workspaceClose),
  },
  documents: {
    read: (request: ReadDocumentRequest) =>
      invoke<DocumentContent>(IPC_CHANNELS.documentRead, request),
    create: (request: CreateDocumentRequest) =>
      invoke<DocumentContent>(IPC_CHANNELS.documentCreate, request),
    save: (request: SaveDocumentRequest) =>
      invoke<SaveDocumentResult>(IPC_CHANNELS.documentSave, request),
    saveCopy: (request: SaveDocumentCopyRequest) =>
      invoke<SaveDocumentResult>(IPC_CHANNELS.documentSaveCopy, request),
    reload: (request: ReadDocumentRequest) =>
      invoke<DocumentContent>(IPC_CHANNELS.documentReload, request),
    rename: (request: RenameDocumentRequest) =>
      invoke<RenameDocumentResult>(IPC_CHANNELS.documentRename, request),
    onExternalChange: (listener: (change: DocumentChangeEvent) => void) => {
      const handler = (_event: IpcRendererEvent, payload: unknown): void => {
        const parsed = validateDocumentChangeEvent(payload);
        if (parsed.ok) listener(parsed.value);
      };
      ipcRenderer.on(IPC_CHANNELS.documentExternalChange, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.documentExternalChange, handler);
      };
    },
  },
  images: {
    save: (request: SaveImageRequest) => invoke<ImageAsset>(IPC_CHANNELS.imageSave, request),
    read: (request: ReadImageRequest) => invoke<ReadImageResult>(IPC_CHANNELS.imageRead, request),
  },
  background: {
    choose: () => invoke<ChooseBackgroundResult>(IPC_CHANNELS.backgroundChoose),
  },
  export: {
    html: (request: ExportHtmlRequest) =>
      invoke<ExportHtmlResult>(IPC_CHANNELS.exportHtml, request),
  },
  state: {
    load: () => invoke<WorkspaceUiState>(IPC_CHANNELS.stateLoad),
    save: (state: WorkspaceUiState) => invoke<void>(IPC_CHANNELS.stateSave, state),
  },
  links: {
    index: () => invoke<LinkIndex>(IPC_CHANNELS.linksIndex),
    backlinks: (request: BacklinksRequest) =>
      invoke<BacklinkReport>(IPC_CHANNELS.linksBacklinks, request),
    graph: (request: GraphRequest) => invoke<LinkGraph>(IPC_CHANNELS.linksGraph, request),
  },
};

contextBridge.exposeInMainWorld(MARKDOWN_LITE_GLOBAL, Object.freeze(api));
