import { describe, expect, it } from 'vitest';
import { buildLinkGraph } from '../src/main/services/links/graph-builder';
import { buildLinkIndex } from '../src/main/services/links/index-builder';
import { parseMarkdownNote } from '../src/main/services/links/wiki-parser';

function buildFixture() {
  const notes = [
    parseMarkdownNote('a.md', '# A\n\n[[b]] [[c]]'),
    parseMarkdownNote('b.md', '# B\n\n[[c]]'),
    parseMarkdownNote('c.md', '# C\n\n[[缺失笔记]]'),
    parseMarkdownNote('isolated.md', '# Isolated\n'),
  ];
  return buildLinkIndex('/workspace', notes, '2026-11-02T00:00:00.000Z');
}

describe('graph builder', () => {
  it('contains only real notes and real links', () => {
    const built = buildFixture();
    const graph = buildLinkGraph(built.links, built.documents, {
      focusPath: null,
      depth: 0,
      generatedAt: 't',
    });

    expect(graph.nodes.map((node) => node.id)).toEqual([
      'a.md',
      'b.md',
      'c.md',
      'isolated.md',
      '缺失笔记',
    ]);
    expect(graph.edges.map((edge) => [edge.source, edge.target, edge.count, edge.resolution])).toEqual([
      ['a.md', 'b.md', 1, 'resolved'],
      ['a.md', 'c.md', 1, 'resolved'],
      ['b.md', 'c.md', 1, 'resolved'],
      ['c.md', '缺失笔记', 1, 'missing'],
    ]);

    const missing = graph.nodes.find((node) => node.id === '缺失笔记');
    expect(missing).toMatchObject({ kind: 'missing', label: '缺失笔记', inDegree: 1, outDegree: 0 });
  });

  it('aggregates repeated links into one weighted edge', () => {
    const notes = [
      parseMarkdownNote('a.md', '# A\n\n[[b]] [[b]] [[b|别名]]'),
      parseMarkdownNote('b.md', '# B\n'),
    ];
    const built = buildLinkIndex('/workspace', notes, 't');
    const graph = buildLinkGraph(built.links, built.documents, {
      focusPath: null,
      depth: 0,
      generatedAt: 't',
    });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]).toMatchObject({ source: 'a.md', target: 'b.md', count: 3 });
    expect(graph.nodes.find((node) => node.id === 'b.md')?.inDegree).toBe(1);
  });

  it('does not draw self-links as edges', () => {
    const notes = [
      parseMarkdownNote('self.md', '# Self\n\n[[self]]'),
      parseMarkdownNote('other.md', '# Other\n'),
    ];
    const built = buildLinkIndex('/workspace', notes, 't');
    const graph = buildLinkGraph(built.links, built.documents, {
      focusPath: null,
      depth: 0,
      generatedAt: 't',
    });
    expect(graph.edges).toEqual([]);
    expect(graph.nodes.find((node) => node.id === 'self.md')).toMatchObject({
      inDegree: 0,
      outDegree: 0,
    });
  });

  it('represents ambiguous targets as missing-style nodes', () => {
    const notes = [
      parseMarkdownNote('source.md', '# Source\n\n[[日志]]'),
      parseMarkdownNote('x/日志.md', '# X'),
      parseMarkdownNote('y/日志.md', '# Y'),
    ];
    const built = buildLinkIndex('/workspace', notes, 't');
    const graph = buildLinkGraph(built.links, built.documents, {
      focusPath: null,
      depth: 0,
      generatedAt: 't',
    });
    expect(graph.nodes.find((node) => node.id === '日志')).toMatchObject({
      kind: 'missing',
      label: '日志',
    });
    expect(graph.edges).toEqual([
      { id: 'source.md|日志', source: 'source.md', target: '日志', count: 1, resolution: 'ambiguous' },
    ]);
  });

  it('filters to the current neighbourhood by depth', () => {
    const built = buildFixture();
    const base = { generatedAt: 't', depth: 1, focusPath: 'a.md' } as const;

    const depthOne = buildLinkGraph(built.links, built.documents, { ...base });
    expect(depthOne.nodes.map((node) => node.id)).toEqual(['a.md', 'b.md', 'c.md']);
    // Induced subgraph: edges between included neighbours are kept as well.
    expect(depthOne.edges.map((edge) => edge.id)).toEqual([
      'a.md|b.md',
      'a.md|c.md',
      'b.md|c.md',
    ]);

    const depthTwo = buildLinkGraph(built.links, built.documents, { ...base, depth: 2 });
    expect(depthTwo.nodes.map((node) => node.id)).toEqual(['a.md', 'b.md', 'c.md', '缺失笔记']);
    expect(depthTwo.edges.map((edge) => edge.id)).toEqual([
      'a.md|b.md',
      'a.md|c.md',
      'b.md|c.md',
      'c.md|缺失笔记',
    ]);

    const depthZero = buildLinkGraph(built.links, built.documents, { ...base, depth: 0 });
    expect(depthZero.nodes.map((node) => node.id)).toEqual(['a.md']);
    expect(depthZero.edges).toEqual([]);
  });

  it('returns an empty graph when the focus note is not indexed', () => {
    const built = buildFixture();
    const graph = buildLinkGraph(built.links, built.documents, {
      focusPath: 'missing.md',
      depth: 2,
      generatedAt: 't',
    });
    expect(graph).toMatchObject({ focusPath: 'missing.md', nodes: [], edges: [] });
  });
});
