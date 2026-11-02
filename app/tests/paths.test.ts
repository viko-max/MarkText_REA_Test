import { describe, expect, it } from 'vitest';
import {
  isHtmlPath,
  isMarkdownPath,
  isWorkspaceRelativePath,
  joinWorkspacePath,
  workspaceBasename,
  workspaceDirname,
  workspaceExtname,
  workspacePathKey,
  workspaceStem,
  WorkspacePathError,
  assertWorkspaceRelativePath,
} from '../src/shared/paths';

describe('isWorkspaceRelativePath', () => {
  it.each([
    'a.md',
    'notes/2026/idea.md',
    '中文 笔记/草稿.md',
    'assets/image-1.png',
    '.hidden/notes.md',
    'a-b_c/d.e.f.md',
  ])('accepts %s', (value) => {
    expect(isWorkspaceRelativePath(value)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    ['/etc/passwd', 'absolute POSIX path'],
    ['C:/Windows/system32', 'drive letter'],
    ['C:notes.md', 'drive-relative path'],
    ['notes\\a.md', 'backslash separator'],
    ['notes//a.md', 'empty segment'],
    ['notes/./a.md', 'dot segment'],
    ['notes/../a.md', 'parent segment'],
    ['../a.md', 'leading parent'],
    ['notes/', 'trailing slash'],
    ['/', 'root only'],
    ['notes/CON.md', 'reserved device name'],
    ['nul', 'reserved name'],
    ['notes/a.md.', 'trailing dot segment'],
    ['notes/a.md ', 'trailing space segment'],
    ['notes/a\u0000b.md', 'NUL character'],
    ['notes/a\u001fb.md', 'control character'],
  ])('rejects %j (%s)', (value) => {
    expect(isWorkspaceRelativePath(value)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isWorkspaceRelativePath(42)).toBe(false);
    expect(isWorkspaceRelativePath(null)).toBe(false);
    expect(isWorkspaceRelativePath(undefined)).toBe(false);
    expect(isWorkspaceRelativePath({ path: 'a.md' })).toBe(false);
  });

  it('rejects over-long paths and segments', () => {
    expect(isWorkspaceRelativePath('a/'.repeat(3000) + 'x.md')).toBe(false);
    expect(isWorkspaceRelativePath('x'.repeat(300) + '.md')).toBe(false);
  });
});

describe('assertWorkspaceRelativePath', () => {
  it('returns valid paths unchanged', () => {
    expect(assertWorkspaceRelativePath('notes/a.md')).toBe('notes/a.md');
  });

  it('throws a typed error for invalid paths', () => {
    expect(() => assertWorkspaceRelativePath('../a.md')).toThrow(WorkspacePathError);
    try {
      assertWorkspaceRelativePath('../a.md');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspacePathError);
      expect((error as WorkspacePathError).reason).toBe('invalid');
    }
  });
});

describe('POSIX path helpers', () => {
  it('splits basename, dirname, extension and stem', () => {
    const path = 'notes/2026/周报.MD';
    expect(workspaceBasename(path)).toBe('周报.MD');
    expect(workspaceDirname(path)).toBe('notes/2026');
    expect(workspaceExtname(path)).toBe('.md');
    expect(workspaceStem(path)).toBe('周报');
  });

  it('handles files in the workspace root', () => {
    expect(workspaceDirname('readme.md')).toBe('');
    expect(workspaceBasename('readme.md')).toBe('readme.md');
  });

  it('treats dotfiles as having no extension', () => {
    expect(workspaceExtname('.gitignore')).toBe('');
    expect(workspaceStem('.gitignore')).toBe('.gitignore');
  });

  it('joins segments into a validated path', () => {
    expect(joinWorkspacePath('notes', '2026', 'a.md')).toBe('notes/2026/a.md');
    expect(() => joinWorkspacePath('../', 'a.md')).toThrow(WorkspacePathError);
  });

  it('builds a case-insensitive key for Windows collisions', () => {
    expect(workspacePathKey('Notes/Idea.md')).toBe('notes/idea.md');
  });

  it('recognises Markdown and HTML documents', () => {
    expect(isMarkdownPath('a.md')).toBe(true);
    expect(isMarkdownPath('a.markdown')).toBe(true);
    expect(isMarkdownPath('a.MD')).toBe(true);
    expect(isMarkdownPath('a.html')).toBe(false);
    expect(isHtmlPath('a.html')).toBe(true);
    expect(isHtmlPath('a.htm')).toBe(true);
    expect(isHtmlPath('a.md')).toBe(false);
  });
});
