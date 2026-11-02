/**
 * Errors raised by the shared Markdown render pipeline.
 *
 * The pipeline never returns partially rendered HTML: when it cannot build a
 * safe document it throws one of these errors so preview and export both fail
 * closed instead of showing untrusted markup.
 */

export type RenderErrorCode =
  | 'invalid_markdown'
  | 'invalid_theme'
  | 'sanitizer_unavailable'
  | 'render_failed';

export class MarkdownRenderError extends Error {
  readonly code: RenderErrorCode;

  constructor(code: RenderErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MarkdownRenderError';
    this.code = code;
  }
}
