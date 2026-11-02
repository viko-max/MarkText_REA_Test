/**
 * Pure, renderer-side wiki target lookup.
 *
 * This mirrors the main-process resolver rules exactly so that completion and
 * click handling agree with the persisted index: a bare target matches note
 * stems (unique only), a target containing `/` matches a workspace path or one
 * of its suffixes, and duplicate matches stay ambiguous with their candidates.
 */

import type { LinkResolution } from '../../../shared/contracts';

export interface NoteDescriptorView {
  path: string;
  stem: string;
  stemKey: string;
  keyNoExtension: string;
}

export interface WikiTargetLookup {
  target: string;
  resolution: LinkResolution;
  resolvedPath: string | null;
  candidates: string[];
}

const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

export function basenameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
}

export function stemOf(path: string): string {
  const base = basenameOf(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function pathWithoutExtension(path: string): string {
  return path.replace(MARKDOWN_EXTENSION, '');
}

export function normalizeWikiTarget(target: string): string {
  let value = target.trim().replace(/\\/g, '/');
  while (value.startsWith('./')) value = value.slice(2);
  value = value.replace(/^\/+/, '');
  value = value.replace(/\/{2,}/g, '/');
  value = value.replace(/\/+$/, '');
  return value;
}

export function targetPathKey(target: string): string {
  return normalizeWikiTarget(target).toLowerCase().replace(MARKDOWN_EXTENSION, '');
}

export function describeNotePaths(paths: readonly string[]): NoteDescriptorView[] {
  return paths
    .map((path) => {
      const stem = stemOf(path);
      return {
        path,
        stem,
        stemKey: stem.toLowerCase(),
        keyNoExtension: pathWithoutExtension(path).toLowerCase(),
      };
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

export function lookupWikiTarget(
  target: string,
  notes: readonly NoteDescriptorView[],
): WikiTargetLookup {
  const key = targetPathKey(target);

  const pick = (matches: readonly NoteDescriptorView[]): WikiTargetLookup => {
    if (matches.length === 1) {
      return {
        target,
        resolution: 'resolved',
        resolvedPath: matches[0]?.path ?? null,
        candidates: matches[0] ? [matches[0].path] : [],
      };
    }
    if (matches.length > 1) {
      return {
        target,
        resolution: 'ambiguous',
        resolvedPath: null,
        candidates: matches.map((note) => note.path).sort(comparePaths),
      };
    }
    return { target, resolution: 'missing', resolvedPath: null, candidates: [] };
  };

  if (key.length === 0) {
    return { target, resolution: 'missing', resolvedPath: null, candidates: [] };
  }

  if (key.includes('/')) {
    const exact = notes.filter((note) => note.keyNoExtension === key);
    if (exact.length > 0) return pick(exact);
    const suffix = `/${key}`;
    return pick(notes.filter((note) => note.keyNoExtension.endsWith(suffix)));
  }

  return pick(notes.filter((note) => note.stemKey === key));
}

/**
 * Chooses the shortest target text that still resolves uniquely to `path`.
 * Used when inserting a completion: same-folder duplicates get the full path.
 */
export function uniqueTargetFor(path: string, notes: readonly NoteDescriptorView[]): string {
  const stem = stemOf(path);
  const sameStem = notes.filter((note) => note.stemKey === stem.toLowerCase());
  return sameStem.length <= 1 ? stem : pathWithoutExtension(path);
}

export function isWikiLinkResolution(value: string | undefined): value is LinkResolution {
  return value === 'resolved' || value === 'ambiguous' || value === 'missing';
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
