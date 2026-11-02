/**
 * The single Markdown → HTML pipeline.
 *
 * `MarkdownRenderPipeline.render()` is the only producer of document HTML in the
 * app: the in-app preview embeds its `html` in an `iframe[srcDoc]` and the export
 * service writes the same string. It parses GFM with marked, resolves images and
 * wiki links through injected async resolvers, sanitises the result with
 * DOMPurify, derives heading anchors/outline, and assembles the document with
 * the shared theme CSS.
 */

import { Marked } from 'marked';
import type { RendererObject, Token, TokenizerAndRendererExtension } from 'marked';
import { workspaceStem } from '../../../shared/paths';
import { createHeadingSlugger, type HeadingSlugger } from './anchors';
import { assembleHtmlDocument, normalizeDocumentTitle } from './document';
import { escapeAttribute, escapeHtml, sanitizeUrl } from './escape';
import { MarkdownRenderError } from './errors';
import {
  createIpcImageResourceResolver,
  DEFAULT_MAX_IMAGE_BYTES,
  findImagesReadBridge,
  resolveImageResources,
} from './resources';
import { getDefaultHtmlSanitizer } from './sanitize';
import { computeRenderSignature } from './signature';
import { buildThemeCss, normalizeLayout, normalizeTheme } from './theme';
import type {
  HtmlSanitizer,
  ImageResourceResolver,
  ImageStatus,
  OutlineEntry,
  RenderInput,
  RenderResult,
  RenderWarning,
  ResolvedImage,
  WikiLinkResolution,
  WikiLinkResolver,
  WikiLinkToken,
} from './types';
import {
  createWikiLinkExtension,
  isWikiLinkToken,
  resolveWikiLinkTokens,
  WIKI_LINK_TOKEN_TYPE,
} from './wikilinks';

export { DEFAULT_MAX_IMAGE_BYTES };

export interface MarkdownRenderPipelineOptions {
  /** Async image loader, usually backed by `window.markdownLite.images.read`. */
  resolveImage?: ImageResourceResolver | null;
  /** Link-module hook; without it `[[wikilinks]]` stay literal text. */
  resolveWikiLink?: WikiLinkResolver | null;
  /** Override for tests; defaults to DOMPurify bound to the current document. */
  sanitize?: HtmlSanitizer;
  maxImageBytes?: number;
}

interface RenderState {
  images: ReadonlyMap<string, ResolvedImage>;
  slugger: HeadingSlugger;
  outline: OutlineEntry[];
  blockedLinks: Set<string>;
}

function walkTokens(value: unknown, visit: (token: Token) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkTokens(item, visit);
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const token = value as Record<string, unknown>;
  if (typeof token.type === 'string') visit(value as Token);
  for (const key of ['tokens', 'items', 'header', 'rows', 'cells']) {
    if (key in token) walkTokens(token[key], visit);
  }
}

/** Plain text of inline tokens, used for anchors, outline and image alt text. */
export function plainTextFromTokens(tokens: readonly Token[]): string {
  let text = '';
  for (const value of tokens) {
    const token = value as unknown as { type: string; text?: string; raw?: string; tokens?: Token[] };
    switch (token.type) {
      case 'br':
        text += ' ';
        break;
      case 'codespan':
        text += token.text ?? '';
        break;
      case 'image':
        text += Array.isArray(token.tokens) ? plainTextFromTokens(token.tokens) : (token.text ?? '');
        break;
      case 'html':
        text += ' ';
        break;
      default:
        if (Array.isArray(token.tokens) && token.tokens.length > 0) text += plainTextFromTokens(token.tokens);
        else if (typeof token.text === 'string') text += token.text;
        else if (typeof token.raw === 'string') text += token.raw;
    }
  }
  return text.replace(/\s+/g, ' ').trim();
}

function imageStatusLabel(status: ImageStatus): string {
  if (status === 'missing') return '图片缺失';
  if (status === 'too_large') return '图片过大';
  return '图片被拒绝';
}

