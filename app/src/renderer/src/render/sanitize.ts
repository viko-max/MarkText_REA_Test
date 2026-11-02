/**
 * DOMPurify adapter for the render pipeline.
 *
 * The browser build of DOMPurify binds itself to `window` at import time. This
 * module keeps that binding lazy and explicit: in the renderer it uses the real
 * document, and tests can pass a jsdom/happy-dom scope. If no DOM is available
 * the sanitizer refuses to run instead of returning unsanitised markup.
 */

import domPurify from 'dompurify';
import type { Config } from 'dompurify';
import { MarkdownRenderError } from './errors';
import type { HtmlSanitizer } from './types';

/**
 * Allowlist matching exactly what the pipeline emits. Raw HTML from Markdown is
 * escaped before this step, so this is a second, independent barrier.
 */
export const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    'a',
    'abbr',
    'article',
    'aside',
    'b',
    'blockquote',
    'br',
    'caption',
    'code',
    'col',
    'colgroup',
    'dd',
    'del',
    'details',
    'div',
    'dl',
    'dt',
    'em',
    'figcaption',
    'figure',
    'footer',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'header',
    'hr',
    'i',
    'img',
    'input',
    'kbd',
    'li',
    'main',
    'mark',
    'nav',
    'ol',
    'p',
    'pre',
    'q',
    's',
    'section',
    'small',
    'span',
    'strong',
    'sub',
    'summary',
    'sup',
    'table',
    'tbody',
    'td',
    'tfoot',
    'th',
    'thead',
    'tr',
    'u',
    'ul',
  ],
  ALLOWED_ATTR: [
    'align',
    'alt',
    'checked',
    'class',
    'colspan',
    'data-mdl-external',
    'data-mdl-image',
    'data-mdl-state',
    'data-mdl-target',
    'data-mdl-wikilink',
    'decoding',
    'disabled',
    'href',
    'id',
    'lang',
    'loading',
    'rel',
    'role',
    'rowspan',
    'scope',
    'src',
    'start',
    'tabindex',
    'target',
    'title',
    'type',
  ],
  ALLOW_ARIA_ATTR: true,
  ALLOW_DATA_ATTR: false,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  FORBID_TAGS: ['base', 'embed', 'form', 'iframe', 'link', 'meta', 'object', 'script', 'style'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick', 'style', 'srcdoc'],
  RETURN_TRUSTED_TYPE: false,
  SANITIZE_DOM: true,
};

interface DomPurifyInstance {
  isSupported: boolean;
  sanitize(dirty: string, config?: Config): string;
}

type DomPurifyFactory = (scope?: unknown) => DomPurifyInstance;

const factory = domPurify as unknown as DomPurifyFactory;

let cached: HtmlSanitizer | null = null;

/**
 * Creates a sanitizer bound to `scope` (defaulting to the current global).
 * Throws `sanitizer_unavailable` when the scope has no usable document, so a
 * missing DOM can never degrade into passing HTML through untouched.
 */
export function createDomPurifySanitizer(scope?: unknown): HtmlSanitizer {
  const instance = factory(scope ?? globalThis);
  if (!instance.isSupported) {
    throw new MarkdownRenderError(
      'sanitizer_unavailable',
      'DOMPurify is not supported in this environment; refusing to emit unsanitised HTML',
    );
  }
  return (dirtyHtml: string) => instance.sanitize(dirtyHtml, SANITIZE_CONFIG);
}

export function getDefaultHtmlSanitizer(): HtmlSanitizer {
  if (!cached) cached = createDomPurifySanitizer();
  return cached;
}

/** Test helper: drops the cached instance. */
export function resetDefaultHtmlSanitizer(): void {
  cached = null;
}
