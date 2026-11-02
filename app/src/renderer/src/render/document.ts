/**
 * Builds the standalone HTML document that both the in-app `iframe[srcDoc]`
 * preview and the export service use. There is exactly one document shape: the
 * preview never adds preview-only markup and the exporter never rewrites it.
 *
 * The head carries a restrictive CSP (no scripts at all) so the same file stays
 * locked down when opened directly in a browser.
 */

import type { LayoutConfig, ThemeConfig } from '../../../shared/contracts';
import { escapeAttribute, escapeHtml, stripControlCharacters } from './escape';
import { normalizeLayout } from './theme';
import type { OutlineEntry } from './types';

export const DOCUMENT_GENERATOR = 'Markdown Lite Studio';

export const DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data: https: http:",
  "font-src data:",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export interface AssembleDocumentInput {
  title: string;
  /** Workspace-relative document path shown in the title block and sidebar. */
  documentPath: string;
  bodyHtml: string;
  css: string;
  theme: ThemeConfig;
  layout: LayoutConfig;
  outline: readonly OutlineEntry[];
  signature: string;
  /** Optional sidebar markup; the caller must have sanitised it already. */
  sidebarHtml?: string | null;
  lang?: string;
}

function sanitizeLang(value: string | undefined): string {
  if (typeof value !== 'string') return 'zh-CN';
  const trimmed = value.trim();
  return /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(trimmed) ? trimmed : 'zh-CN';
}

function buildOutline(outline: readonly OutlineEntry[]): string {
  if (outline.length === 0) {
    return '<p class="mdl-outline-empty">本文档没有标题。</p>';
  }
  const items = outline.map((entry) => {
    const depth = Math.min(6, Math.max(1, entry.depth));
    return `      <li class="mdl-outline-item" data-depth="${depth}"><a href="#${escapeAttribute(entry.id)}">${escapeHtml(entry.text)}</a></li>`;
  });
  return ['    <ol class="mdl-outline-list">', ...items, '    </ol>'].join('\n');
}

function buildSidebar(input: AssembleDocumentInput): string {
  const defaultContent = [
    '    <section class="mdl-sidebar-section">',
    '      <h2 class="mdl-sidebar-heading">文档</h2>',
    `      <p class="mdl-sidebar-path">${escapeHtml(input.documentPath || '未命名文档')}</p>`,
    '    </section>',
  ].join('\n');
  const extra = typeof input.sidebarHtml === 'string' && input.sidebarHtml.trim().length > 0
    ? `\n${input.sidebarHtml}`
    : '';
  return `${defaultContent}${extra}`;
}

export function assembleHtmlDocument(input: AssembleDocumentInput): string {
  const layout = normalizeLayout(input.layout);
  const title = input.title.trim().length > 0 ? input.title.trim() : '未命名文档';
  const visibility = (value: boolean): string => (value ? 'visible' : 'hidden');

  return [
    '<!doctype html>',
    `<html lang="${escapeAttribute(sanitizeLang(input.lang))}"`,
    `  data-mdl-mode="${escapeAttribute(input.theme.mode)}"`,
    `  data-mdl-title="${visibility(layout.title.visible)}"`,
    `  data-mdl-sidebar="${visibility(layout.sidebar.visible)}"`,
    `  data-mdl-sidebar-position="${layout.sidebar.position}"`,
    `  data-mdl-outline="${visibility(layout.outline.visible)}"`,
    `  data-mdl-outline-position="${layout.outline.position}">`,
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
    `    <meta http-equiv="Content-Security-Policy" content="${escapeAttribute(DOCUMENT_CSP)}" />`,
    `    <meta name="generator" content="${DOCUMENT_GENERATOR}" />`,
    `    <meta name="mdl-signature" content="${escapeAttribute(input.signature)}" />`,
    `    <title>${escapeHtml(title)}</title>`,
    '    <style>',
    input.css,
    '    </style>',
    '  </head>',
    '  <body>',
    '    <div class="mdl-shell">',
    '    <aside class="mdl-sidebar" aria-label="侧栏">',
    buildSidebar(input),
    '    </aside>',
    '    <main class="mdl-main">',
    '      <header class="mdl-titleblock">',
    `        <h1 class="mdl-doc-title">${escapeHtml(title)}</h1>`,
    `        <p class="mdl-doc-path">${escapeHtml(input.documentPath || '未保存到工作区')}</p>`,
    '      </header>',
    '      <article class="mdl-content">',
    input.bodyHtml,
    '      </article>',
    '    </main>',
    '    <nav class="mdl-outline" aria-label="文档目录">',
    '    <h2 class="mdl-outline-heading">目录</h2>',
    buildOutline(input.outline),
    '    </nav>',
    '    </div>',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

/** Removes characters that make a title unusable in `<title>`/toolbars. */
export function normalizeDocumentTitle(value: string, fallback = '未命名文档'): string {
  const cleaned = stripControlCharacters(value).trim();
  return cleaned.length > 0 ? cleaned : fallback;
}
