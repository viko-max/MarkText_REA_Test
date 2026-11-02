/**
 * Pure resolution of wiki-link targets against the set of real notes.
 *
 * Rules (documented because the UI depends on them):
 * 1. A target without `/` matches note file stems (case-insensitive on
 *    Windows). Exactly one match resolves; several matches are reported as
 *    `ambiguous` with the candidate list; none is `missing`.
 * 2. A target with `/` is a workspace path. An exact path match wins;
 *    otherwise the target is matched as a path suffix, which is how a user
 *    disambiguates two notes that share a file name (`[[b/note]]`).
 * 3. `.md` / `.markdown` may be present or omitted.
 *
 * Resolution is workspace-global, not relative to the source note: the same
 * target text means the same note everywhere.
 */

import { workspaceStem } from '../../../shared/paths';
import type { NoteDescriptor, TargetResolution } from './types';

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

/** Normalises user-typed target text into a workspace-path-shaped key. */
export function normalizeWikiTarget(target: string): string {
  let value = target.trim().replace(/\\/g, '/');
  while (value.startsWith('./')) value = value.slice(2);
  value = value.replace(/^\/+/, '');
  value = value.replace(/\/{2,}/g, '/');
  value = value.replace(/\/+$/, '');
  return value;
}

/** Lower-case target without a Markdown extension, used for matching. */
export function targetPathKey(target: string): string {
  return normalizeWikiTarget(target).toLowerCase().replace(MARKDOWN_EXTENSION, '');
}

export function describeNote(path: string): NoteDescriptor {
  const stem = workspaceStem(path);
  return {
    path,
    stem,
    stemKey: stem.toLowerCase(),
    keyNoExtension: path.toLowerCase().replace(MARKDOWN_EXTENSION, ''),
  };
}

export function describeNotes(paths: readonly string[]): NoteDescriptor[] {
  return paths.map(describeNote).sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

export function resolveWikiTarget(
  target: string,
  notes: readonly NoteDescriptor[],
): TargetResolution {
  const normalized = normalizeWikiTarget(target);
  const key = targetPathKey(target);

  if (key.length === 0) {
    return { normalized, resolution: 'missing', resolvedPath: null, candidates: [] };
  }

  const pick = (matches: readonly NoteDescriptor[]): TargetResolution => {
    if (matches.length === 1) {
      const only = matches[0];
      return {
        normalized,
        resolution: 'resolved',
        resolvedPath: only ? only.path : null,
        candidates: only ? [only.path] : [],
      };
    }
    if (matches.length > 1) {
      return {
        normalized,
        resolution: 'ambiguous',
        resolvedPath: null,
        candidates: matches.map((note) => note.path).sort(comparePaths),
      };
    }
    return { normalized, resolution: 'missing', resolvedPath: null, candidates: [] };
  };

  if (key.includes('/')) {
    const exact = notes.filter((note) => note.keyNoExtension === key);
    if (exact.length > 0) return pick(exact);
    const suffix = `/${key}`;
    return pick(notes.filter((note) => note.keyNoExtension.endsWith(suffix)));
  }

  return pick(notes.filter((note) => note.stemKey === key));
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
