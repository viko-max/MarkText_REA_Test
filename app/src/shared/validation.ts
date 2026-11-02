/**
 * Runtime validation for everything crossing the IPC boundary.
 *
 * The main process never trusts a payload: each handler parses the raw
 * `unknown` argument with one of these validators before touching the
 * filesystem. Validators are pure and unit-tested.
 */

import type {
  BacklinksRequest,
  CreateDocumentRequest,
  DocumentChangeEvent,
  DocumentViewState,
  ExportDependencyReport,
  ExportHtmlRequest,
  ExternalAssetDependency,
  GetWorkspaceTreeRequest,
  GraphRequest,
  ImageMediaType,
  LayoutConfig,
  ReadDocumentRequest,
  ReadImageRequest,
  RenameDocumentRequest,
  SaveDocumentCopyRequest,
  SaveDocumentRequest,
  SaveImageRequest,
  ThemeConfig,
  ViewMode,
  WallpaperConfig,
  WallpaperPosition,
  WallpaperSize,
  WorkspaceUiState,
} from './contracts';
import { WORKSPACE_STATE_VERSION } from './contracts';
import { DEFAULT_WALLPAPER } from './defaults';
import { isMarkdownPath, isWorkspaceRelativePath, workspacePathKey } from './paths';

export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };

