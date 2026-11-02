/**
 * Internal link-domain types for the main process.
 *
 * `LinkIndex` and `WikiLink` in `src/shared/contracts.ts` are the IPC surface.
 * The parser and index builder keep a little more information (source offsets,
 * ambiguity candidates) that is either only needed on this side or is carried
 * as an additive field so existing contract consumers keep working.
 */

import type { WorkspaceRelativePath, WikiLink } from '../../../shared/contracts';

/** One `[[target|alias]]` occurrence found inside an inline Markdown range. */
export interface ParsedWikiLink {
  /** Exact source text of the occurrence, e.g. `[[notes/idea|别名]]`. */
  raw: string;
  /** Trimmed target text without the alias, e.g. `notes/idea`. */
  target: string;
  /** Trimmed alias text when the token contains `|`, otherwise `null`. */
  alias: string | null;
  /** 1-based line in the normalised Markdown source. */
  line: number;
  /** 1-based UTF-16 column in the normalised Markdown source. */
  column: number;
  /** 0-based UTF-16 offset of the opening `[` in the normalised source. */
  offset: number;
}

/** A Markdown note after parsing: title plus every wiki-link occurrence. */
export interface ParsedNote {
  path: WorkspaceRelativePath;
  title: string;
  links: ParsedWikiLink[];
}

/** Compact, resolution-ready description of a note file. */
export interface NoteDescriptor {
  path: WorkspaceRelativePath;
  /** File name without the Markdown extension, original case. */
  stem: string;
  /** Lower-case stem used for case-insensitive matching. */
  stemKey: string;
  /** Lower-case full workspace path without the Markdown extension. */
  keyNoExtension: string;
}

export interface TargetResolution {
  /** Normalised target text, extension kept as written. */
  normalized: string;
  resolution: 'resolved' | 'ambiguous' | 'missing';
  resolvedPath: WorkspaceRelativePath | null;
  /** Sorted candidate paths when the target matches more than one note. */
  candidates: WorkspaceRelativePath[];
}

/**
 * A resolved wiki link. `candidates` is additive to the shared `WikiLink`
 * contract: it lets the renderer offer an explicit choice for ambiguous
 * targets instead of guessing.
 */
export interface ResolvedWikiLink extends WikiLink {
  candidates: WorkspaceRelativePath[];
}

/** Non-fatal problem encountered while building the index. */
export interface LinkIndexWarning {
  /** Workspace-relative path, or `null` for workspace-level problems. */
  path: WorkspaceRelativePath | null;
  message: string;
}
