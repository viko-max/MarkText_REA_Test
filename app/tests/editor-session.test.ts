import { describe, expect, it } from 'vitest';
import { clampSelection, DocumentSession } from '../src/renderer/src/editor/session';
import type { DocumentContent, DocumentChangeEvent, SaveDocumentResult } from '../src/shared/contracts';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const HASH_C = 'c'.repeat(64);

function createSession(markdown = '# one\n') {
  return new DocumentSession({
    id: 'doc-1',
    path: 'notes/a.md',
    markdown,
    baseHash: HASH_A,
    mtimeMs: 1,
  });
}

function saveResult(hash: string, mtimeMs = 2): SaveDocumentResult {
  return {
    path: 'notes/a.md',
    diskHash: hash,
    mtimeMs,
    savedAt: '2026-11-02T10:00:00.000Z',
    bytes: 6,
  };
}

function content(hash: string, markdown = '# two\n'): DocumentContent {
  return { path: 'notes/a.md', markdown, hash, mtimeMs: 3, size: markdown.length };
}

describe('DocumentSession dirty tracking', () => {
  it('starts clean and computes dirty from the last saved content', () => {
    const session = createSession();
    expect(session.dirty).toBe(false);
    expect(session.setContent('# one changed\n')).toBe(true);
    expect(session.dirty).toBe(true);
    expect(session.setContent('# one\n')).toBe(false);
    expect(session.dirty).toBe(false);
  });

  it('clears dirty only when the saved snapshot is still current', () => {
    const session = createSession();
    session.setContent('# two\n');
    const snapshot = session.beginSave();
    expect(snapshot).toEqual({ markdown: '# two\n', baseHash: HASH_A });
    expect(session.saving).toBe(true);

    session.completeSave(snapshot!, saveResult(HASH_B));
    expect(session.saving).toBe(false);
    expect(session.dirty).toBe(false);
    expect(session.baseHash).toBe(HASH_B);
    expect(session.diskHash).toBe(HASH_B);
  });

  it('keeps dirty when edits continue during a save', () => {
    const session = createSession();
    session.setContent('# two\n');
    const snapshot = session.beginSave();
    session.setContent('# three typed while saving\n');
    session.completeSave(snapshot!, saveResult(HASH_B));

    expect(session.dirty).toBe(true);
    expect(session.markdown).toBe('# three typed while saving\n');
    expect(session.baseHash).toBe(HASH_B);

    const second = session.beginSave();
    expect(second).toEqual({ markdown: '# three typed while saving\n', baseHash: HASH_B });
  });
});

describe('DocumentSession conflict and missing handling', () => {
  it('blocks beginSave after a conflict or a missing file', () => {
    const conflict = createSession();
    conflict.setContent('# two\n');
    conflict.failSave('conflict');
    expect(conflict.conflict).toBe(true);
    expect(conflict.saving).toBe(false);
    expect(conflict.beginSave()).toBeNull();
    expect(conflict.canSave()).toBe(false);

    const missing = createSession();
    missing.failSave('not_found');
    expect(missing.missing).toBe(true);
    expect(missing.beginSave()).toBeNull();
  });

  it('ignores its own disk hash and flags dirty external edits as conflicts', () => {
    const session = createSession();
    const ownEvent: DocumentChangeEvent = {
      path: 'notes/a.md',
      kind: 'modified',
      hash: HASH_A,
      mtimeMs: 5,
      size: 6,
    };
    expect(session.applyExternalChange(ownEvent)).toBe('ignored');

    session.setContent('# local edit\n');
    const external: DocumentChangeEvent = {
      path: 'notes/a.md',
      kind: 'modified',
      hash: HASH_C,
      mtimeMs: 6,
      size: 6,
    };
    expect(session.applyExternalChange(external)).toBe('conflict');
    expect(session.conflict).toBe(true);
    expect(session.beginSave()).toBeNull();
  });

  it('requests a reload for external edits while clean', () => {
    const session = createSession();
    const external: DocumentChangeEvent = {
      path: 'notes/a.md',
      kind: 'modified',
      hash: HASH_C,
      mtimeMs: 7,
      size: 6,
    };
    expect(session.applyExternalChange(external)).toBe('reload');
    expect(session.conflict).toBe(false);
  });

  it('marks a deleted document missing and blocks saves', () => {
    const session = createSession();
    expect(
      session.applyExternalChange({
        path: 'notes/a.md',
        kind: 'deleted',
        hash: null,
        mtimeMs: null,
        size: null,
      }),
    ).toBe('deleted');
    expect(session.missing).toBe(true);
    expect(session.beginSave()).toBeNull();
  });

  it('clears flags and dirty state on reload', () => {
    const session = createSession();
    session.setContent('# local\n');
    session.markConflict();
    session.setSelection({ anchor: 100, head: 200 });

    session.applyReload(content(HASH_C, '# disk\n'));
    expect(session.markdown).toBe('# disk\n');
    expect(session.baseHash).toBe(HASH_C);
    expect(session.dirty).toBe(false);
    expect(session.conflict).toBe(false);
    expect(session.selection).toEqual({ anchor: 7, head: 7 });
  });
});

describe('selection helpers', () => {
  it('clamps anchors to the document length', () => {
    expect(clampSelection({ anchor: -5, head: 999 }, 10)).toEqual({ anchor: 0, head: 10 });
    expect(clampSelection(null, 10)).toBeNull();
  });
});
