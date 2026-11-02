/**
 * Workspace file enumeration for the link index.
 *
 * Only real Markdown files are returned. Symbolic links and junctions are
 * skipped so the scan can never leave the canonical workspace root, and
 * dot-directories plus `node_modules` are ignored to keep a notes workspace
 * index from walking dependency trees.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isMarkdownPath, isWorkspaceRelativePath } from '../../../shared/paths';

const IGNORED_DIRECTORIES = new Set(['node_modules']);
const MAX_DEPTH = 64;

export interface ScannedNoteFile {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface SkippedWorkspaceEntry {
  path: string;
  reason: 'invalid_path' | 'symlink' | 'unreadable';
}

export interface WorkspaceNoteScan {
  notes: ScannedNoteFile[];
  skipped: SkippedWorkspaceEntry[];
}

/** Enumerates Markdown notes below `root`, sorted by workspace path. */
export async function scanWorkspaceNotes(root: string): Promise<WorkspaceNoteScan> {
  const notes: ScannedNoteFile[] = [];
  const skipped: SkippedWorkspaceEntry[] = [];
  await walk(root, '', 0, notes, skipped);
  notes.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { notes, skipped };
}

async function walk(
  absoluteDirectory: string,
  relativeDirectory: string,
  depth: number,
  notes: ScannedNoteFile[],
  skipped: SkippedWorkspaceEntry[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(absoluteDirectory, { withFileTypes: true });
  } catch {
    if (relativeDirectory.length > 0) {
      skipped.push({ path: relativeDirectory, reason: 'unreadable' });
    }
    return;
  }

  for (const entry of entries) {
    const relativePath =
      relativeDirectory.length > 0 ? `${relativeDirectory}/${entry.name}` : entry.name;

    if (entry.isSymbolicLink()) {
      if (entry.name.toLowerCase().endsWith('.md') || entry.isDirectory()) {
        skipped.push({ path: relativePath, reason: 'symlink' });
      }
      continue;
    }
    if (!isWorkspaceRelativePath(relativePath)) {
      skipped.push({ path: relativePath, reason: 'invalid_path' });
      continue;
    }

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      await walk(join(absoluteDirectory, entry.name), relativePath, depth + 1, notes, skipped);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.startsWith('.')) continue;
    if (!isMarkdownPath(entry.name)) continue;

    const absolutePath = join(absoluteDirectory, entry.name);
    const info = await stat(absolutePath).catch(() => null);
    if (!info || !info.isFile()) {
      skipped.push({ path: relativePath, reason: 'unreadable' });
      continue;
    }
    notes.push({ path: relativePath, mtimeMs: info.mtimeMs, size: info.size });
  }
}

/** Reads one note as UTF-8 without a BOM; `null` when it cannot be read. */
export async function readNoteMarkdown(root: string, relativePath: string): Promise<string | null> {
  if (!isWorkspaceRelativePath(relativePath)) return null;
  try {
    const buffer = await readFile(join(root, ...relativePath.split('/')));
    const text = buffer.toString('utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch {
    return null;
  }
}
