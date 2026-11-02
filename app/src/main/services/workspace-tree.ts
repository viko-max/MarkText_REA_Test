/**
 * Workspace directory listing.
 *
 * Only note-like files are exposed: `.md`, `.markdown`, `.html` and `.htm`.
 * Hidden entries, `node_modules` and symbolic links are skipped so the tree is
 * predictable and cannot point outside the workspace. The node budget keeps a
 * pathological folder from freezing the UI; hitting it sets `truncated`.
 */

import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  GetWorkspaceTreeRequest,
  WorkspaceNode,
  WorkspaceSummary,
  WorkspaceTree,
} from '../../shared/contracts';
import { isHtmlPath, isMarkdownPath } from '../../shared/paths';
import { AppError } from '../errors';
import type { WorkspacePathGuard } from '../security/workspace-paths';

export const DEFAULT_MAX_TREE_NODES = 5_000;
export const DEFAULT_MAX_ENTRIES_PER_DIRECTORY = 2_000;

const IGNORED_DIRECTORIES = new Set(['node_modules']);

export interface WorkspaceTreeOptions {
  maxNodes?: number;
  maxEntriesPerDirectory?: number;
  now?: () => Date;
}

interface TreeBudget {
  remaining: number;
  truncated: boolean;
}

function isNoteFile(name: string): boolean {
  return isMarkdownPath(name) || isHtmlPath(name);
}

function isVisibleDirectory(name: string): boolean {
  return !name.startsWith('.') && !IGNORED_DIRECTORIES.has(name);
}

function isVisibleFile(name: string): boolean {
  return !name.startsWith('.') && isNoteFile(name);
}

function compareNodes(a: WorkspaceNode, b: WorkspaceNode): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
  return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
}

function childPath(parent: string, name: string): string {
  return parent === '' ? name : `${parent}/${name}`;
}

async function listDirectory(
  guard: WorkspacePathGuard,
  directoryPath: string,
  depth: number,
  budget: TreeBudget,
  maxEntriesPerDirectory: number,
): Promise<WorkspaceNode[]> {
  const absoluteDirectory = directoryPath === '' ? guard.root : await guard.resolveExisting(directoryPath);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });

  const visible = entries.filter((entry) => {
    if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) return false;
    return entry.isDirectory() ? isVisibleDirectory(entry.name) : isVisibleFile(entry.name);
  });

  if (visible.length > maxEntriesPerDirectory) {
    budget.truncated = true;
    visible.length = maxEntriesPerDirectory;
  }

  const nodes: WorkspaceNode[] = [];
  for (const entry of visible) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }

    const relativePath = childPath(directoryPath, entry.name);
    const absolutePath = join(absoluteDirectory, entry.name);
    const stats = await lstat(absolutePath).catch(() => null);
    if (!stats) continue;

    budget.remaining -= 1;

    if (entry.isDirectory()) {
      const children =
        depth > 0 && budget.remaining > 0
          ? await listDirectory(guard, relativePath, depth - 1, budget, maxEntriesPerDirectory)
          : null;
      nodes.push({
        kind: 'directory',
        name: entry.name,
        path: relativePath,
        children,
        size: null,
        mtimeMs: stats.mtimeMs,
      });
    } else if (entry.isFile()) {
      nodes.push({
        kind: 'file',
        name: entry.name,
        path: relativePath,
        children: null,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    }
  }

  nodes.sort(compareNodes);
  return nodes;
}

export async function buildWorkspaceTree(
  guard: WorkspacePathGuard,
  workspace: WorkspaceSummary,
  request: GetWorkspaceTreeRequest,
  options: WorkspaceTreeOptions = {},
): Promise<WorkspaceTree> {
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_TREE_NODES;
  const maxEntriesPerDirectory = options.maxEntriesPerDirectory ?? DEFAULT_MAX_ENTRIES_PER_DIRECTORY;
  const budget: TreeBudget = { remaining: Math.max(0, maxNodes), truncated: false };

  if (request.path !== '') {
    const absolute = await guard.resolveExisting(request.path);
    const stats = await lstat(absolute);
    if (!stats.isDirectory()) {
      throw new AppError('invalid_path', 'requested path is not a directory', { path: request.path });
    }
  }

  const nodes = await listDirectory(guard, request.path, request.depth, budget, maxEntriesPerDirectory);
  const now = options.now ?? (() => new Date());

  return {
    workspace,
    path: request.path,
    nodes,
    truncated: budget.truncated,
    scannedAt: now().toISOString(),
  };
}
