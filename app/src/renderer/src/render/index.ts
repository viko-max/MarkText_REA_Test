/**
 * Render pipeline barrel.
 *
 * Integration code (HTML workspace, export wiring) imports everything it needs
 * from here, so there is one documented entry point for the shared renderer.
 */

export {
  createAppMarkdownRenderPipeline,
  DEFAULT_MAX_IMAGE_BYTES,
  MarkdownRenderPipeline,
  plainTextFromTokens,
} from './markdown-render-pipeline';
export type { MarkdownRenderPipelineOptions } from './markdown-render-pipeline';

export {
  createIpcImageResourceResolver,
  findImagesReadBridge,
  parseImageResourceData,
  resolveImageResources,
  resolveWorkspaceImagePath,
} from './resources';
export type { ImageResolutionSummary, ImagesReadBridge, ResolveImagesInput } from './resources';

export { createDomPurifySanitizer, getDefaultHtmlSanitizer, SANITIZE_CONFIG } from './sanitize';
export { computeRenderSignature } from './signature';
export { assembleHtmlDocument, DOCUMENT_CSP, DOCUMENT_GENERATOR, normalizeDocumentTitle } from './document';
export {
  buildThemeCss,
  normalizeLayout,
  normalizeTheme,
  OUTLINE_WIDTH_PX,
  sanitizeCustomVariableValue,
} from './theme';
export { createHeadingSlugger, slugifyHeadingText } from './anchors';
export { escapeAttribute, escapeHtml, isExternalUrl, sanitizeUrl } from './escape';
export { MarkdownRenderError } from './errors';
export type { RenderErrorCode } from './errors';
export { createWikiLinkExtension, resolveWikiLinkTokens, WIKI_LINK_TOKEN_TYPE } from './wikilinks';

export type {
  HtmlSanitizer,
  ImageResourceData,
  ImageResourceRequest,
  ImageResourceResolver,
  ImageStatus,
  OutlineEntry,
  RenderAssetRecord,
  RenderInput,
  RenderResult,
  RenderWarning,
  RenderWarningCode,
  ResolvedImage,
  WikiLinkResolution,
  WikiLinkResolver,
  WikiLinkState,
  WikiLinkToken,
} from './types';