function createRenderer(state: RenderState): RendererObject {
  return {
    heading(token) {
      const text = plainTextFromTokens(token.tokens);
      const id = state.slugger.slug(text);
      state.outline.push({ id, text, depth: token.depth });
      const inner = this.parser.parseInline(token.tokens);
      return [
        `<h${token.depth} class="mdl-heading" id="${escapeAttribute(id)}">`,
        inner,
        `<a class="mdl-heading-anchor" href="#${escapeAttribute(id)}" aria-hidden="true" tabindex="-1">#</a>`,
        `</h${token.depth}>\n`,
      ].join('');
    },

    html(token) {
      return escapeHtml(token.text);
    },

    link(token) {
      const inner = this.parser.parseInline(token.tokens);
      const safe = sanitizeUrl(token.href, 'link');
      if (safe === null) {
        state.blockedLinks.add(token.href);
        return `<span class="mdl-link-blocked">${inner}</span>`;
      }
      const attributes = [`class="mdl-link"`, `href="${escapeAttribute(safe)}"`];
      if (token.title) attributes.push(`title="${escapeAttribute(token.title)}"`);
      if (/^(?:https?:)?\/\//i.test(safe)) {
        attributes.push('target="_blank"', 'rel="noopener noreferrer"', 'data-mdl-external="true"');
      }
      return `<a ${attributes.join(' ')}>${inner}</a>`;
    },

    image(token) {
      const alt = plainTextFromTokens(token.tokens) || token.text;
      const title = token.title ? ` title="${escapeAttribute(token.title)}"` : '';
      const image = state.images.get(token.href);

      if (image?.status === 'embedded' && image.dataUri) {
        return [
          `<img class="mdl-image" src="${escapeAttribute(image.dataUri)}" alt="${escapeAttribute(alt)}"`,
          ` data-mdl-image="embedded" loading="lazy" decoding="async"${title} />`,
        ].join('');
      }

      if (image?.status === 'external') {
        const safe = sanitizeUrl(token.href, 'image');
        if (safe !== null) {
          return [
            `<img class="mdl-image mdl-image-external" src="${escapeAttribute(safe)}" alt="${escapeAttribute(alt)}"`,
            ` data-mdl-image="external" loading="lazy" decoding="async"${title} />`,
          ].join('');
        }
      }

      const status = image?.status === 'unsafe' || image?.status === 'too_large' ? image.status : 'missing';
      const detail = `${imageStatusLabel(status)}：${image?.path ?? token.href}`;
      const label = alt.length > 0 ? alt : token.href;
      return [
        `<span class="mdl-image-missing" role="img" aria-label="${escapeAttribute(`${label}（${detail}）`)}"`,
        ` data-mdl-image="${status}">`,
        escapeHtml(label),
        `<span class="mdl-image-missing-detail">（${escapeHtml(detail)}）</span>`,
        '</span>',
      ].join('');
    },

    code(token) {
      const language = (token.lang ?? '').trim().split(/\s+/)[0] ?? '';
      const safeLanguage = language.replace(/[^a-zA-Z0-9_+#.-]/g, '').slice(0, 32);
      const className = safeLanguage.length > 0 ? ` class="language-${safeLanguage}"` : '';
      return `<pre class="mdl-code-block"><code${className}>${escapeHtml(token.text)}</code></pre>\n`;
    },

    codespan(token) {
      return `<code class="mdl-code-inline">${escapeHtml(token.text)}</code>`;
    },
  };
}

function fallbackTitle(documentPath: string): string {
  if (documentPath.length === 0) return '';
  try {
    return workspaceStem(documentPath);
  } catch {
    return '';
  }
}

function resolveDocumentTitle(title: string | null | undefined, firstHeading: string, documentPath: string): string {
  const explicit = typeof title === 'string' ? title.trim() : '';
  if (explicit.length > 0) return normalizeDocumentTitle(explicit);
  if (firstHeading.length > 0) return normalizeDocumentTitle(firstHeading);
  return normalizeDocumentTitle(fallbackTitle(documentPath));
}

/**
 * Builds the shared render pipeline. Preview and export both consume its
 * `RenderResult`; nothing else renders Markdown to HTML.
 */
export class MarkdownRenderPipeline {
  private readonly resolveImage: ImageResourceResolver | null;
  private readonly resolveWikiLink: WikiLinkResolver | null;
  private readonly sanitizeOverride: HtmlSanitizer | null;
  private readonly maxImageBytes: number;

  constructor(options: MarkdownRenderPipelineOptions = {}) {
    this.resolveImage = options.resolveImage ?? null;
    this.resolveWikiLink = options.resolveWikiLink ?? null;
    this.sanitizeOverride = options.sanitize ?? null;
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  }

  async render(input: RenderInput): Promise<RenderResult> {
    if (typeof input?.markdown !== 'string') {
      throw new MarkdownRenderError('invalid_markdown', 'markdown must be a string');
    }
    const documentPath = typeof input.documentPath === 'string' ? input.documentPath : '';
    const theme = normalizeTheme(input.theme);
    const layout = normalizeLayout(input.layout);

    const imageHrefs: string[] = [];
    const wikiTokens: WikiLinkToken[] = [];
    const resolutions = new Map<string, WikiLinkResolution>();

    const lexer = new Marked({ gfm: true, breaks: false, async: false });
    lexer.use({ extensions: [this.createExtension(resolutions)] });

    let tokens: Token[];
    try {
      tokens = lexer.lexer(input.markdown);
    } catch (error) {
      throw new MarkdownRenderError('render_failed', 'Markdown could not be tokenised', { cause: error });
    }

    walkTokens(tokens, (token) => {
      if (token.type === WIKI_LINK_TOKEN_TYPE && isWikiLinkToken(token)) {
        wikiTokens.push({ target: token.target, alias: token.alias, raw: token.raw });
      } else if (token.type === 'image') {
        const href = (token as unknown as { href?: unknown }).href;
        if (typeof href === 'string') imageHrefs.push(href);
      }
    });

    const [imageSummary, wikiResolutions] = await Promise.all([
      resolveImageResources({
        hrefs: imageHrefs,
        documentPath,
        resolver: this.resolveImage,
        maxBytes: this.maxImageBytes,
      }),
      resolveWikiLinkTokens(wikiTokens, this.resolveWikiLink),
    ]);
    for (const [raw, resolution] of wikiResolutions) resolutions.set(raw, resolution);

    const state: RenderState = {
      images: imageSummary.images,
      slugger: createHeadingSlugger(),
      outline: [],
      blockedLinks: new Set<string>(),
    };

    let bodyHtml: string;
    try {
      const parser = new Marked({ gfm: true, breaks: false, async: false });
      parser.use({ extensions: [this.createExtension(resolutions)], renderer: createRenderer(state) });
      const dirty = parser.parser(tokens);
      const sanitize = this.sanitizeOverride ?? getDefaultHtmlSanitizer();
      bodyHtml = sanitize(dirty);
    } catch (error) {
      if (error instanceof MarkdownRenderError) throw error;
      throw new MarkdownRenderError('render_failed', 'Markdown could not be rendered', { cause: error });
    }

    const sidebarHtml = input.sidebarHtml
      ? (this.sanitizeOverride ?? getDefaultHtmlSanitizer())(input.sidebarHtml)
      : null;

    const firstHeading = state.outline.find((entry) => entry.depth === 1) ?? state.outline[0];
    const title = resolveDocumentTitle(input.title, firstHeading?.text ?? '', documentPath);
    const css = buildThemeCss(theme, layout);
    const signature = computeRenderSignature({
      documentPath,
      markdown: input.markdown,
      theme,
      layout,
      assets: imageSummary.assets,
    });

    const warnings: RenderWarning[] = [...imageSummary.warnings];
    for (const href of state.blockedLinks) {
      warnings.push({ code: 'blocked_link', message: `已阻止不安全的链接地址：${href}`, detail: null });
    }
    const rawVariables = input.theme?.customVariables ?? {};
    for (const key of Object.keys(rawVariables)) {
      if (!(key in theme.customVariables)) {
        warnings.push({
          code: 'theme_variable_ignored',
          message: `主题变量被忽略：${key}`,
          detail: '自定义变量必须以 --mdl- 开头，且只能包含安全字符。',
        });
      }
    }

    const html = assembleHtmlDocument({
      title,
      documentPath,
      bodyHtml,
      css,
      theme,
      layout,
      outline: state.outline,
      signature,
      sidebarHtml,
    });

    return {
      signature,
      html,
      bodyHtml,
      css,
      title,
      outline: state.outline,
      dependencies: imageSummary.dependencies,
      assets: imageSummary.assets,
      warnings,
    };
  }

  private createExtension(resolutions: ReadonlyMap<string, WikiLinkResolution>): TokenizerAndRendererExtension {
    return createWikiLinkExtension(resolutions);
  }
}

/**
 * Convenience factory for the renderer: wires the image resolver to the
 * `window.markdownLite.images.read` bridge when the preload exposes it.
 */
export function createAppMarkdownRenderPipeline(
  options: Omit<MarkdownRenderPipelineOptions, 'resolveImage'> & {
    scope?: unknown;
    resolveImage?: ImageResourceResolver | null;
  } = {},
): MarkdownRenderPipeline {
  const { scope, ...rest } = options;
  const resolver = rest.resolveImage ?? createIpcImageResourceResolver(findImagesReadBridge(scope ?? globalThis));
  return new MarkdownRenderPipeline({ ...rest, resolveImage: resolver });
}