export const MAX_MARKDOWN_CHARS = 64_000_000;
export const MAX_HTML_CHARS = 128_000_000;
export const MAX_IMAGE_BASE64_CHARS = 44_000_000;
/** Hard limit applied by the main process after base64 decoding. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_WALLPAPER_DATA_URI_CHARS = 14_000_000;
export const MAX_OPEN_DOCUMENTS = 256;
export const MAX_TREE_DEPTH = 8;
export const MAX_GRAPH_DEPTH = 6;

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;
const THEME_MODES = ['light', 'dark', 'system'] as const;
const SIDES = ['left', 'right'] as const;
const WALLPAPER_SIZES: readonly WallpaperSize[] = ['cover', 'contain', 'repeat'];
const WALLPAPER_POSITIONS: readonly WallpaperPosition[] = ['center', 'top', 'bottom', 'left', 'right'];
const WALLPAPER_DATA_URI_PREFIXES = [
  'data:image/png;base64,',
  'data:image/jpeg;base64,',
  'data:image/gif;base64,',
  'data:image/webp;base64,',
] as const;
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'];

class ValidationError extends Error {}

function invalid(message: string): never {
  throw new ValidationError(message);
}

function run<T>(build: () => T): Validation<T> {
  try {
    return { ok: true, value: build() };
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, message: error.message };
    throw error;
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

class Fields {
  private readonly source: Record<string, unknown>;
  private readonly label: string;

  constructor(value: unknown, label: string) {
    this.source = asObject(value, label);
    this.label = label;
  }

  private path(key: string): string {
    return `${this.label}.${key}`;
  }

  raw(key: string): unknown {
    return this.source[key];
  }

  string(key: string, options: { min?: number; max?: number } = {}): string {
    const value = this.source[key];
    if (typeof value !== 'string') invalid(`${this.path(key)} must be a string`);
    const { min = 0, max = 1_000_000 } = options;
    if (value.length < min) invalid(`${this.path(key)} must not be empty`);
    if (value.length > max) invalid(`${this.path(key)} exceeds ${max} characters`);
    return value;
  }

  optionalString(key: string, options: { max?: number } = {}): string | undefined {
    const value = this.source[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') invalid(`${this.path(key)} must be a string`);
    const { max = 1_000_000 } = options;
    if (value.length > max) invalid(`${this.path(key)} exceeds ${max} characters`);
    return value;
  }

  boolean(key: string): boolean {
    const value = this.source[key];
    if (typeof value !== 'boolean') invalid(`${this.path(key)} must be a boolean`);
    return value;
  }

  integer(key: string, min: number, max: number): number {
    const value = this.source[key];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      invalid(`${this.path(key)} must be an integer`);
    }
    if (value < min || value > max) invalid(`${this.path(key)} must be between ${min} and ${max}`);
    return value;
  }

  number(key: string, min: number, max: number): number {
    const value = this.source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      invalid(`${this.path(key)} must be a number`);
    }
    if (value < min || value > max) invalid(`${this.path(key)} must be between ${min} and ${max}`);
    return value;
  }

  workspacePath(key: string, options: { allowRoot?: boolean } = {}): string {
    const value = this.source[key];
    if (options.allowRoot && value === '') return '';
    if (!isWorkspaceRelativePath(value)) {
      invalid(`${this.path(key)} must be a workspace-relative POSIX path`);
    }
    return value;
  }

  markdownPath(key: string): string {
    const value = this.workspacePath(key);
    if (!isMarkdownPath(value)) invalid(`${this.path(key)} must end with .md or .markdown`);
    return value;
  }

  hash(key: string): string {
    const value = this.string(key, { min: 64, max: 64 });
    if (!HASH_PATTERN.test(value)) invalid(`${this.path(key)} must be a lower-case SHA-256 hex digest`);
    return value;
  }

  stringArray(key: string, maxItems: number): string[] {
    const value = this.source[key];
    if (!Array.isArray(value)) invalid(`${this.path(key)} must be an array`);
    if (value.length > maxItems) invalid(`${this.path(key)} exceeds ${maxItems} entries`);
    return value.map((item, index) => {
      if (typeof item !== 'string') invalid(`${this.path(key)}[${index}] must be a string`);
      return item;
    });
  }
}

function assertWorkspacePath(value: unknown, label: string): string {
  if (!isWorkspaceRelativePath(value)) invalid(`${label} must be a workspace-relative POSIX path`);
  return value;
}

function assertPlainFileName(value: string, label: string): string {
  if (value.length === 0 || value.length > 255) invalid(`${label} has an invalid length`);
  if (value.includes('/') || value.includes('\\') || value.includes(':')) {
    invalid(`${label} must be a plain file name without directories`);
  }
  if (!isWorkspaceRelativePath(value)) invalid(`${label} is not a valid file name`);
  return value;
}

export function validateGetWorkspaceTreeRequest(value: unknown): Validation<GetWorkspaceTreeRequest> {
  return run(() => {
    const fields = new Fields(value, 'request');
    const path = fields.workspacePath('path', { allowRoot: true });
    const depth = fields.integer('depth', 0, MAX_TREE_DEPTH);
    return { path, depth };
  });
}

export function validateReadDocumentRequest(value: unknown): Validation<ReadDocumentRequest> {
  return run(() => {
    const fields = new Fields(value, 'request');
    return { path: fields.workspacePath('path') };
  });
}

export function validateCreateDocumentRequest(value: unknown): Validation<CreateDocumentRequest> {
  return run(() => {
    const fields = new Fields(value, 'request');
    const directory = fields.workspacePath('directory', { allowRoot: true });
    const fileName = fields.string('fileName', { max: 255 });
    assertPlainFileName(fileName, 'request.fileName');
    if (!isMarkdownPath(fileName)) invalid('request.fileName must end with .md or .markdown');
    const markdown = fields.optionalString('markdown', { max: MAX_MARKDOWN_CHARS });
    return markdown === undefined ? { directory, fileName } : { directory, fileName, markdown };
  });
}

export function validateReloadDocumentRequest(value: unknown): Validation<ReadDocumentRequest> {
  return run(() => {
    const fields = new Fields(value, 'request');
    return { path: fields.markdownPath('path') };
  });
}

export function validateSaveDocumentCopyRequest(value: unknown): Validation<SaveDocumentCopyRequest> {
  return run(() => {
    const fields = new Fields(value, 'request');
    const path = fields.markdownPath('path');
    const targetPath = fields.markdownPath('targetPath');
    if (workspacePathKey(path) === workspacePathKey(targetPath)) {
      invalid('request.targetPath must differ from request.path');
    }
    return {
      documentId: fields.string('documentId', { min: 1, max: 128 }),
      path,
      targetPath,
      markdown: fields.string('markdown', { max: MAX_MARKDOWN_CHARS }),
    };
  });
}

export function validateSaveDocumentRequest(value: unknown): Validation<SaveDocumentRequest> {
  return run(() => {
    const fields = new Fields(value, 'request');
    return {
      documentId: fields.string('documentId', { min: 1, max: 128 }),
      path: fields.markdownPath('path'),
      markdown: fields.string('markdown', { max: MAX_MARKDOWN_CHARS }),
      baseHash: fields.hash('baseHash'),
    };
  });
}

export function validateRenameDocumentRequest(value: unknown): Validation<RenameDocumentRequest> {
  return run(() => {
    const fields = new Fields(value, 'request');
    const fromPath = fields.markdownPath('fromPath');
    const toPath = fields.markdownPath('toPath');
    if (workspacePathKey(fromPath) === workspacePathKey(toPath)) {
      invalid('request.toPath must differ from request.fromPath');
    }
    return {
      documentId: fields.string('documentId', { min: 1, max: 128 }),
      fromPath,
      toPath,
      updateReferences: fields.boolean('updateReferences'),
    };
  });
}

function parseDependencyReport(value: unknown, label: string): ExportDependencyReport {
  const fields = new Fields(value, label);
  const externalRaw = fields.raw('externalAssets');
  if (!Array.isArray(externalRaw)) invalid(`${label}.externalAssets must be an array`);
  if (externalRaw.length > 512) invalid(`${label}.externalAssets exceeds 512 entries`);
  const externalAssets: ExternalAssetDependency[] = externalRaw.map((item, index) => {
    const entry = new Fields(item, `${label}.externalAssets[${index}]`);
    const reason = entry.string('reason', { min: 1, max: 32 });
    if (!['remote', 'missing', 'unsafe', 'too_large'].includes(reason)) {
      invalid(`${label}.externalAssets[${index}].reason is not recognised`);
    }
    return { url: entry.string('url', { min: 1, max: 4096 }), reason: reason as ExternalAssetDependency['reason'] };
  });
  const embedded = fields.stringArray('embeddedLocalAssets', 512);
  const missing = fields.stringArray('missingAssets', 512);
  embedded.forEach((path, index) => assertWorkspacePath(path, `${label}.embeddedLocalAssets[${index}]`));
  missing.forEach((path, index) => assertWorkspacePath(path, `${label}.missingAssets[${index}]`));
  return { embeddedLocalAssets: embedded, externalAssets, missingAssets: missing };
}

export function validateExportHtmlRequest(value: unknown): Validation<ExportHtmlRequest> {
  return run(() => {
    const fields = new Fields(value, 'request');
    const suggestedFileName = fields.string('suggestedFileName', { max: 255 });
    assertPlainFileName(suggestedFileName, 'request.suggestedFileName');
    if (!suggestedFileName.toLowerCase().endsWith('.html')) {
      invalid('request.suggestedFileName must end with .html');
    }
    return {
      documentPath: fields.markdownPath('documentPath'),
      suggestedFileName,
      html: fields.string('html', { min: 1, max: MAX_HTML_CHARS }),
      signature: fields.string('signature', { min: 1, max: 256 }),
      dependencies: parseDependencyReport(fields.raw('dependencies'), 'request.dependencies'),
    };
  });
}

export function validateSaveImageRequest(value: unknown): Validation<SaveImageRequest> {
  return run(() => {
    const fields = new Fields(value, 'request');
    const fileName = fields.string('fileName', { max: 255 });
    assertPlainFileName(fileName, 'request.fileName');
    const lowerName = fileName.toLowerCase();
    if (!IMAGE_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
      invalid('request.fileName must end with a supported image extension');
    }
    const mediaType = fields.string('mediaType', { max: 32 });
    if (!IMAGE_MEDIA_TYPES.includes(mediaType as ImageMediaType)) {
      invalid('request.mediaType is not supported');
    }
    const dataBase64 = fields.string('dataBase64', { min: 1, max: MAX_IMAGE_BASE64_CHARS });
    if (dataBase64.length % 4 !== 0 || !BASE64_PATTERN.test(dataBase64)) {
      invalid('request.dataBase64 must be padded base64');
    }
    return {
      documentPath: fields.markdownPath('documentPath'),
      fileName,
      mediaType: mediaType as ImageMediaType,
      dataBase64,
    };
  });
}

export function validateReadImageRequest(value: unknown): Validation<ReadImageRequest> {
  return run(() => {
    const fields = new Fields(value, 'request');
    return {
      path: fields.workspacePath('path'),
      documentPath: fields.markdownPath('documentPath'),
    };
  });
}

function nullableString(value: unknown, label: string, pattern: RegExp): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !pattern.test(value)) {
    invalid(`${label} must be null or a matching lower-case hex digest`);
  }
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    invalid(`${label} must be null or a non-negative number`);
  }
  return value;
}

export function validateDocumentChangeEvent(value: unknown): Validation<DocumentChangeEvent> {
  return run(() => {
    const fields = new Fields(value, 'change');
    const path = fields.workspacePath('path');
    const kind = fields.string('kind', { max: 16 });
    if (kind !== 'modified' && kind !== 'deleted') invalid('change.kind is not supported');
    const hash = nullableString(fields.raw('hash'), 'change.hash', HASH_PATTERN);
    const mtimeMs = nullableNumber(fields.raw('mtimeMs'), 'change.mtimeMs');
    const size = nullableNumber(fields.raw('size'), 'change.size');
    if (size !== null && !Number.isInteger(size)) invalid('change.size must be an integer');
    return { path, kind, hash, mtimeMs, size };
  });
}

function parseCustomVariables(value: unknown, label: string): Record<string, string> {
  const raw = asObject(value, label);
  const entries = Object.entries(raw);
  if (entries.length > 64) invalid(`${label} exceeds 64 variables`);
  const variables: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (!key.startsWith('--mdl-')) invalid(`${label} keys must start with --mdl-`);
    if (!/^--mdl-[a-z0-9-]+$/.test(key)) invalid(`${label} key "${key}" is not allowed`);
    if (typeof entry !== 'string' || entry.length > 200) invalid(`${label}.${key} must be a short string`);
    if (/[<>{};]/.test(entry)) invalid(`${label}.${key} contains unsafe characters`);
    variables[key] = entry;
  }
  return variables;
}

/** `null` or a canonical base64 PNG/JPEG/GIF/WebP data URI within the size cap. */
export function isWallpaperDataUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_WALLPAPER_DATA_URI_CHARS) return false;
  const prefix = WALLPAPER_DATA_URI_PREFIXES.find((candidate) => value.startsWith(candidate));
  if (prefix === undefined) return false;
  const payload = value.slice(prefix.length);
  if (payload.length === 0 || payload.length % 4 !== 0) return false;
  return BASE64_PATTERN.test(payload);
}

