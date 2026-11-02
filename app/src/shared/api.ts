/**
 * The typed surface exposed to the renderer as `window.markdownLite`.
 *
 * This is the only bridge between the sandboxed renderer and the main process.
 * Adding a method requires a channel in `./ipc.ts` and a validated handler in
 * `src/main/ipc.ts`; nothing generic is ever exposed.
 */

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
} from './contracts';
import type { IpcResult } from './ipc';

export interface MarkdownLiteAppApi {
  getInfo(): Promise<IpcResult<AppInfo>>;
}

export interface MarkdownLiteWorkspaceApi {
  /** Shows the native folder picker; no path is accepted from the renderer. */
  open(): Promise<IpcResult<OpenWorkspaceResult>>;
  /**
   * Reopens the workspace root stored in the persisted UI state. Takes no
   * argument, so the renderer can never inject an absolute path.
   */
  restore(): Promise<IpcResult<OpenWorkspaceResult>>;
  getTree(request: GetWorkspaceTreeRequest): Promise<IpcResult<WorkspaceTree>>;
  close(): Promise<IpcResult<void>>;
}

export interface MarkdownLiteDocumentsApi {
  read(request: ReadDocumentRequest): Promise<IpcResult<DocumentContent>>;
  create(request: CreateDocumentRequest): Promise<IpcResult<DocumentContent>>;
  save(request: SaveDocumentRequest): Promise<IpcResult<SaveDocumentResult>>;
  /** Writes the buffer to a new file; the original document is untouched. */
  saveCopy(request: SaveDocumentCopyRequest): Promise<IpcResult<SaveDocumentResult>>;
  reload(request: ReadDocumentRequest): Promise<IpcResult<DocumentContent>>;
  rename(request: RenameDocumentRequest): Promise<IpcResult<RenameDocumentResult>>;
  /**
   * Subscribes to main-process watcher events for external file changes.
   * Returns an unsubscribe function.
   */
  onExternalChange(listener: (change: DocumentChangeEvent) => void): () => void;
}

export interface MarkdownLiteImagesApi {
  save(request: SaveImageRequest): Promise<IpcResult<ImageAsset>>;
  /** Returns image bytes as base64 for preview and single-file export. */
  read(request: ReadImageRequest): Promise<IpcResult<ReadImageResult>>;
}

export interface MarkdownLiteBackgroundApi {
  /**
   * Shows the native image picker and returns the chosen wallpaper as a data
   * URI. Takes no argument: the renderer can never supply or learn a path.
   */
  choose(): Promise<IpcResult<ChooseBackgroundResult>>;
}

export interface MarkdownLiteExportApi {
  html(request: ExportHtmlRequest): Promise<IpcResult<ExportHtmlResult>>;
}

export interface MarkdownLiteStateApi {
  load(): Promise<IpcResult<WorkspaceUiState>>;
  save(state: WorkspaceUiState): Promise<IpcResult<void>>;
}

export interface MarkdownLiteLinksApi {
  index(): Promise<IpcResult<LinkIndex>>;
  backlinks(request: BacklinksRequest): Promise<IpcResult<BacklinkReport>>;
  graph(request: GraphRequest): Promise<IpcResult<LinkGraph>>;
}

export interface MarkdownLiteApi {
  readonly app: MarkdownLiteAppApi;
  readonly workspace: MarkdownLiteWorkspaceApi;
  readonly documents: MarkdownLiteDocumentsApi;
  readonly images: MarkdownLiteImagesApi;
  readonly background: MarkdownLiteBackgroundApi;
  readonly export: MarkdownLiteExportApi;
  readonly state: MarkdownLiteStateApi;
  readonly links: MarkdownLiteLinksApi;
}

/** Global augmentation key; the preload script owns this object. */
export const MARKDOWN_LITE_GLOBAL = 'markdownLite' as const;
