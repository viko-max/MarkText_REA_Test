/**
 * Builds the shared `LinkIndex` from parsed notes.
 *
 * Everything here is derived from real files and real parsed links: document
 * summaries, per-document in/out counts, unresolved counts and the flat link
 * list that backlinks and the graph consume.
 */

import type { LinkDocumentSummary, LinkIndex } from '../../../shared/contracts';
import { describeNote, resolveWikiTarget } from './resolver';
import type {
  LinkIndexWarning,
  NoteDescriptor,
  ParsedNote,
  ResolvedWikiLink,
} from './types';

export interface BuiltLinkIndex {
  index: LinkIndex & { warnings: LinkIndexWarning[] };
  links: ResolvedWikiLink[];
  documents: LinkDocumentSummary[];
  descriptors: NoteDescriptor[];
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function buildLinkIndex(
  workspaceRootPath: string,
  notes: readonly ParsedNote[],
  generatedAt: string,
  warnings: readonly LinkIndexWarning[] = [],
): BuiltLinkIndex {
  const sortedNotes = [...notes].sort((left, right) => comparePaths(left.path, right.path));
  const descriptors = sortedNotes.map((note) => describeNote(note.path));

  const resolvedBySource = new Map<string, ResolvedWikiLink[]>();
  const inbound = new Map<string, number>();

  for (const note of sortedNotes) {
    const resolved: ResolvedWikiLink[] = [];
    for (const link of note.links) {
      const target = resolveWikiTarget(link.target, descriptors);
      resolved.push({
        sourcePath: note.path,
        line: link.line,
        column: link.column,
        raw: link.raw,
        target: link.target,
        alias: link.alias,
        resolution: target.resolution,
        resolvedPath: target.resolvedPath,
        candidates: target.candidates,
      });
      if (target.resolvedPath !== null && target.resolvedPath !== note.path) {
        inbound.set(target.resolvedPath, (inbound.get(target.resolvedPath) ?? 0) + 1);
      }
    }
    resolvedBySource.set(note.path, resolved);
  }

  const documents: LinkDocumentSummary[] = sortedNotes.map((note) => {
    const links = resolvedBySource.get(note.path) ?? [];
    return {
      path: note.path,
      title: note.title.length > 0 ? note.title : describeNote(note.path).stem,
      outboundCount: links.length,
      inboundCount: inbound.get(note.path) ?? 0,
      // "Missing" here means "not automatically navigable": both a target that
      // does not exist and one that matches several notes.
      missingOutboundCount: links.filter((link) => link.resolution !== 'resolved').length,
    };
  });

  const links: ResolvedWikiLink[] = [];
  for (const note of sortedNotes) {
    links.push(...(resolvedBySource.get(note.path) ?? []));
  }
  links.sort(
    (left, right) =>
      comparePaths(left.sourcePath, right.sourcePath) ||
      left.line - right.line ||
      left.column - right.column,
  );

  return {
    index: {
      workspaceRootPath,
      generatedAt,
      documents,
      links,
      warnings: [...warnings],
    },
    links,
    documents,
    descriptors,
  };
}
