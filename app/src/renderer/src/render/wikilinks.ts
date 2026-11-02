/**
 * `[[wikilink]]` tokenisation and rendering hooks.
 *
 * The pipeline owns the token and the markup, but resolution belongs to the
 * link module: an injected resolver turns a token into a state (`resolved`,
 * `ambiguous`, `missing`) and an optional href. Without a resolver the token is
 * emitted as literal text, so nothing is invented and code samples keep their
 * exact spelling.
 */

import type { TokenizerAndRendererExtension } from 'marked';
import { escapeAttribute, escapeHtml, sanitizeUrl } from './escape';
import type { WikiLinkResolution, WikiLinkResolver, WikiLinkToken } from './types';

export const WIKI_LINK_TOKEN_TYPE = 'mdlWikiLink';

const WIKI_LINK_PATTERN = /^\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*))?\]\]/;

export interface WikiLinkTokenData extends WikiLinkToken {
  type: typeof WIKI_LINK_TOKEN_TYPE;
  raw: string;
}

export function isWikiLinkToken(token: { type: string }): token is WikiLinkTokenData {
  return token.type === WIKI_LINK_TOKEN_TYPE;
}

/** Resolves each distinct token once; resolver errors leave the token literal. */
export async function resolveWikiLinkTokens(
  tokens: readonly WikiLinkToken[],
  resolver: WikiLinkResolver | null,
): Promise<Map<string, WikiLinkResolution>> {
  const resolutions = new Map<string, WikiLinkResolution>();
  if (!resolver) return resolutions;

  for (const token of tokens) {
    if (resolutions.has(token.raw)) continue;
    try {
      const resolution = await resolver({ target: token.target, alias: token.alias, raw: token.raw });
      if (resolution) resolutions.set(token.raw, resolution);
    } catch {
      // A failing resolver must not break rendering; the token stays literal.
    }
  }
  return resolutions;
}

function renderState(
  state: WikiLinkResolution['state'],
  token: WikiLinkTokenData,
  label: string,
  title: string | null,
  href: string | null,
): string {
  const classes = `mdl-wikilink mdl-wikilink-${state}`;
  const common = [
    `class="${classes}"`,
    `data-mdl-wikilink="${state}"`,
    `data-mdl-target="${escapeAttribute(token.target)}"`,
  ];
  if (title) common.push(`title="${escapeAttribute(title)}"`);

  if (state === 'resolved' && href) {
    return `<a ${common.join(' ')} href="${escapeAttribute(href)}">${escapeHtml(label)}</a>`;
  }
  return `<span ${common.join(' ')}>${escapeHtml(label)}</span>`;
}

/** Marked inline extension; the resolution map is closed over per render. */
export function createWikiLinkExtension(
  resolutions: ReadonlyMap<string, WikiLinkResolution>,
): TokenizerAndRendererExtension {
  return {
    name: WIKI_LINK_TOKEN_TYPE,
    level: 'inline',
    start(source: string): number | undefined {
      const index = source.indexOf('[[');
      return index >= 0 ? index : undefined;
    },
    tokenizer(source: string): WikiLinkTokenData | undefined {
      const match = WIKI_LINK_PATTERN.exec(source);
      if (!match) return undefined;
      const target = (match[1] ?? '').trim();
      if (target.length === 0) return undefined;
      const alias = match[2] ? match[2].trim() : null;
      return {
        type: WIKI_LINK_TOKEN_TYPE,
        raw: match[0],
        target,
        alias: alias && alias.length > 0 ? alias : null,
      };
    },
    renderer(token): string {
      const data = token as unknown as WikiLinkTokenData;
      const resolution = resolutions.get(data.raw);
      if (!resolution) return escapeHtml(data.raw);

      const label = data.alias ?? resolution.label ?? data.target;
      const href = resolution.href ? sanitizeUrl(resolution.href, 'link') : null;
      if (resolution.state === 'resolved' && href === null) {
        return renderState('missing', data, label, resolution.title ?? '链接目标不可用', null);
      }
      return renderState(resolution.state, data, label, resolution.title ?? null, href);
    },
  };
}
