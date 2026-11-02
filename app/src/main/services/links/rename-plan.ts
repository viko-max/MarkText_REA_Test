/**
 * Pure rename-impact analysis for wiki links.
 *
 * `planRename` never touches the filesystem and never performs a rename. It
 * takes the current note contents, decides which `[[wikilinks]]` can be
 * rewritten without guessing, and returns:
 *
 * - `referenceEdits`: aggregated, user-facing edit report;
 * - `skippedReferences`: links that mention the old note but cannot be
 *   rewritten safely (ambiguous, unresolvable, or failed verification);
 * - `rewrites`: full replacement Markdown for every document that has edits,
 *   together with the untouched original, so the caller can run each write as a
 *   compare-and-swap inside its own transaction.
 *
 * The integration layer is responsible for the file move and the writes.
 */

import type { LinkReferenceEdit, SkippedReference } from '../../../shared/contracts';
import { isMarkdownPath, isWorkspaceRelativePath, workspaceStem } from '../../../shared/paths';
import { describeNotes, normalizeWikiTarget, resolveWikiTarget, targetPathKey } from './resolver';
import { normalizeMarkdown, parseMarkdownNote } from './wiki-parser';
import type { ParsedNote, ParsedWikiLink } from './types';

export interface RenamePlanDocument {
  path: string;
  markdown: string;
}

export interface RenamePlanRequest {
  /** Every Markdown document in the workspace, including `fromPath`. */
  documents: readonly RenamePlanDocument[];
  fromPath: string;
  toPath: string;
}

export interface RenameRewrite {
  documentPath: string;
  /** Untouched document content the rewrite was derived from. */
  originalMarkdown: string;
  /** Document content after all safe link edits were applied. */
  markdown: string;
}

export interface RenamePlan {
  fromPath: string;
  toPath: string;
  referenceEdits: LinkReferenceEdit[];
  skippedReferences: SkippedReference[];
  rewrites: RenameRewrite[];
}

interface LinkOffset {
  link: ParsedWikiLink;
  /** Offset of the link inside the *original* Markdown string. */
  offset: number;
}

interface PendingEdit extends LinkOffset {
  newTarget: string;
  replacement: string;
}

interface AppliedEdit {
  documentPath: string;
  from: string;
  to: string;
}

export function planRename(request: RenamePlanRequest): RenamePlan {
  const { fromPath, toPath } = request;
  if (!isWorkspaceRelativePath(fromPath) || !isMarkdownPath(fromPath)) {
    throw new Error('planRename: fromPath must be a workspace-relative Markdown path');
  }
  if (!isWorkspaceRelativePath(toPath) || !isMarkdownPath(toPath)) {
    throw new Error('planRename: toPath must be a workspace-relative Markdown path');
  }
  if (fromPath === toPath) {
    throw new Error('planRename: toPath must differ from fromPath');
  }

  const notes = new Map<string, ParsedNote>();
  const sources = new Map<string, string>();
  for (const document of request.documents) {
    if (!isWorkspaceRelativePath(document.path) || !isMarkdownPath(document.path)) continue;
    if (notes.has(document.path)) continue;
    notes.set(document.path, parseMarkdownNote(document.path, document.markdown));
    sources.set(document.path, document.markdown);
  }
  if (!notes.has(fromPath)) {
    throw new Error('planRename: documents must include fromPath');
  }

  const beforePaths = [...notes.keys()];
  const beforeDescriptors = describeNotes(beforePaths);
  const afterPaths = beforePaths.map((path) => (path === fromPath ? toPath : path));
  const afterDescriptors = describeNotes(afterPaths);

  const applied: AppliedEdit[] = [];
  const skipped: SkippedReference[] = [];
  const rewrites: RenameRewrite[] = [];
  const oldStemKey = workspaceStem(fromPath).toLowerCase();

  for (const [documentPath, note] of notes) {
    const source = sources.get(documentPath);
    if (source === undefined) continue;

    const pending: PendingEdit[] = [];
    for (const link of note.links) {
      const before = resolveWikiTarget(link.target, beforeDescriptors);
      const resolvesToOld = before.resolution === 'resolved' && before.resolvedPath === fromPath;
      const mentionsOldAmbiguously =
        before.resolution === 'ambiguous' &&
        (before.candidates.includes(fromPath) || refersToOldPath(link.target, fromPath, oldStemKey));
      const mentionsOldButMissing =
        before.resolution === 'missing' && refersToOldPath(link.target, fromPath, oldStemKey);

      if (!resolvesToOld) {
        if (mentionsOldAmbiguously) {
          skipped.push({
            documentPath,
            line: link.line,
            raw: link.raw,
            reason: 'ambiguous',
          });
        } else if (mentionsOldButMissing) {
          skipped.push({
            documentPath,
            line: link.line,
            raw: link.raw,
            reason: 'unresolvable',
          });
        }
        continue;
      }

      const newTarget = buildNewTarget(link.target, toPath);
      if (newTarget === null) {
        skipped.push({ documentPath, line: link.line, raw: link.raw, reason: 'unresolvable' });
        continue;
      }
      const after = resolveWikiTarget(newTarget, afterDescriptors);
      if (after.resolution !== 'resolved' || after.resolvedPath !== toPath) {
        skipped.push({
          documentPath,
          line: link.line,
          raw: link.raw,
          reason: after.resolution === 'ambiguous' ? 'ambiguous' : 'unresolvable',
        });
        continue;
      }

      pending.push({
        link,
        offset: 0,
        newTarget,
        replacement: `[[${newTarget}${link.alias !== null ? `|${link.alias}` : ''}]]`,
      });
    }

    if (pending.length === 0) continue;

    const mapped = mapOffsetsToSource(source, note.links);
    const byOffset = new Map<ParsedWikiLink, number>();
    for (const entry of mapped) byOffset.set(entry.link, entry.offset);

    const edits: PendingEdit[] = [];
    for (const edit of pending) {
      const offset = byOffset.get(edit.link);
      if (offset === undefined || source.slice(offset, offset + edit.link.raw.length) !== edit.link.raw) {
        skipped.push({
          documentPath,
          line: edit.link.line,
          raw: edit.link.raw,
          reason: 'write_failed',
        });
        continue;
      }
      edits.push({ ...edit, offset });
    }
    if (edits.length === 0) continue;

    edits.sort((left, right) => right.offset - left.offset);
    let rewritten = source;
    for (const edit of edits) {
      rewritten =
        rewritten.slice(0, edit.offset) +
        edit.replacement +
        rewritten.slice(edit.offset + edit.link.raw.length);
    }

    rewrites.push({ documentPath, originalMarkdown: source, markdown: rewritten });
    for (const edit of edits) {
      applied.push({ documentPath, from: edit.link.target, to: edit.newTarget });
    }
  }

  return {
    fromPath,
    toPath,
    referenceEdits: aggregateEdits(applied),
    skippedReferences: skipped.sort(
      (left, right) =>
        comparePaths(left.documentPath, right.documentPath) || left.line - right.line,
    ),
    rewrites: rewrites.sort((left, right) =>
      comparePaths(left.documentPath, right.documentPath),
    ),
  };
}

