/**
 * Filesystem containment for workspace-relative paths.
 *
 * Two layers of protection are used:
 * 1. the pure syntax check in `@shared/paths` (no `..`, no absolute paths);
 * 2. canonical `realpath` checks here, so a junction or symlink inside the
 *    workspace cannot reach files outside the workspace root.
 */

import { realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { assertWorkspaceRelativePath, WorkspacePathError } from '../../shared/paths';

export type WorkspacePathErrorCode = 'invalid_path' | 'outside_workspace' | 'not_found';

export class WorkspacePathGuardError extends Error {
  readonly code: WorkspacePathErrorCode;

  constructor(code: WorkspacePathErrorCode, message: string) {
    super(message);
    this.name = 'WorkspacePathGuardError';
    this.code = code;
  }
}

export interface WorkspacePathGuard {
  /** Canonical absolute workspace root. */
  readonly root: string;
  /** Absolute path for a validated relative path (no filesystem access). */
  resolve(relativePath: string): string;
  /** Resolve an existing entry and verify its real path stays inside the root. */
  resolveExisting(relativePath: string): Promise<string>;
  /** Resolve a path that is about to be created or replaced. */
  resolveNew(relativePath: string): Promise<string>;
}

/** True when `candidate` is `root` or one of its descendants. */
export function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  if (relativePath === '') return true;
  if (isAbsolute(relativePath)) return false;
  return relativePath !== '..' && !relativePath.startsWith(`..${'/'}`) && !relativePath.startsWith('..\\');
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function toGuardError(error: unknown): WorkspacePathGuardError {
  if (error instanceof WorkspacePathGuardError) return error;
  if (error instanceof WorkspacePathError) {
    return new WorkspacePathGuardError('invalid_path', error.message);
  }
  if (isNotFound(error)) {
    return new WorkspacePathGuardError('not_found', 'path does not exist inside the workspace');
  }
  throw error;
}

async function realpathOrFail(absolutePath: string): Promise<string> {
  try {
    return await realpath(absolutePath);
  } catch (error) {
    throw toGuardError(error);
  }
}

export async function createWorkspacePathGuard(rootPath: string): Promise<WorkspacePathGuard> {
  const requestedRoot = resolve(rootPath);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(requestedRoot);
  } catch (error) {
    if (isNotFound(error)) {
      throw new WorkspacePathGuardError('not_found', 'workspace root does not exist');
    }
    throw error;
  }

  const rootStats = await stat(canonicalRoot).catch((error: unknown) => {
    throw toGuardError(error);
  });
  if (!rootStats.isDirectory()) {
    throw new WorkspacePathGuardError('invalid_path', 'workspace root must be a directory');
  }

  const resolveRelative = (relativePath: string): string => {
    try {
      assertWorkspaceRelativePath(relativePath);
    } catch (error) {
      throw toGuardError(error);
    }
    const candidate = resolve(canonicalRoot, ...relativePath.split('/'));
    if (!isPathInside(canonicalRoot, candidate)) {
      throw new WorkspacePathGuardError('outside_workspace', 'path escapes the workspace root');
    }
    return candidate;
  };

  return {
    root: canonicalRoot,

    resolve(relativePath: string): string {
      return resolveRelative(relativePath);
    },

    async resolveExisting(relativePath: string): Promise<string> {
      const candidate = resolveRelative(relativePath);
      const canonical = await realpathOrFail(candidate);
      if (!isPathInside(canonicalRoot, canonical)) {
        throw new WorkspacePathGuardError('outside_workspace', 'path resolves outside the workspace root');
      }
      return canonical;
    },

    async resolveNew(relativePath: string): Promise<string> {
      const candidate = resolveRelative(relativePath);

      let existingAncestor = dirname(candidate);
      for (;;) {
        try {
          const canonicalAncestor = await realpath(existingAncestor);
          if (!isPathInside(canonicalRoot, canonicalAncestor)) {
            throw new WorkspacePathGuardError('outside_workspace', 'parent directory resolves outside the workspace root');
          }
          break;
        } catch (error) {
          if (error instanceof WorkspacePathGuardError) throw error;
          if (!isNotFound(error)) throw toGuardError(error);
          const parent = dirname(existingAncestor);
          if (parent === existingAncestor) {
            throw new WorkspacePathGuardError('not_found', 'no existing parent directory inside the workspace');
          }
          existingAncestor = parent;
        }
      }

      const existing = await realpath(candidate).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw toGuardError(error);
      });
      if (existing !== null && !isPathInside(canonicalRoot, existing)) {
        throw new WorkspacePathGuardError('outside_workspace', 'target resolves outside the workspace root');
      }
      return candidate;
    },
  };
}
