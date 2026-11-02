/**
 * HTML and URL escaping for the render pipeline.
 *
 * Everything the pipeline emits is built from these helpers: Markdown text is
 * escaped, URLs are checked against an explicit scheme policy, and raw HTML in
 * Markdown is rendered as text rather than trusted.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

const ESCAPE_PATTERN = /[&<>"']/g;

export function escapeHtml(value: string): string {
  return value.replace(ESCAPE_PATTERN, (character) => ESCAPES[character] ?? character);
}

/** Attribute values use the same escapes; quotes are always emitted. */
export const escapeAttribute = escapeHtml;

export function stripControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export type UrlKind = 'link' | 'image';

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
const LINK_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const IMAGE_SCHEMES = new Set(['http', 'https']);
const DATA_IMAGE_PATTERN = /^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i;

/**
 * Returns the URL to emit, or `null` when the scheme is not allowed.
 *
 * The check collapses whitespace and control characters first, because
 * browsers ignore them inside a scheme (`java\nscript:` still executes).
 * Relative URLs and fragments are left untouched for the resource layer to
 * classify (and, for images, to validate).
 */
export function sanitizeUrl(raw: string, kind: UrlKind): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const compact = stripControlCharacters(trimmed).replace(/[\s\u00a0]+/g, '');

  const match = SCHEME_PATTERN.exec(compact);
  if (!match) return trimmed;

  const scheme = (match[1] ?? '').toLowerCase();
  if (kind === 'link') return LINK_SCHEMES.has(scheme) ? trimmed : null;
  if (IMAGE_SCHEMES.has(scheme)) return trimmed;
  if (scheme === 'data') return DATA_IMAGE_PATTERN.test(compact) ? trimmed : null;
  return null;
}

/** True for absolute http(s) URLs, including protocol-relative ones. */
export function isExternalUrl(url: string): boolean {
  return /^(?:https?:)?\/\//i.test(url.trim());
}
