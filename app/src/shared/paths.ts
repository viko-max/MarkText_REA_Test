/**
 * Pure, platform-neutral helpers for workspace-relative POSIX paths.
 *
 * Renderer and main both import this module, so it must not use `node:path`
 * or any other Node-only API. Main-process callers combine these checks with
 * `resolveWorkspacePath` in `src/main/security/workspace-paths.ts`, which adds
 * filesystem containment checks.
 */

const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const MAX_SEGMENT_LENGTH = 255;

export class WorkspacePathError extends Error {
  readonly reason: 'invalid' | 'escapes_root';

  constructor(reason: 'invalid' | 'escapes_root', message: string) {
    super(message);
    this.name = 'WorkspacePathError';
    this.reason = reason;
  }
}

/**
 * A workspace path is a non-empty, root-relative POSIX path: no drive letters,
 * no leading slash, no `.`/`..` segments, no backslashes, no NUL or control
 * characters, and no Windows-reserved device names.
 */
export function isWorkspaceRelativePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const candidate = value;
  if (candidate.length === 0 || candidate.length > 4096) return false;
  if (candidate.startsWith('/') || candidate.endsWith('/')) return false;
  if (candidate.includes('\\')) return false;
  if (candidate.includes('//')) return false;
  for (let index = 0; index < candidate.length; index += 1) {
    const code = candidate.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  if (/^[a-zA-Z]:/.test(candidate)) return false;

  const segments = candidate.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') return false;
    if (segment.length > MAX_SEGMENT_LENGTH) return false;
    if (segment.endsWith('.') || segment.endsWith(' ')) return false;
    if (WINDOWS_RESERVED_NAMES.test(segment)) return false;
  }
  return true;
}

export function assertWorkspaceRelativePath(value: unknown, label = 'path'): string {
  if (!isWorkspaceRelativePath(value)) {
    throw new WorkspacePathError('invalid', `${label} must be a workspace-relative POSIX path`);
  }
  return value;
}

export function workspacePathSegments(value: string): string[] {
  assertWorkspaceRelativePath(value);
  return value.split('/');
}

export function workspaceBasename(value: string): string {
  const segments = workspacePathSegments(value);
  return segments[segments.length - 1] ?? '';
}

export function workspaceDirname(value: string): string {
  const segments = workspacePathSegments(value);
  segments.pop();
  return segments.join('/');
}

/** Lower-case extension including the leading dot, or an empty string. */
export function workspaceExtname(value: string): string {
  const base = workspaceBasename(value);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

export function workspaceStem(value: string): string {
  const base = workspaceBasename(value);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base;
  return base.slice(0, dot);
}

export function joinWorkspacePath(...parts: string[]): string {
  const filtered = parts.filter((part) => part.length > 0);
  if (filtered.length === 0) {
    throw new WorkspacePathError('invalid', 'joinWorkspacePath requires at least one segment');
  }
  return assertWorkspaceRelativePath(filtered.join('/'));
}

/** Case-insensitive key used to detect note-name collisions on Windows. */
export function workspacePathKey(value: string): string {
  return assertWorkspaceRelativePath(value).toLowerCase();
}

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'] as const;
export const HTML_EXTENSIONS = ['.html', '.htm'] as const;

export function isMarkdownPath(value: string): boolean {
  return MARKDOWN_EXTENSIONS.includes(workspaceExtname(value) as (typeof MARKDOWN_EXTENSIONS)[number]);
}

export function isHtmlPath(value: string): boolean {
  return HTML_EXTENSIONS.includes(workspaceExtname(value) as (typeof HTML_EXTENSIONS)[number]);
}
