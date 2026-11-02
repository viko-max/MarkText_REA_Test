/**
 * Pure wiki-link completion helpers.
 *
 * `detectWikiLinkQuery` decides whether the caret sits inside an unfinished
 * `[[...]]` (or inside an existing target) and returns the replacement range.
 * `completeNotes` ranks real indexed notes. Neither function touches the DOM,
 * so both are unit-tested without a browser.
 */

import { describeNotePaths, stemOf, uniqueTargetFor, type NoteDescriptorView } from './lookup';

export interface WikiNoteSummary {
  path: string;
  title: string;
}

export interface WikiQuery {
  /** Offset of the opening `[[`. */
  start: number;
  /** Offset just after a closing `]]`, or the caret when none is present. */
  end: number;
  /** Offset where the typed query text starts (`start + 2`). */
  queryStart: number;
  query: string;
}

export interface WikiCompletionItem {
  path: string;
  title: string;
  /** Secondary line shown in the completion list. */
  detail: string;
  score: number;
}

export interface WikiCompletionInsertion {
  text: string;
  start: number;
  end: number;
}

const MAX_LOOKBEHIND = 2048;

/**
 * Returns the completion query for `caret`, or `null` when the caret is not
 * inside a wiki-link target.
 */
export function detectWikiLinkQuery(text: string, caret: number): WikiQuery | null {
  if (!Number.isFinite(caret)) return null;
  const position = Math.max(0, Math.min(Math.trunc(caret), text.length));
  const windowStart = Math.max(0, position - MAX_LOOKBEHIND);
  const open = text.lastIndexOf('[[', position - 1);
  if (open < 0 || open < windowStart) return null;
  if (open > 0 && text.charAt(open - 1) === '!') return null;
  if (isEscaped(text, open)) return null;

  const queryStart = open + 2;
  const beforeCaret = text.slice(queryStart, position);
  if (beforeCaret.includes(']]')) return null;
  if (beforeCaret.includes('\n') || beforeCaret.includes('\r')) return null;
  if (beforeCaret.includes('|')) return null;

  const close = text.indexOf(']]', position);
  const end =
    close >= 0 && !text.slice(position, close).includes('\n') ? close + 2 : position;

  return { start: open, end, queryStart, query: beforeCaret };
}

export function completeNotes(
  notes: readonly WikiNoteSummary[],
  query: string,
  limit = 8,
): WikiCompletionItem[] {
  const needle = query.trim().replace(/\\/g, '/').toLowerCase();
  const scored: Array<WikiCompletionItem & { depth: number }> = [];

  for (const note of notes) {
    const path = note.path.toLowerCase();
    const title = note.title.toLowerCase();
    const stem = stemOf(note.path).toLowerCase();
    const depth = note.path.split('/').length;

    let score: number;
    if (needle.length === 0) score = 0;
    else if (stem.startsWith(needle)) score = 1;
    else if (path.startsWith(needle)) score = 2;
    else if (title.startsWith(needle)) score = 3;
    else if (stem.includes(needle)) score = 4;
    else if (title.includes(needle)) score = 5;
    else if (path.includes(needle)) score = 6;
    else continue;

    scored.push({
      path: note.path,
      title: note.title.length > 0 ? note.title : stemOf(note.path),
      detail: note.path,
      score,
      depth,
    });
  }

  scored.sort(
    (left, right) =>
      left.score - right.score ||
      left.depth - right.depth ||
      (left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );

  return scored.slice(0, Math.max(0, limit)).map((item) => ({
    path: item.path,
    title: item.title,
    detail: item.detail,
    score: item.score,
  }));
}

/** Builds the replacement text and range for accepting a completion item. */
export function buildCompletionInsertion(
  query: WikiQuery,
  item: WikiCompletionItem,
  notes: readonly WikiNoteSummary[],
): WikiCompletionInsertion {
  const descriptors: NoteDescriptorView[] = describeNotePaths(notes.map((note) => note.path));
  const target = uniqueTargetFor(item.path, descriptors);
  return { text: `[[${target}]]`, start: query.start, end: query.end };
}

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text.charAt(cursor) === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}