function buildNewTarget(originalTarget: string, toPath: string): string | null {
  const normalised = normalizeWikiTarget(originalTarget);
  if (normalised.length === 0) return null;
  if (normalised.includes('/')) {
    return toPath.replace(/\.(md|markdown)$/i, '');
  }
  const stem = workspaceStem(toPath);
  return stem.length > 0 ? stem : null;
}

function refersToOldPath(target: string, fromPath: string, oldStemKey: string): boolean {
  const key = targetPathKey(target);
  if (key.length === 0) return false;
  const oldKey = targetPathKey(fromPath);
  if (key === oldKey) return true;
  if (key === oldStemKey) return true;
  if (key.endsWith(`/${oldKey}`)) return true;
  return false;
}

/**
 * Maps the parser's offsets (which are relative to the normalised Markdown
 * string) back to offsets in the original string.
 *
 * Wiki links never span a line, so the only difference between the two
 * strings is removed `\r` characters (and a possible BOM). Advancing both
 * cursors in lockstep keeps the mapping exact even when the same token text
 * also appears earlier inside a code span.
 */
function mapOffsetsToSource(original: string, links: readonly ParsedWikiLink[]): LinkOffset[] {
  if (links.length === 0) return [];
  const normalized = normalizeMarkdown(original);
  const hasBom = original.charCodeAt(0) === 0xfeff;
  let originalIndex = hasBom ? 1 : 0;
  let normalizedIndex = 0;
  const sorted = [...links].sort((left, right) => left.offset - right.offset);
  const result: LinkOffset[] = [];

  for (const link of sorted) {
    while (normalizedIndex < link.offset) {
      const isCrLf =
        normalized.charCodeAt(normalizedIndex) === 10 &&
        original.charCodeAt(originalIndex) === 13 &&
        original.charCodeAt(originalIndex + 1) === 10;
      normalizedIndex += 1;
      originalIndex += isCrLf ? 2 : 1;
    }
    result.push({ link, offset: originalIndex });
    normalizedIndex += link.raw.length;
    originalIndex += link.raw.length;
  }
  return result;
}

function aggregateEdits(applied: readonly AppliedEdit[]): LinkReferenceEdit[] {
  const aggregated = new Map<string, LinkReferenceEdit>();
  for (const edit of applied) {
    const key = `${edit.documentPath}\u0000${edit.from}\u0000${edit.to}`;
    const existing = aggregated.get(key);
    if (existing) existing.occurrences += 1;
    else {
      aggregated.set(key, {
        documentPath: edit.documentPath,
        from: edit.from,
        to: edit.to,
        occurrences: 1,
      });
    }
  }
  return [...aggregated.values()].sort(
    (left, right) =>
      comparePaths(left.documentPath, right.documentPath) ||
      comparePaths(left.from, right.from),
  );
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
