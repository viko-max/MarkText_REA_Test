import { describe, expect, it } from 'vitest';
import {
  describeNotes,
  normalizeWikiTarget,
  resolveWikiTarget,
  targetPathKey,
} from '../src/main/services/links/resolver';

const NOTES = describeNotes([
  'root.md',
  'notes/root.md',
  'notes/中文笔记.md',
  'notes/idea.md',
  'notes/日志.md',
  'archive/日志.md',
  'archive/note.md',
]);

describe('wiki target resolution', () => {
  it('resolves a unique Chinese basename', () => {
    const resolution = resolveWikiTarget('中文笔记', NOTES);
    expect(resolution).toMatchObject({
      resolution: 'resolved',
      resolvedPath: 'notes/中文笔记.md',
      candidates: ['notes/中文笔记.md'],
    });
  });

  it('reports every same-name candidate instead of guessing', () => {
    const resolution = resolveWikiTarget('日志', NOTES);
    expect(resolution.resolution).toBe('ambiguous');
    expect(resolution.resolvedPath).toBeNull();
    expect(resolution.candidates).toEqual(['archive/日志.md', 'notes/日志.md']);
    expect(resolveWikiTarget('archive/日志', NOTES).resolvedPath).toBe('archive/日志.md');
  });

  it('reports two English notes with the same stem as ambiguous', () => {
    const resolution = resolveWikiTarget('root', NOTES);
    expect(resolution.resolution).toBe('ambiguous');
    expect(resolution.candidates).toEqual(['notes/root.md', 'root.md']);
  });

  it('disambiguates with a path suffix', () => {
    const notes = describeNotes(['a/note.md', 'b/note.md', 'b/other.md']);
    expect(resolveWikiTarget('b/note', notes).resolvedPath).toBe('b/note.md');
    expect(resolveWikiTarget('b/note.md', notes).resolvedPath).toBe('b/note.md');
  });

  it('keeps deep suffix collisions ambiguous', () => {
    const notes = describeNotes(['x/sub/idea.md', 'y/sub/idea.md']);
    const resolution = resolveWikiTarget('sub/idea', notes);
    expect(resolution.resolution).toBe('ambiguous');
    expect(resolution.candidates).toEqual(['x/sub/idea.md', 'y/sub/idea.md']);
  });

  it('prefers an exact path over a suffix match', () => {
    const notes = describeNotes(['notes/idea.md', 'archive/notes/idea.md']);
    expect(resolveWikiTarget('notes/idea', notes).resolvedPath).toBe('notes/idea.md');
  });

  it('matches case-insensitively and accepts either Markdown extension', () => {
    const notes = describeNotes(['notes/IDEA.MD', 'docs/plan.markdown']);
    expect(resolveWikiTarget('idea', notes).resolvedPath).toBe('notes/IDEA.MD');
    expect(resolveWikiTarget('docs/plan', notes).resolvedPath).toBe('docs/plan.markdown');
  });

  it('keeps two case-variant notes ambiguous', () => {
    const notes = describeNotes(['a/Note.md', 'b/note.md']);
    expect(resolveWikiTarget('note', notes).resolution).toBe('ambiguous');
  });

  it('reports missing targets with no candidates', () => {
    expect(resolveWikiTarget('不存在的笔记', NOTES)).toEqual({
      normalized: '不存在的笔记',
      resolution: 'missing',
      resolvedPath: null,
      candidates: [],
    });
  });

  it('normalises user-typed target text', () => {
    expect(normalizeWikiTarget('  ./目录//笔记.md  ')).toBe('目录/笔记.md');
    expect(normalizeWikiTarget('目录\\笔记')).toBe('目录/笔记');
    expect(targetPathKey('目录/笔记.MD')).toBe('目录/笔记');
  });

  it('never matches a directory-like target by basename', () => {
    const notes = describeNotes(['notes/idea.md']);
    expect(resolveWikiTarget('missing/idea', notes).resolution).toBe('missing');
  });
});