function parseWallpaper(value: unknown): WallpaperConfig {
  if (value === undefined || value === null) return { ...DEFAULT_WALLPAPER };
  const fields = new Fields(value, 'theme.wallpaper');
  const dataUri = fields.raw('dataUri');
  if (dataUri !== null && !isWallpaperDataUri(dataUri)) {
    invalid('theme.wallpaper.dataUri must be null or a base64 PNG/JPEG/GIF/WebP data URI');
  }
  const size = fields.string('size', { max: 16 });
  if (!WALLPAPER_SIZES.includes(size as WallpaperSize)) {
    invalid('theme.wallpaper.size must be cover, contain or repeat');
  }
  const position = fields.string('position', { max: 16 });
  if (!WALLPAPER_POSITIONS.includes(position as WallpaperPosition)) {
    invalid('theme.wallpaper.position is not supported');
  }
  return {
    dataUri: dataUri as string | null,
    opacity: Math.round(fields.number('opacity', 0, 1) * 100) / 100,
    blurPx: Math.round(fields.number('blurPx', 0, 20) * 10) / 10,
    size: size as WallpaperSize,
    position: position as WallpaperPosition,
  };
}

export function validateThemeConfig(value: unknown): Validation<ThemeConfig> {
  return run(() => {
    const fields = new Fields(value, 'theme');
    const mode = fields.string('mode', { max: 16 });
    if (!THEME_MODES.includes(mode as ThemeConfig['mode'])) invalid('theme.mode is not supported');
    const color = (key: string): string => {
      const candidate = fields.string(key, { max: 32 });
      if (!COLOR_PATTERN.test(candidate)) invalid(`theme.${key} must be a hex colour`);
      return candidate;
    };
    return {
      mode: mode as ThemeConfig['mode'],
      bodyWidthPx: fields.integer('bodyWidthPx', 320, 2400),
      fontFamily: fields.string('fontFamily', { min: 1, max: 200 }),
      fontSizePx: fields.integer('fontSizePx', 10, 48),
      lineHeight: fields.number('lineHeight', 1, 3),
      codeFontFamily: fields.string('codeFontFamily', { min: 1, max: 200 }),
      foreground: color('foreground'),
      background: color('background'),
      accent: color('accent'),
      headingScale: fields.number('headingScale', 1, 2),
      customVariables: parseCustomVariables(fields.raw('customVariables'), 'theme.customVariables'),
      wallpaper: parseWallpaper(fields.raw('wallpaper')),
    };
  });
}

