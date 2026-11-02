/**
 * Wiki-link extraction driven by the marked token tree.
 *
 * The parser never scans the whole document with a regular expression. Every
 * candidate range comes from marked: only inline tokens (`text`) are scanned,
 * so fenced/indented code blocks, inline code spans and HTML blocks can never
 * contribute a link. Offsets are derived from each token's `raw` slice inside
 * its parent token, which lets the index report 1-based line/column positions
 * for editor navigation.
 *
 * Marked normalises `\r\n`/`\r` to `\n` while lexing, so the source is
 * normalised the same way before offsets are computed.
 */

import { Lexer, type Token } from 'marked';
import { workspaceStem } from '../../../shared/paths';
import type { ParsedNote, ParsedWikiLink } from './types';

/** Upper bound for the text between `[[` and `]]` (target plus alias). */
const MAX_INNER_LENGTH = 512;
/** Upper bound for a target segment; longer targets are treated as text. */
const MAX_TARGET_LENGTH = 256;

/**
 * Structural view of a marked token. marked's token union does not expose the
 * nested collections generically, so the walker uses this shape and casts once
 * at the boundary.
 */
interface TokenView {
  type: string;
  raw?: string;
  text?: string;
  depth?: number;
  /** Inline or block children, depending on the token type. */
  tokens?: TokenView[];
  /** List items. */
  items?: TokenView[];
  /** Table header cells. */
  header?: TokenView[];
  /** Table body rows. */
  rows?: TokenView[][];
}

interface ParseContext {
  links: ParsedWikiLink[];
  lineStarts: readonly number[];
}

/** Replaces CRLF/CR with LF and drops a leading BOM, matching marked's lexer. */
export function normalizeMarkdown(markdown: string): string {
  const withoutBom = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  return withoutBom.replace(/\r\n?/g, '\n');
}

/** Parses one note and returns its title plus every wiki-link occurrence. */
export function parseMarkdownNote(path: string, markdown: string): ParsedNote {
  const { links, title } = parseSource(markdown);
  return { path, title: title ?? fallbackTitle(path), links };
}

/** Convenience wrapper for callers that only need the occurrences. */
export function parseWikiLinks(markdown: string): ParsedWikiLink[] {
  return parseSource(markdown).links;
}

function parseSource(markdown: string): { links: ParsedWikiLink[]; title: string | null } {
  const source = normalizeMarkdown(markdown);
  const lineStarts = buildLineStarts(source);
  let tokens: TokenView[];
  try {
    tokens = Lexer.lex(source) as unknown as TokenView[];
  } catch {
    // A pathological document must not take the whole index down.
    return { links: [], title: null };
  }
  const context: ParseContext = { links: [], lineStarts };
  walkBlockTokens(tokens, source, 0, context);
  return { links: context.links, title: extractTitle(tokens) };
}

function buildLineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function positionAt(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((lineStarts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  const lineStart = lineStarts[low] ?? 0;
  return { line: low + 1, column: offset - lineStart + 1 };
}

/**
 * Finds `needle` in `haystack` at or after `from`. Falls back to the cursor
 * when a token cannot be located verbatim (only exotic extension tokens can
 * trigger that) so one odd block cannot corrupt later offsets.
 */
function locate(haystack: string, needle: string, from: number): number {
  const cursor = Math.max(0, Math.min(from, haystack.length));
  if (needle.length === 0) return cursor;
  const found = haystack.indexOf(needle, cursor);
  return found >= 0 ? found : cursor;
}

function walkBlockTokens(
  tokens: readonly TokenView[],
  container: string,
  containerStart: number,
  context: ParseContext,
): void {
  let cursor = 0;
  for (const token of tokens) {
    const raw = token.raw ?? '';
    if (raw.length === 0) continue;
    const relative = locate(container, raw, cursor);
    cursor = relative + raw.length;
    walkBlockToken(token, containerStart + relative, context);
  }
}

function walkBlockToken(token: TokenView, start: number, context: ParseContext): void {
  switch (token.type) {
    case 'paragraph':
    case 'text':
    case 'heading':
    case 'lheading':
      walkInlineContent(token, start, context);
      return;
    case 'blockquote':
    case 'list_item':
      walkBlockTokens(token.tokens ?? [], token.raw ?? '', start, context);
      return;
    case 'list':
      walkListItems(token, start, context);
      return;
    case 'table':
      walkTable(token, start, context);
      return;
    default:
      // code, fences, html, hr, def, space: never contain rendered inline text.
      return;
  }
}

function walkInlineContent(token: TokenView, start: number, context: ParseContext): void {
  const raw = token.raw ?? '';
  const text = typeof token.text === 'string' ? token.text : raw;
  const relative = text.length > 0 ? locate(raw, text, 0) : 0;
  walkInlineTokens(token.tokens ?? [], raw, start, relative, context);
}

function walkInlineTokens(
  tokens: readonly TokenView[],
  container: string,
  containerStart: number,
  initialCursor: number,
  context: ParseContext,
): void {
  let cursor = initialCursor;
  for (const token of tokens) {
    const raw = token.raw ?? '';
    if (raw.length === 0) continue;
    const relative = locate(container, raw, cursor);
    cursor = relative + raw.length;
    const start = containerStart + relative;

    if (token.type === 'text') {
      scanWikiLinks(raw, start, context);
      continue;
    }
    if (
      token.type === 'codespan' ||
      token.type === 'html' ||
      token.type === 'image' ||
      token.type === 'escape' ||
      token.type === 'br' ||
      token.type === 'checkbox'
    ) {
      continue;
    }
    const children = token.tokens;
    if (children && children.length > 0) {
      walkInlineTokens(children, raw, start, 0, context);
    }
  }
}

function walkListItems(token: TokenView, start: number, context: ParseContext): void {
  const raw = token.raw ?? '';
  let cursor = 0;
  for (const item of token.items ?? []) {
    const itemRaw = item.raw ?? '';
    if (itemRaw.length === 0) continue;
    const relative = locate(raw, itemRaw, cursor);
    cursor = relative + itemRaw.length;
    walkBlockTokens(item.tokens ?? [], itemRaw, start + relative, context);
  }
}

function walkTable(token: TokenView, start: number, context: ParseContext): void {
  const raw = token.raw ?? '';
  let cursor = 0;
  const visit = (cell: TokenView | undefined): void => {
    if (!cell) return;
    const text = typeof cell.text === 'string' ? cell.text : '';
    if (text.length === 0) return;
    const relative = locate(raw, text, cursor);
    cursor = relative + text.length;
    walkInlineTokens(cell.tokens ?? [], raw, start, relative, context);
  };
  for (const cell of token.header ?? []) visit(cell);
  for (const row of token.rows ?? []) {
    for (const cell of row) visit(cell);
  }
}

/**
 * Scans one inline `text` token for `[[target]]`, `[[dir/target]]` and
 * `[[target|alias]]`. The chunk is already known to be rendered inline text,
 * so code spans and code blocks are excluded by construction.
 */
function scanWikiLinks(chunk: string, start: number, context: ParseContext): void {
  let index = 0;
  while (index < chunk.length) {
    const open = chunk.indexOf('[[', index);
    if (open < 0) return;
    // `![[...]]` is an embed, not a note link.
    if (open > 0 && chunk.charAt(open - 1) === '!') {
      index = open + 2;
      continue;
    }
    const close = chunk.indexOf(']]', open + 2);
    if (close < 0) return;
    const inner = chunk.slice(open + 2, close);
    index = close + 2;
    if (inner.length === 0 || inner.length > MAX_INNER_LENGTH) continue;
    if (inner.includes('[') || inner.includes(']') || inner.includes('\n')) continue;

    const parsed = parseInner(inner);
    if (!parsed) continue;

    const offset = start + open;
    const { line, column } = positionAt(context.lineStarts, offset);
    context.links.push({
      raw: chunk.slice(open, close + 2),
      target: parsed.target,
      alias: parsed.alias,
      line,
      column,
      offset,
    });
  }
}

function parseInner(inner: string): { target: string; alias: string | null } | null {
  const pipe = inner.indexOf('|');
  const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  if (target.length === 0 || target.length > MAX_TARGET_LENGTH) return null;
  if (target.includes('\u0000')) return null;
  const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : '';
  return { target, alias: alias.length > 0 ? alias : null };
}

function extractTitle(tokens: readonly TokenView[]): string | null {
  for (const token of tokens) {
    const isTopHeading =
      (token.type === 'heading' && token.depth === 1) || token.type === 'lheading';
    if (!isTopHeading) continue;
    const text = collapseWhitespace(inlinePlainText(token.tokens));
    if (text.length > 0) return text;
  }
  return null;
}

function inlinePlainText(tokens: readonly TokenView[] | undefined): string {
  if (!tokens) return '';
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape':
      case 'codespan':
        out += token.text ?? '';
        break;
      case 'br':
        out += ' ';
        break;
      case 'html':
      case 'image':
      case 'checkbox':
        break;
      default: {
        const children = token.tokens;
        if (children && children.length > 0) out += inlinePlainText(children);
        else if (typeof token.text === 'string') out += token.text;
        break;
      }
    }
  }
  return out;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function fallbackTitle(path: string): string {
  if (path.length === 0) return '';
  try {
    return workspaceStem(path);
  } catch {
    return path;
  }
}

/** Re-exported so callers do not need to import `marked` just for typing. */
export type { Token as MarkedToken };
