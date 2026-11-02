import { describe, expect, it } from 'vitest';
import { buildLinkIndex } from '../src/main/services/links/index-builder';
import { parseMarkdownNote } from '../src/main/services/links/wiki-parser';

function buildFixture() {
  const notes = [
    parseMarkdownNote('a.md', '# A\n\n[[b]] [[b|B]] [[missing]] [[dup]]'),
    parseMarkdownNote('sub/b.md', '# B\n\n[[a]] [[a]]'),
    parseMarkdownNote('x/dup.md', '# Dup X'),
    parseMarkdownNote('y/dup.md', '# Dup Y'),
  ];
  return buildLinkIndex('/workspace', notes, '2026-11-02T00:00:00.000Z');
}

describe('link index builder', () => {
  it('derives document summaries from real parsed links', () => {
    const { index } = buildFixture();
    expect(index.workspaceRootPath).toBe('/workspace');
    expect(index.generatedAt).toBe('2026-11-02T00:00:00.000Z');
    expect(index.documents.map((document) => document.path)).toEqual([
      'a.md',
      'sub/b.md',
      'x/dup.md',
      'y/dup.md',
    ]);

    const byPath = new Map(index.documents.map((document) => [document.path, document]));
    expect(byPath.get('a.md')).toMatchObject({
      title: 'A',
      outboundCount: 4,
      inboundCount: 2,
      missingOutboundCount: 2,
    });
    expect(byPath.get('sub/b.md')).toMatchObject({
      title: 'B',
      outboundCount: 2,
      inboundCount: 2,
      missingOutboundCount: 0,
    });
    expect(byPath.get('x/dup.md')?.inboundCount).toBe(0);
  });

  it('keeps ambiguity candidates and missing resolutions in the link list', () => {
    const { links } = buildFixture();
    const dup = links.find((link) => link.target === 'dup');
    expect(dup).toMatchObject({
      sourcePath: 'a.md',
      resolution: 'ambiguous',
      resolvedPath: null,
      candidates: ['x/dup.md', 'y/dup.md'],
    });

    const missing = links.find((link) => link.target === 'missing');
    expect(missing).toMatchObject({ resolution: 'missing', resolvedPath: null, candidates: [] });

    const alias = links.find((link) => link.raw === '[[b|B]]');
    expect(alias).toMatchObject({
      resolution: 'resolved',
      resolvedPath: 'sub/b.md',
      alias: 'B',
    });
  });

  it('sorts links by source, line and column and keeps occurrences separate', () => {
    const { links } = buildFixture();
    expect(links).toHaveLength(6);
    expect(links.map((link) => [link.sourcePath, link.line, link.column])).toEqual([
      ['a.md', 3, 1],
      ['a.md', 3, 7],
      ['a.md', 3, 15],
      ['a.md', 3, 27],
      ['sub/b.md', 3, 1],
      ['sub/b.md', 3, 7],
    ]);
  });

  it('counts inbound occurrences only from other documents', () => {
    const notes = [
      parseMarkdownNote('self.md', '# Self\n\n[[self]] [[other]]'),
      parseMarkdownNote('other.md', '# Other\n'),
    ];
    const { index } = buildLinkIndex('/workspace', notes, 't');
    const byPath = new Map(index.documents.map((document) => [document.path, document]));
    expect(byPath.get('self.md')).toMatchObject({ outboundCount: 2, inboundCount: 0 });
    expect(byPath.get('other.md')).toMatchObject({ outboundCount: 0, inboundCount: 1 });
  });

  it('exposes warnings collected by the caller', () => {
    const notes = [parseMarkdownNote('a.md', '')];
    const { index } = buildLinkIndex('/workspace', notes, 't', [
      { path: 'broken.md', message: 'unreadable' },
    ]);
    expect(index.warnings).toEqual([{ path: 'broken.md', message: 'unreadable' }]);
  });
});
