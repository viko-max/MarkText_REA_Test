import { describe, expect, it } from 'vitest';
import {
  buildCompletionInsertion,
  completeNotes,
  detectWikiLinkQuery,
} from '../src/renderer/src/links/completion';
import { describeNotePaths, lookupWikiTarget, uniqueTargetFor } from '../src/renderer/src/links/lookup';
import { describeNotes, resolveWikiTarget } from '../src/main/services/links/resolver';

const NOTES = [
  { path: '笔记.md', title: '我的笔记' },
  { path: '目录/笔记.md', title: '目录笔记' },
  { path: 'a/同名.md', title: '同名 A' },
  { path: 'b/同名.md', title: '同名 B' },
  { path: '首页.md', title: '首页' },
];

describe('wiki completion detection', () => {
  it('detects an unfinished link', () => {
    expect(detectWikiLinkQuery('前 [[笔', 5)).toEqual({
      start: 2,
      end: 5,
      queryStart: 4,
      query: '笔',
    });
  });

  it('returns the range of a closed link when the caret is inside its target', () => {
    expect(detectWikiLinkQuery('看 [[笔记]] 尾', 5)).toEqual({
      start: 2,
      end: 8,
      queryStart: 4,
      query: '笔',
    });
  });

  it('does not open after a finished link', () => {
    expect(detectWikiLinkQuery('看 [[笔记]] 尾', 8)).toBeNull();
  });

  it('stays out of aliases, embeds, escapes and newlines', () => {
    expect(detectWikiLinkQuery('[[笔记|别', 5)).toBeNull();
    expect(detectWikiLinkQuery('![[图片', 5)).toBeNull();
    expect(detectWikiLinkQuery(String.raw`\[[转义`, 5)).toBeNull();
    expect(detectWikiLinkQuery('[[前\n后', 5)).toBeNull();
    expect(detectWikiLinkQuery('普通文本', 2)).toBeNull();
  });

  it('clamps an out-of-range caret', () => {
    expect(detectWikiLinkQuery('[[笔', 99)?.query).toBe('笔');
  });
});

describe('wiki completion ranking', () => {
  it('prefers a unique stem and shorter paths', () => {
    const items = completeNotes(NOTES, '笔');
    expect(items.map((item) => item.path)).toEqual(['笔记.md', '目录/笔记.md']);
  });

  it('matches paths, titles and substrings', () => {
    expect(completeNotes(NOTES, '目录')[0]?.path).toBe('目录/笔记.md');
    expect(completeNotes(NOTES, '我的')[0]?.path).toBe('笔记.md');
    expect(completeNotes(NOTES, '笔记')[0]?.path).toBe('笔记.md');
  });

  it('keeps same-name notes as separate suggestions in path order', () => {
    expect(completeNotes(NOTES, '同名').map((item) => item.path)).toEqual([
      'a/同名.md',
      'b/同名.md',
    ]);
  });

  it('returns every note for an empty query and honours the limit', () => {
    expect(completeNotes(NOTES, '', 3)).toHaveLength(3);
    expect(completeNotes(NOTES, '不存在')).toEqual([]);
  });

  it('falls back to the stem for an empty title', () => {
    expect(completeNotes([{ path: 'folder/无标题.md', title: '' }], '') [0]?.title).toBe('无标题');
  });
});

describe('wiki completion insertion', () => {
  it('uses the stem when it is unique and the path when it is not', () => {
    const descriptors = describeNotePaths(NOTES.map((note) => note.path));
    expect(uniqueTargetFor('笔记.md', descriptors)).toBe('笔记');
    expect(uniqueTargetFor('目录/笔记.md', descriptors)).toBe('目录/笔记');
    expect(uniqueTargetFor('a/同名.md', descriptors)).toBe('a/同名');
  });

  it('replaces the whole expression', () => {
    const query = detectWikiLinkQuery('看 [[笔', 5);
    expect(query).not.toBeNull();
    const insertion = buildCompletionInsertion(
      query!,
      { path: '笔记.md', title: '我的笔记', detail: '笔记.md', score: 1 },
      NOTES,
    );
    expect(insertion).toEqual({ text: '[[笔记]]', start: 2, end: 5 });
  });
});

describe('renderer lookup parity with the main resolver', () => {
  const main = describeNotes(NOTES.map((note) => note.path));
  const renderer = describeNotePaths(NOTES.map((note) => note.path));

  for (const target of ['笔记', '目录/笔记', '同名', 'a/同名', '不存在', '笔记.md']) {
    it(`agrees for ${target}`, () => {
      const expected = resolveWikiTarget(target, main);
      const actual = lookupWikiTarget(target, renderer);
      expect({
        resolution: actual.resolution,
        resolvedPath: actual.resolvedPath,
        candidates: actual.candidates,
      }).toEqual({
        resolution: expected.resolution,
        resolvedPath: expected.resolvedPath,
        candidates: expected.candidates,
      });
    });
  }
});
