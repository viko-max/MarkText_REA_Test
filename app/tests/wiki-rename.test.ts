import { describe, expect, it } from 'vitest';
import { planRename } from '../src/main/services/links/rename-plan';

describe('rename plan', () => {
  it('rewrites unambiguous basename, path and aliased links', () => {
    const documents = [
      {
        path: 'index.md',
        markdown: '# 索引\n\n[[旧笔记]] 与 [[旧笔记|别名]] 与 [[notes/旧笔记]]\n',
      },
      { path: 'notes/旧笔记.md', markdown: '# 旧笔记\n\n自引用 [[旧笔记]]\n' },
    ];

    const plan = planRename({ documents, fromPath: 'notes/旧笔记.md', toPath: 'notes/新笔记.md' });

    expect(plan.referenceEdits).toEqual([
      {
        documentPath: 'index.md',
        from: 'notes/旧笔记',
        to: 'notes/新笔记',
        occurrences: 1,
      },
      {
        documentPath: 'index.md',
        from: '旧笔记',
        to: '新笔记',
        occurrences: 2,
      },
      {
        documentPath: 'notes/旧笔记.md',
        from: '旧笔记',
        to: '新笔记',
        occurrences: 1,
      },
    ]);
    expect(plan.skippedReferences).toEqual([]);
    expect(plan.rewrites).toEqual([
      {
        documentPath: 'index.md',
        originalMarkdown: '# 索引\n\n[[旧笔记]] 与 [[旧笔记|别名]] 与 [[notes/旧笔记]]\n',
        markdown: '# 索引\n\n[[新笔记]] 与 [[新笔记|别名]] 与 [[notes/新笔记]]\n',
      },
      {
        documentPath: 'notes/旧笔记.md',
        originalMarkdown: '# 旧笔记\n\n自引用 [[旧笔记]]\n',
        markdown: '# 旧笔记\n\n自引用 [[新笔记]]\n',
      },
    ]);
  });

  it('leaves ambiguous same-name links untouched and reports them', () => {
    const documents = [
      { path: 'index.md', markdown: '# 索引\n\n[[旧笔记]] 与 [[b/旧笔记]]\n' },
      { path: 'a/旧笔记.md', markdown: '# A\n' },
      { path: 'b/旧笔记.md', markdown: '# B\n' },
    ];

    const plan = planRename({ documents, fromPath: 'a/旧笔记.md', toPath: 'a/新笔记.md' });

    expect(plan.referenceEdits).toEqual([]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.skippedReferences).toEqual([
      {
        documentPath: 'index.md',
        line: 3,
        raw: '[[旧笔记]]',
        reason: 'ambiguous',
      },
    ]);
  });

  it('does not rewrite when the new target would become ambiguous', () => {
    const documents = [
      { path: 'index.md', markdown: '# 索引\n\n[[旧]]\n' },
      { path: 'notes/旧.md', markdown: '# 旧\n' },
      { path: 'other/新.md', markdown: '# 其他新\n' },
    ];

    const plan = planRename({ documents, fromPath: 'notes/旧.md', toPath: 'notes/新.md' });

    expect(plan.referenceEdits).toEqual([]);
    expect(plan.rewrites).toEqual([]);
    expect(plan.skippedReferences).toEqual([
      { documentPath: 'index.md', line: 3, raw: '[[旧]]', reason: 'ambiguous' },
    ]);
  });

  it('reports links that mention the old path but cannot be resolved', () => {
    const documents = [
      { path: 'index.md', markdown: '# 索引\n\n[[x/旧]]\n' },
      { path: '旧.md', markdown: '# 旧\n' },
    ];

    const plan = planRename({ documents, fromPath: '旧.md', toPath: '新.md' });

    expect(plan.referenceEdits).toEqual([]);
    expect(plan.skippedReferences).toEqual([
      { documentPath: 'index.md', line: 3, raw: '[[x/旧]]', reason: 'unresolvable' },
    ]);
  });

  it('does not consider unrelated links', () => {
    const documents = [
      { path: 'index.md', markdown: '# 索引\n\n[[别的笔记]] [[x/别的笔记]]\n' },
      { path: '旧.md', markdown: '# 旧\n' },
    ];

    const plan = planRename({ documents, fromPath: '旧.md', toPath: '新.md' });
    expect(plan.referenceEdits).toEqual([]);
    expect(plan.skippedReferences).toEqual([]);
  });

  it('rewrites the correct occurrence in CRLF documents and keeps code spans', () => {
    const documents = [
      { path: 'index.md', markdown: '# 索引\r\n\r\n`[[旧]]` 与 [[旧]]\r\n' },
      { path: '旧.md', markdown: '# 旧\r\n' },
    ];

    const plan = planRename({ documents, fromPath: '旧.md', toPath: '新.md' });

    expect(plan.referenceEdits).toEqual([
      { documentPath: 'index.md', from: '旧', to: '新', occurrences: 1 },
    ]);
    expect(plan.rewrites).toEqual([
      {
        documentPath: 'index.md',
        originalMarkdown: '# 索引\r\n\r\n`[[旧]]` 与 [[旧]]\r\n',
        markdown: '# 索引\r\n\r\n`[[旧]]` 与 [[新]]\r\n',
      },
    ]);
  });

  it('renames into another folder using the new stem for basename links', () => {
    const documents = [
      { path: 'index.md', markdown: '# 索引\n\n[[旧]]\n' },
      { path: '旧.md', markdown: '# 旧\n' },
    ];

    const plan = planRename({ documents, fromPath: '旧.md', toPath: 'sub/新.md' });
    expect(plan.referenceEdits).toEqual([
      { documentPath: 'index.md', from: '旧', to: '新', occurrences: 1 },
    ]);
    expect(plan.rewrites[0]?.markdown).toBe('# 索引\n\n[[新]]\n');
  });

  it('carries the exact untouched original next to every rewrite', () => {
    const original = '头行\n\n[[旧|别名]] 与 `[[旧]]` 与 [[目录/旧]]\n尾行';
    const documents = [
      { path: 'index.md', markdown: original },
      { path: '目录/旧.md', markdown: '# 旧\n' },
    ];

    const plan = planRename({ documents, fromPath: '目录/旧.md', toPath: '目录/新.md' });

    const rewrite = plan.rewrites.find((entry) => entry.documentPath === 'index.md');
    expect(rewrite?.originalMarkdown).toBe(original);
    expect(rewrite?.markdown).not.toBe(rewrite?.originalMarkdown);
    expect(rewrite?.markdown).toBe('头行\n\n[[新|别名]] 与 `[[旧]]` 与 [[目录/新]]\n尾行');
  });

  it('requires the documents list to include the old path', () => {
    expect(() =>
      planRename({
        documents: [{ path: 'other.md', markdown: '# Other\n' }],
        fromPath: '旧.md',
        toPath: '新.md',
      }),
    ).toThrow(/fromPath/);
  });
});
