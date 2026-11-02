/**
 * Sandboxed preview frame.
 *
 * The frame uses `srcdoc` and a sandbox *without* `allow-scripts`, so preview
 * content can never execute code even if a sanitizer were bypassed. Same-origin
 * access stays enabled (scripts are still blocked) so the workspace can preserve
 * the scroll position across re-renders.
 */

import { DOCUMENT_CSP } from '../render/document';
import { escapeAttribute } from '../render/escape';

const BASE_TAG = /<base\b[^>]*>/gi;
const REFRESH_META = /<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi;
const HEAD_TAG = /<head\b[^>]*>/i;
const HTML_TAG = /<html\b[^>]*>/i;
const DOCTYPE = /^<!doctype[^>]*>/i;

export const PREVIEW_SANDBOX = 'allow-same-origin';
export const HTML_FILE_PREVIEW_CSP = DOCUMENT_CSP;

/**
 * Prepares an existing HTML file for preview: an extra restrictive CSP is
 * added, and `<base>` / meta refresh are removed because they can redirect
 * relative loads or the frame itself. The source view keeps the original text.
 */
export function withPreviewCsp(html: string): string {
  const cleaned = html.replace(BASE_TAG, '').replace(REFRESH_META, '');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(HTML_FILE_PREVIEW_CSP)}" />`;

  const head = HEAD_TAG.exec(cleaned);
  if (head) {
    const index = head.index + head[0].length;
    return `${cleaned.slice(0, index)}\n${meta}${cleaned.slice(index)}`;
  }
  const htmlTag = HTML_TAG.exec(cleaned);
  if (htmlTag) {
    const index = htmlTag.index + htmlTag[0].length;
    return `${cleaned.slice(0, index)}\n<head>${meta}</head>${cleaned.slice(index)}`;
  }
  const doctype = DOCTYPE.exec(cleaned);
  if (doctype) {
    const index = doctype[0].length;
    return `${cleaned.slice(0, index)}\n${meta}${cleaned.slice(index)}`;
  }
  return `${meta}\n${cleaned}`;
}

export interface PreviewFrameOptions {
  title?: string;
  className?: string;
  ownerDocument?: Document;
  sandbox?: string;
}

export interface PreviewFrame {
  readonly element: HTMLIFrameElement;
  readonly sandbox: string;
  setDocument(html: string): void;
  clear(): void;
  destroy(): void;
}

const BLANK_DOCUMENT = '<!doctype html><html><head><meta charset="utf-8" /></head><body></body></html>';

export function createPreviewFrame(options: PreviewFrameOptions = {}): PreviewFrame {
  const doc = options.ownerDocument ?? globalThis.document;
  const sandbox = options.sandbox ?? PREVIEW_SANDBOX;
  const element = doc.createElement('iframe');

  element.className = options.className ?? 'mdl-preview-frame';
  element.setAttribute('title', options.title ?? 'Markdown 预览');
  element.setAttribute('sandbox', sandbox);
  element.setAttribute('referrerpolicy', 'no-referrer');
  element.setAttribute('loading', 'eager');

  let pendingScrollTop = 0;
  const restoreScroll = (): void => {
    if (pendingScrollTop <= 0) return;
    try {
      element.contentWindow?.scrollTo(0, pendingScrollTop);
    } catch {
      // A future sandbox policy without same-origin access simply skips this.
    }
    pendingScrollTop = 0;
  };
  element.addEventListener('load', restoreScroll);

  return {
    element,
    sandbox,
    setDocument(html: string): void {
      try {
        pendingScrollTop = element.contentWindow?.scrollY ?? 0;
      } catch {
        pendingScrollTop = 0;
      }
      element.srcdoc = html;
    },
    clear(): void {
      pendingScrollTop = 0;
      element.srcdoc = BLANK_DOCUMENT;
    },
    destroy(): void {
      element.removeEventListener('load', restoreScroll);
      element.srcdoc = BLANK_DOCUMENT;
      element.remove();
    },
  };
}