export function validateLayoutConfig(value: unknown): Validation<LayoutConfig> {
  return run(() => {
    const fields = new Fields(value, 'layout');
    const sidebar = new Fields(fields.raw('sidebar'), 'layout.sidebar');
    const outline = new Fields(fields.raw('outline'), 'layout.outline');
    const title = new Fields(fields.raw('title'), 'layout.title');
    const side = (entry: Fields, label: string): 'left' | 'right' => {
      const value = entry.string('position', { max: 8 });
      if (!SIDES.includes(value as 'left' | 'right')) invalid(`${label} must be left or right`);
      return value as 'left' | 'right';
    };
    return {
      sidebar: {
        visible: sidebar.boolean('visible'),
        position: side(sidebar, 'layout.sidebar.position'),
        widthPx: sidebar.integer('widthPx', 160, 640),
      },
      outline: { visible: outline.boolean('visible'), position: side(outline, 'layout.outline.position') },
      title: { visible: title.boolean('visible') },
    };
  });
}

const VIEW_MODES: readonly ViewMode[] = ['edit', 'preview', 'split', 'html'];

function parseDocumentViews(value: unknown, label: string): WorkspaceUiState['documentViews'] {
  if (value === undefined) return {};
  const raw = asObject(value, label);
  const entries = Object.entries(raw);
  if (entries.length > MAX_OPEN_DOCUMENTS) invalid(`${label} exceeds ${MAX_OPEN_DOCUMENTS} entries`);
  const views: WorkspaceUiState['documentViews'] = {};
  for (const [path, entry] of entries) {
    if (!isMarkdownPath(path)) invalid(`${label} key "${path}" must be a Markdown path`);
    const fields = new Fields(entry, `${label}.${path}`);
    const selectionRaw = fields.raw('selection');
    let selection: DocumentViewState['selection'] = null;
    if (selectionRaw !== null) {
      const selectionFields = new Fields(selectionRaw, `${label}.${path}.selection`);
      selection = {
        anchor: selectionFields.integer('anchor', 0, Number.MAX_SAFE_INTEGER),
        head: selectionFields.integer('head', 0, Number.MAX_SAFE_INTEGER),
      };
    }
    const viewMode = fields.string('viewMode', { max: 16 });
    if (!VIEW_MODES.includes(viewMode as ViewMode)) invalid(`${label}.${path}.viewMode is not supported`);
    views[path] = {
      selection,
      scrollTop: fields.number('scrollTop', 0, Number.MAX_SAFE_INTEGER),
      viewMode: viewMode as ViewMode,
    };
  }
  return views;
}

