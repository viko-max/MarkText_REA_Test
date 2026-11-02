import { afterAll, describe, expect, it } from 'vitest';
import { createTempWorkspace, delay, type TempWorkspace } from './wiki-fixtures';

const created: TempWorkspace[] = [];

async function workspace(notes: Record<string, string> = {}): Promise<TempWorkspace> {
  const temp = await createTempWorkspace(notes);
  created.push(temp);
  return temp;
}

afterAll(async () => {
  await Promise.all(created.map((temp) => temp.cleanup()));
});

const WORKSPACE_NOTES = {
  '首页.md': '# 首页\n\n[[笔记]] [[目录/笔记]] [[缺失]] [[同名]] [[独立笔记]]',
  '笔记.md': '# 我的笔记\n\n[[首页]]',
  '目录/笔记.md': '# 目录笔记\n\n[[首页]]',
  '独立笔记.md': '# 独立笔记\n',
  'a/同名.md': '# 同名 A\n',
  'b/同名.md': '# 同名 B\n',
  '.hidden/隐藏.md': '# 隐藏\n',
  'node_modules/pkg/dep.md': '# Dep\n',
};

describe('LinkService over a real workspace', () => {
  it('indexes real notes, titles, counts and unresolved links', async () => {
    const temp = await workspace(WORKSPACE_NOTES);
    const index = await temp.service.index();

    expect(index.workspaceRootPath).toBe(temp.root);
    expect(index.documents.map((document) => document.path)).toEqual([
      'a/同名.md',
      'b/同名.md',
      '独立笔记.md',
      '目录/笔记.md',
      '笔记.md',
      '首页.md',
    ]);
    expect(index.documents.some((document) => document.path.includes('.hidden'))).toBe(false);
    expect(index.documents.some((document) => document.path.includes('node_modules'))).toBe(false);

    const byPath = new Map(index.documents.map((document) => [document.path, document]));
    expect(byPath.get('首页.md')).toMatchObject({
      title: '首页',
      outboundCount: 5,
      inboundCount: 2,
      missingOutboundCount: 3,
    });
    expect(byPath.get('笔记.md')).toMatchObject({
      title: '我的笔记',
      outboundCount: 1,
      inboundCount: 0,
      missingOutboundCount: 0,
    });
    expect(byPath.get('独立笔记.md')).toMatchObject({ inboundCount: 1 });
    expect(byPath.get('目录/笔记.md')).toMatchObject({ title: '目录笔记', inboundCount: 1 });

    const ambiguous = index.links.find(
      (link) => link.sourcePath === '首页.md' && link.target === '同名',
    );
    expect(ambiguous).toMatchObject({
      resolution: 'ambiguous',
      resolvedPath: null,
      candidates: ['a/同名.md', 'b/同名.md'],
      line: 3,
    });
    expect(index.links.find((link) => link.target === '缺失')?.resolution).toBe('missing');
  });

  it('returns backlinks and ambiguous sources from the same index', async () => {
    const temp = await workspace(WORKSPACE_NOTES);
    const report = await temp.service.backlinks({ path: '目录/笔记.md' });
    expect(report).toEqual({
      targetPath: '目录/笔记.md',
      backlinks: [
        { sourcePath: '首页.md', sourceTitle: '首页', occurrences: 1 },
      ],
      // `[[笔记]]` is ambiguous and lists this note as one candidate.
      ambiguousSources: ['首页.md'],
    });

    const ambiguous = await temp.service.backlinks({ path: 'a/同名.md' });
    expect(ambiguous.backlinks).toEqual([]);
    expect(ambiguous.ambiguousSources).toEqual(['首页.md']);
  });

  it('does not count a note linking to itself as a backlink', async () => {
    const temp = await workspace({ 'self.md': '# Self\n\n[[self]]' });
    const report = await temp.service.backlinks({ path: 'self.md' });
    expect(report.backlinks).toEqual([]);
  });

  it('picks up new and changed files without a manual rebuild', async () => {
    const temp = await workspace({
      'a.md': '# A\n\n[[b]]',
      'b.md': '# B\n',
    });

    const first = await temp.service.index();
    expect(first.documents.find((document) => document.path === 'a.md')?.outboundCount).toBe(1);

    await temp.write('a.md', '# A\n\n[[b]] [[c]]');
    await temp.write('c.md', '# C\n');
    await delay(30);

    const second = await temp.service.index();
    expect(second).not.toBe(first);
    expect(second.documents.find((document) => document.path === 'a.md')?.outboundCount).toBe(2);
    expect(second.documents.find((document) => document.path === 'c.md')?.title).toBe('C');
    expect(second.links.filter((link) => link.sourcePath === 'a.md')).toHaveLength(2);
  });

  it('re-reads a note after invalidatePaths even when size and time look unchanged', async () => {
    const temp = await workspace({ 'b.md': '# B1\n' });
    expect((await temp.service.index()).documents[0]?.title).toBe('B1');

    await temp.write('b.md', '# B2\n');
    temp.service.invalidatePaths(['b.md']);

    expect((await temp.service.index()).documents[0]?.title).toBe('B2');
  });

  it('rebuild() discards cached state', async () => {
    const temp = await workspace({ 'a.md': '# A\n' });
    const first = await temp.service.index();
    const rebuilt = await temp.service.rebuild();
    expect(rebuilt.documents.map((document) => document.path)).toEqual(['a.md']);
    expect(rebuilt.generatedAt >= first.generatedAt).toBe(true);
  });

  it('builds the graph from real notes and filters the current neighbourhood', async () => {
    const temp = await workspace(WORKSPACE_NOTES);
    const full = await temp.service.graph({ focusPath: null, depth: 0 });
    expect(full.nodes.map((node) => node.id)).toContain('缺失');
    expect(full.nodes.find((node) => node.id === '缺失')?.kind).toBe('missing');
    expect(full.edges.every((edge) => edge.source.endsWith('.md'))).toBe(true);

    const focused = await temp.service.graph({ focusPath: '首页.md', depth: 1 });
    expect(new Set(focused.nodes.map((node) => node.id))).toEqual(
      new Set(['首页.md', '笔记', '笔记.md', '目录/笔记.md', '缺失', '同名', '独立笔记.md']),
    );
    expect(new Set(focused.edges.map((edge) => edge.id))).toEqual(
      new Set([
        '首页.md|笔记',
        '首页.md|目录/笔记.md',
        '首页.md|缺失',
        '首页.md|同名',
        '首页.md|独立笔记.md',
        '笔记.md|首页.md',
        '目录/笔记.md|首页.md',
      ]),
    );
  });

  it('computes a rename plan from workspace files without touching them', async () => {
    const temp = await workspace({
      'index.md': '# 索引\n\n[[旧]]\n',
      '旧.md': '# 旧\n',
    });

    const plan = await temp.service.renamePlan('旧.md', '新.md');
    expect(plan.referenceEdits).toEqual([
      { documentPath: 'index.md', from: '旧', to: '新', occurrences: 1 },
    ]);
    expect(plan.rewrites[0]?.markdown).toBe('# 索引\n\n[[新]]\n');

    const after = await temp.service.index();
    expect(after.documents.map((document) => document.path)).toContain('旧.md');
  });

  it('validates the rename source through the workspace guard', async () => {
    const temp = await workspace({ 'index.md': '# 索引\n' });
    await expect(temp.service.renamePlan('不存在.md', '新.md')).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
