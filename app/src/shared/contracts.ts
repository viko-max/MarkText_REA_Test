/**
 * Domain contracts shared by main, preload and renderer.
 *
 * Type-only: this module must stay free of Node and Electron imports so the
 * renderer can use it. Paths crossing the IPC boundary are always
 * workspace-relative POSIX paths (`WorkspaceRelativePath`). Absolute paths are
 * only ever produced by the main process for display purposes.
 */

/** Workspace-relative POSIX path, e.g. `notes/ideas/graph.md`. */
export type WorkspaceRelativePath = string;

export type DocumentId = string;

/** ISO-8601 timestamp with milliseconds, produced by the main process. */
export type IsoTimestamp = string;

/** Lower-case hex SHA-256 of the UTF-8 document bytes. */
export type ContentHash = string;

export type ViewMode = 'edit' | 'preview' | 'split' | 'html';

export interface TextSelection {
  anchor: number;
  head: number;
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

export type WorkspaceNodeKind = 'file' | 'directory';

export interface WorkspaceNode {
  kind: WorkspaceNodeKind;
  name: string;
  path: WorkspaceRelativePath;
  /** `null` when children were not loaded (lazy tree) or for files. */
  children: WorkspaceNode[] | null;
  size: number | null;
  mtimeMs: number | null;
}

export interface WorkspaceSummary {
  /** Absolute host path; display only, never accepted as an IPC input. */
  rootPath: string;
  name: string;
  openedAt: IsoTimestamp;
}

export interface OpenWorkspaceResult {
  cancelled: boolean;
  workspace: WorkspaceSummary | null;
}

export interface GetWorkspaceTreeRequest {
  /** Directory to list, relative to the workspace root; `''` means the root. */
  path: WorkspaceRelativePath;
  depth: number;
}

export interface WorkspaceTree {
  workspace: WorkspaceSummary;
  /** Relative path of the directory this subtree describes; `''` for the root. */
  path: WorkspaceRelativePath;
  nodes: WorkspaceNode[];
  truncated: boolean;
  scannedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface DocumentState {
  id: DocumentId;
  path: WorkspaceRelativePath;
  markdown: string;
  /** Hash captured when the buffer was loaded or last saved; CAS basis. */
  baseHash: ContentHash | null;
  /** Hash of the bytes currently believed to be on disk. */
  diskHash: ContentHash | null;
  mtimeMs: number | null;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  missing: boolean;
  selection: TextSelection | null;
  scrollTop: number;
  viewMode: ViewMode;
  /** Render signature that was last written to an HTML export file. */
  exportedSignature: string | null;
}

export interface ReadDocumentRequest {
  path: WorkspaceRelativePath;
}

export interface DocumentContent {
  path: WorkspaceRelativePath;
  markdown: string;
  hash: ContentHash;
  mtimeMs: number;
  size: number;
}

export interface CreateDocumentRequest {
  /** Parent directory relative to the workspace root; `''` means the root. */
  directory: WorkspaceRelativePath | '';
  /** Plain file name ending in `.md` or `.markdown`. */
  fileName: string;
  /** Initial contents; defaults to an empty document. */
  markdown?: string;
}

export interface SaveDocumentCopyRequest {
  documentId: DocumentId;
  /** Open document the buffer belongs to. */
  path: WorkspaceRelativePath;
  /** New file to create; must not exist yet. */
  targetPath: WorkspaceRelativePath;
  markdown: string;
}

export interface SaveDocumentRequest {
  documentId: DocumentId;
  path: WorkspaceRelativePath;
  markdown: string;
  /** Hash the renderer based its edits on; main re-reads disk and compares. */
  baseHash: ContentHash;
}

export interface SaveDocumentResult {
  path: WorkspaceRelativePath;
  diskHash: ContentHash;
  mtimeMs: number;
  savedAt: IsoTimestamp;
  bytes: number;
}

export interface RenameDocumentRequest {
  documentId: DocumentId;
  fromPath: WorkspaceRelativePath;
  toPath: WorkspaceRelativePath;
  /** Rewrite unambiguous `[[wikilinks]]` that resolve to `fromPath`. */
  updateReferences: boolean;
}

export interface LinkReferenceEdit {
  documentPath: WorkspaceRelativePath;
  from: string;
  to: string;
  occurrences: number;
}

export interface SkippedReference {
  documentPath: WorkspaceRelativePath;
  line: number;
  raw: string;
  reason: 'ambiguous' | 'unresolvable' | 'write_failed';
}

export interface RenameDocumentResult {
  path: WorkspaceRelativePath;
  referenceEdits: LinkReferenceEdit[];
  skippedReferences: SkippedReference[];
  /**
   * True when `updateReferences` was requested but rewriting references is
   * owned by the link/graph module. No rewrite is claimed in that case.
   */
  referencesDeferred: boolean;
}

export type DocumentChangeKind = 'modified' | 'deleted';

/** Pushed by the main-process watcher after an external file change. */
export interface DocumentChangeEvent {
  path: WorkspaceRelativePath;
  kind: DocumentChangeKind;
  /** Hash of the new on-disk bytes; `null` when the file is gone. */
  hash: ContentHash | null;
  mtimeMs: number | null;
  size: number | null;
}

// ---------------------------------------------------------------------------
// Image resources
// ---------------------------------------------------------------------------

export type ImageMediaType =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp'
  | 'image/svg+xml';

export interface SaveImageRequest {
  /** Document the image is inserted into; decides the asset folder. */
  documentPath: WorkspaceRelativePath;
  /** Plain file name such as `pasted-image.png` (no directories). */
  fileName: string;
  mediaType: ImageMediaType;
  dataBase64: string;
}

export interface ImageAsset {
  path: WorkspaceRelativePath;
  mediaType: ImageMediaType;
  sha256: ContentHash;
  bytes: number;
  /** True when an identical asset already existed and was reused. */
  duplicate: boolean;
}

export interface ReadImageRequest {
  /** Image path relative to the workspace root. */
  path: WorkspaceRelativePath;
  /** Markdown document that references the image; used as the basis check. */
  documentPath: WorkspaceRelativePath;
}

export interface ReadImageResult {
  path: WorkspaceRelativePath;
  mediaType: ImageMediaType;
  dataBase64: string;
  sha256: ContentHash;
  bytes: number;
}

// ---------------------------------------------------------------------------
// HTML rendering and export
// ---------------------------------------------------------------------------

/** Resource that could not be embedded into the exported single file. */
export interface ExternalAssetDependency {
  url: string;
  reason: 'remote' | 'missing' | 'unsafe' | 'too_large';
}

export interface ExportDependencyReport {
  embeddedLocalAssets: WorkspaceRelativePath[];
  externalAssets: ExternalAssetDependency[];
  missingAssets: WorkspaceRelativePath[];
}

export interface ExportHtmlRequest {
  documentPath: WorkspaceRelativePath;
  /** Plain file name suggested in the save dialog; must end with `.html`. */
  suggestedFileName: string;
  /** Fully rendered document produced by the shared render pipeline. */
  html: string;
  /** Content signature of the rendered state, echoed back for tracking. */
  signature: string;
  dependencies: ExportDependencyReport;
}

export interface ExportHtmlResult {
  /** Absolute path actually written; display only. */
  writtenPath: string;
  bytes: number;
  signature: string;
  dependencies: ExportDependencyReport;
}

// ---------------------------------------------------------------------------
// Theme and layout
// ---------------------------------------------------------------------------

export type ThemeMode = 'light' | 'dark' | 'system';

export type WallpaperSize = 'cover' | 'contain' | 'repeat';

export type WallpaperPosition = 'center' | 'top' | 'bottom' | 'left' | 'right';

/** Custom wall paper behind the whole app, preview iframe and exported file. */
export interface WallpaperConfig {
  /** `null`, or canonical `data:image/(png|jpeg|gif|webp);base64,…` payload. */
  dataUri: string | null;
  /** 0–1; the layer alpha, never the text alpha. */
  opacity: number;
  /** 0–20 CSS pixels of blur on the wallpaper layer only. */
  blurPx: number;
  size: WallpaperSize;
  position: WallpaperPosition;
}

export interface ThemeConfig {
  mode: ThemeMode;
  bodyWidthPx: number;
  fontFamily: string;
  fontSizePx: number;
  lineHeight: number;
  codeFontFamily: string;
  foreground: string;
  background: string;
  accent: string;
  headingScale: number;
  /** Controlled CSS variables only; keys must start with `--mdl-`. */
  customVariables: Record<string, string>;
  wallpaper: WallpaperConfig;
}

/** A wallpaper the user picked from disk; never carries the absolute path. */
export interface WallpaperImage {
  dataUri: string;
  mediaType: ImageMediaType;
  bytes: number;
  sha256: ContentHash;
}

export interface ChooseBackgroundResult {
  cancelled: boolean;
  wallpaper: WallpaperImage | null;
}

export type SidebarPosition = 'left' | 'right';

export interface SidebarLayout {
  visible: boolean;
  position: SidebarPosition;
  widthPx: number;
}

export interface OutlineLayout {
  visible: boolean;
  position: SidebarPosition;
}

export interface TitleLayout {
  visible: boolean;
}

export interface LayoutConfig {
  sidebar: SidebarLayout;
  outline: OutlineLayout;
  title: TitleLayout;
}

export interface ThemeLayoutState {
  theme: ThemeConfig;
  layout: LayoutConfig;
}

/** Editor state worth restoring after a restart (not undo history). */
export interface DocumentViewState {
  selection: TextSelection | null;
  scrollTop: number;
  viewMode: ViewMode;
}

// ---------------------------------------------------------------------------
// Persisted workspace UI state
// ---------------------------------------------------------------------------

export const WORKSPACE_STATE_VERSION = 1;

export interface WorkspaceUiState extends ThemeLayoutState {
  version: typeof WORKSPACE_STATE_VERSION;
  workspaceRootPath: string | null;
  openDocuments: WorkspaceRelativePath[];
  activeDocument: WorkspaceRelativePath | null;
  /** Per-document selection, scroll and view mode, keyed by document path. */
  documentViews: Record<WorkspaceRelativePath, DocumentViewState>;
  updatedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Wiki links, backlinks and graph
// ---------------------------------------------------------------------------

export type LinkResolution = 'resolved' | 'ambiguous' | 'missing';

export interface WikiLink {
  sourcePath: WorkspaceRelativePath;
  /** 1-based line and column for editor navigation. */
  line: number;
  column: number;
  /** Original token text, e.g. `[[notes/idea|别名]]`. */
  raw: string;
  target: string;
  alias: string | null;
  resolution: LinkResolution;
  resolvedPath: WorkspaceRelativePath | null;
}

export interface LinkDocumentSummary {
  path: WorkspaceRelativePath;
  title: string;
  outboundCount: number;
  inboundCount: number;
  missingOutboundCount: number;
}

export interface LinkIndex {
  workspaceRootPath: string;
  generatedAt: IsoTimestamp;
  documents: LinkDocumentSummary[];
  links: WikiLink[];
}

export interface BacklinksRequest {
  path: WorkspaceRelativePath;
}

export interface Backlink {
  sourcePath: WorkspaceRelativePath;
  sourceTitle: string;
  occurrences: number;
}

export interface BacklinkReport {
  targetPath: WorkspaceRelativePath;
  backlinks: Backlink[];
  /** Links whose target text matches but cannot be resolved unambiguously. */
  ambiguousSources: WorkspaceRelativePath[];
}

export interface GraphRequest {
  /** Restrict the graph to the neighbourhood of this note. */
  focusPath: WorkspaceRelativePath | null;
  depth: number;
}

export type GraphNodeKind = 'note' | 'missing';

export interface LinkGraphNode {
  id: WorkspaceRelativePath;
  label: string;
  kind: GraphNodeKind;
  inDegree: number;
  outDegree: number;
}

export interface LinkGraphEdge {
  id: string;
  source: WorkspaceRelativePath;
  target: WorkspaceRelativePath;
  count: number;
  resolution: LinkResolution;
}

export interface LinkGraph {
  generatedAt: IsoTimestamp;
  focusPath: WorkspaceRelativePath | null;
  nodes: LinkGraphNode[];
  edges: LinkGraphEdge[];
}

// ---------------------------------------------------------------------------
// Application info
// ---------------------------------------------------------------------------

export type RuntimeDataSource = 'env' | 'default';

export interface AppInfo {
  name: string;
  version: string;
  environment: 'development' | 'production';
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  arch: string;
  /** Directory used for all app state; never a user-profile location. */
  runtimeDataDir: string;
  runtimeDataSource: RuntimeDataSource;
}