export function validateWorkspaceUiState(value: unknown): Validation<WorkspaceUiState> {
  return run(() => {
    const fields = new Fields(value, 'state');
    if (fields.integer('version', WORKSPACE_STATE_VERSION, WORKSPACE_STATE_VERSION) !== WORKSPACE_STATE_VERSION) {
      invalid('state.version is not supported');
    }
    const rootRaw = fields.raw('workspaceRootPath');
    if (rootRaw !== null && typeof rootRaw !== 'string') invalid('state.workspaceRootPath must be a string or null');
    const openDocuments = fields.stringArray('openDocuments', MAX_OPEN_DOCUMENTS);
    openDocuments.forEach((path, index) => {
      if (!isMarkdownPath(path)) invalid(`state.openDocuments[${index}] must be a Markdown path`);
    });
    const activeRaw = fields.raw('activeDocument');
    if (activeRaw !== null && !isMarkdownPath(String(activeRaw))) {
      invalid('state.activeDocument must be a Markdown path or null');
    }
    const theme = validateThemeConfig(fields.raw('theme'));
    if (!theme.ok) invalid(theme.message);
    const layout = validateLayoutConfig(fields.raw('layout'));
    if (!layout.ok) invalid(layout.message);
    return {
      version: WORKSPACE_STATE_VERSION,
      workspaceRootPath: rootRaw,
      openDocuments,
      activeDocument: activeRaw as string | null,
      documentViews: parseDocumentViews(fields.raw('documentViews'), 'state.documentViews'),
      theme: theme.value,
      layout: layout.value,
      updatedAt: fields.string('updatedAt', { min: 1, max: 40 }),
    };
  });
}

export function validateBacklinksRequest(value: unknown): Validation<BacklinksRequest> {
  return run(() => ({ path: new Fields(value, 'request').markdownPath('path') }));
}

export function validateGraphRequest(value: unknown): Validation<GraphRequest> {
  return run(() => {
    const fields = new Fields(value, 'request');
    const focus = fields.raw('focusPath');
    if (focus !== null && !isMarkdownPath(String(focus))) {
      invalid('request.focusPath must be a Markdown path or null');
    }
    return {
      focusPath: focus as string | null,
      depth: fields.integer('depth', 0, MAX_GRAPH_DEPTH),
    };
  });
}
