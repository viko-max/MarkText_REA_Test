/// <reference lib="dom" />
/**
 * Wiki-link projection for the preview document.
 *
 * jsdom ships no type declarations and no dependency may be added, so it is
 * loaded through `createRequire` with a local shape, exactly like the existing
 * HTML workspace test.
 */

import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import type { LinkIndexView } from '../src/renderer/src/links/contracts';
import {
  applyWikilinkTargets,
  relativeWorkspaceHref,
  resolveWikiLinkFromIndex,
} from '../src/renderer/src/html/preview-links';

interface JsdomInstance {
  window: Window & typeof globalThis;
}

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html?: string) => JsdomInstance;
};

const index: LinkIndexView = {
  workspaceRootPath: 'C:/workspace',
  generatedAt: '2026-11-02T00:00:00.000Z',
  documents: [
    {
      path: 'archive/alpha.md',
      title: 'Alpha 归档',
      outboundCount: 0,
      inboundCount: 0,
      missingOutboundCount: 0,
    },
    {
      path: 'notes/alpha.md',
      title: 'Alpha',
      outboundCount: 0,
      inboundCount: 0,
      missingOutboundCount: 0,
    },
    {
      path: 'notes/beta.md',
      title: 'Beta',
      outboundCount: 0,
      inboundCount: 0,
      missingOutboundCount: 0,
    },
  ],
  links: [],
};

const token = (target: string): { target: string; alias: string | null; raw: string } => ({
  target,
  alias: null,
  raw: `[[${target}]]`,
});

describe('resolveWikiLinkFromIndex', () => {
  it('resolves a unique note to a document-relative href', () => {
    const resolution = resolveWikiLinkFromIndex(index, 'notes/alpha.md', token('Beta'));
    expect(resolution.state).toBe('resolved');
    expect(resolution.href).toBe('beta.md');
    expect(resolution.title).toBe('notes/beta.md');
  });

  it('resolves a path target across folders', () => {
    const resolution = resolveWikiLinkFromIndex(index, 'notes/alpha.md', token('archive/alpha'));
    expect(resolution.state).toBe('resolved');
    expect(resolution.href).toBe('../archive/alpha.md');
  });

  it('keeps same-name targets ambiguous without an openable href', () => {
    const resolution = resolveWikiLinkFromIndex(index, 'notes/beta.md', token('Alpha'));
    expect(resolution.state).toBe('ambiguous');
    expect(resolution.href).toBeNull();
    expect(resolution.title).toContain('notes/alpha.md');
    expect(resolution.title).toContain('archive/alpha.md');
  });

  it('keeps a missing target missing without inventing an href', () => {
    const resolution = resolveWikiLinkFromIndex(index, 'notes/beta.md', token('不存在'));
    expect(resolution.state).toBe('missing');
    expect(resolution.href).toBeNull();
  });
});

describe('relativeWorkspaceHref', () => {
  it('stays inside the workspace and encodes path segments', () => {
    expect(relativeWorkspaceHref('a.md', 'notes/b.md')).toBe('notes/b.md');
    expect(relativeWorkspaceHref('notes/a.md', 'notes/b.md')).toBe('b.md');
    expect(relativeWorkspaceHref('notes/deep/a.md', 'notes/b.md')).toBe('../b.md');
    expect(relativeWorkspaceHref('notes/a.md', 'notes/my note.md')).toBe('my%20note.md');
  });
});

describe('applyWikilinkTargets', () => {
  it('opens only resolved links and clears stale targets', () => {
    const dom = new JSDOM(`<!doctype html><html><body>
      <a data-mdl-wikilink="resolved" data-mdl-target="notes/beta" href="beta.md">Beta</a>
      <span data-mdl-wikilink="ambiguous" data-mdl-target="Alpha">Alpha</span>
      <a data-mdl-wikilink="missing" data-mdl-target="Nope" data-wikilink-target="stale">Nope</a>
      <span data-mdl-wikilink="resolved" data-mdl-target="not-an-anchor">文本</span>
    </body></html>`);
    const doc = dom.window.document;

    expect(applyWikilinkTargets(doc)).toBe(1);
    expect(
      doc.querySelector('a[data-mdl-wikilink="resolved"]')?.getAttribute('data-wikilink-target'),
    ).toBe('notes/beta');
    expect(
      doc.querySelector('span[data-mdl-wikilink="ambiguous"]')?.hasAttribute('data-wikilink-target'),
    ).toBe(false);
    expect(
      doc.querySelector('[data-mdl-wikilink="missing"]')?.hasAttribute('data-wikilink-target'),
    ).toBe(false);
    expect(
      doc.querySelector('span[data-mdl-target="not-an-anchor"]')?.hasAttribute('data-wikilink-target'),
    ).toBe(false);
  });

  it('is idempotent for an already decorated document', () => {
    const dom = new JSDOM(
      '<!doctype html><html><body><a data-mdl-wikilink="resolved" data-mdl-target="a">A</a></body></html>',
    );
    const doc = dom.window.document;
    expect(applyWikilinkTargets(doc)).toBe(1);
    expect(applyWikilinkTargets(doc)).toBe(1);
  });
});
