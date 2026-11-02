/**
 * Types of the shared HTML render pipeline.
 *
 * `MarkdownRenderPipeline` is the only producer of HTML in the app: the in-app
 * preview embeds `RenderResult.html` in an `iframe[srcDoc]` and the export
 * service writes exactly the same string. Resource lookup and wiki-link
 * resolution are injected so this module never builds an index of its own.
 */

import type {
  ExportDependencyReport,
  ImageMediaType,
  LayoutConfig,
  ThemeConfig,
  WorkspaceRelativePath,
} from '../../../shared/contracts';

/** Final sanitisation step; receives marked output, returns safe HTML. */
export type HtmlSanitizer = (dirtyHtml: string) => string;

// ---------------------------------------------------------------------------
// Image resources
// ---------------------------------------------------------------------------

export interface ImageResourceRequest {
  /** Workspace-relative POSIX path of the image. */
  path: WorkspaceRelativePath;
  /** Document the reference appears in, used for resolution context. */
  documentPath: WorkspaceRelativePath;
}

/**
 * Shape returned by `window.markdownLite.images.read({ path, documentPath })`
 * once the main process implements it. The pipeline validates every field, so
 * a resolver can never smuggle unvalidated bytes into the document.
 */
export interface ImageResourceData {
  path: WorkspaceRelativePath;
  mediaType: ImageMediaType;
  dataBase64: string;
  sha256: string;
  bytes: number;
}

export type ImageResourceResolver = (
  request: ImageResourceRequest,
) => Promise<ImageResourceData | null> | ImageResourceData | null;

export type ImageStatus = 'embedded' | 'external' | 'missing' | 'unsafe' | 'too_large';

export interface ResolvedImage {
  /** Original href as written in the Markdown. */
  href: string;
  status: ImageStatus;
  dataUri: string | null;
  path: WorkspaceRelativePath | null;
  mediaType: ImageMediaType | null;
  bytes: number | null;
  sha256: string | null;
  /** Machine-readable reason for non-embedded states. */
  reason: string | null;
}

export interface RenderAssetRecord {
  href: string;
  status: ImageStatus;
  path: WorkspaceRelativePath | null;
  reason: string | null;
  mediaType: ImageMediaType | null;
  bytes: number | null;
  sha256: string | null;
}

// ---------------------------------------------------------------------------
// Wiki links
// ---------------------------------------------------------------------------

export interface WikiLinkToken {
  target: string;
  alias: string | null;
  /** Original token text, e.g. `[[notes/idea|别名]]`. */
  raw: string;
}

export type WikiLinkState = 'resolved' | 'ambiguous' | 'missing';

export interface WikiLinkResolution {
  state: WikiLinkState;
  /** Optional link target; only safe relative/http(s) URLs are emitted. */
  href?: string | null;
  /** Optional display label override (the Markdown alias still wins). */
  label?: string | null;
  title?: string | null;
}

export type WikiLinkResolver = (
  link: WikiLinkToken,
) => Promise<WikiLinkResolution | null> | WikiLinkResolution | null;

// ---------------------------------------------------------------------------
// Warnings, outline and results
// ---------------------------------------------------------------------------

export type RenderWarningCode =
  | 'image_missing'
  | 'image_unsafe'
  | 'image_too_large'
  | 'image_resolver_unavailable'
  | 'wikilink_unresolved'
  | 'theme_variable_ignored'
  | 'blocked_link';

export interface RenderWarning {
  code: RenderWarningCode;
  message: string;
  detail: string | null;
}

export interface OutlineEntry {
  id: string;
  text: string;
  depth: number;
}

export interface RenderInput {
  markdown: string;
  /** Workspace-relative POSIX path; relative images resolve against its folder. */
  documentPath: WorkspaceRelativePath;
  title?: string | null;
  theme: ThemeConfig;
  layout: LayoutConfig;
  /** Optional, already-sanitised sidebar markup supplied by the integration. */
  sidebarHtml?: string | null;
}

export interface RenderResult {
  /** `sha256:<hex>` over markdown, theme, layout and resolved resources. */
  signature: string;
  /** Complete standalone HTML document shared by preview and export. */
  html: string;
  bodyHtml: string;
  css: string;
  title: string;
  outline: OutlineEntry[];
  dependencies: ExportDependencyReport;
  assets: RenderAssetRecord[];
  warnings: RenderWarning[];
}
