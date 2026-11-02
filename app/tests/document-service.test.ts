import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DocumentService,
  type DocumentServiceOptions,
} from '../src/main/services/document-service';
import { sha256Hex } from '../src/main/services/atomic-write';
import type { DocumentChangeEvent } from '../src/shared/contracts';
import { createTestWorkspace, type TestWorkspace } from './workspace-fixture';

let workspace: TestWorkspace;
let documents: DocumentService;
let events: DocumentChangeEvent[];

function createService(options: DocumentServiceOptions = {}): DocumentService {
  return new DocumentService(workspace.service, { watch: false, ...options });
}

beforeAll(async () => {
  workspace = await createTestWorkspace('doc');
});

afterAll(async () => {
  await workspace.cleanup();
});

beforeEach(async () => {
  for (const name of await readdir(workspace.root)) {
    await rm(join(workspace.root, name), { recursive: true, force: true });
  }
  await mkdir(join(workspace.root, 'notes'), { recursive: true });
  events = [];
  documents = createService();
  documents.setEventSink((event) => events.push(event));
});

async function writeRelative(path: string, content: string): Promise<void> {
  await writeFile(join(workspace.root, ...path.split('/')), content, 'utf8');
}

describe('DocumentService reads', () => {
  it('returns UTF-8 content and the SHA-256 of the bytes', async () => {
    await writeRelative('notes/a.md', '# 标题\n');
    const content = await documents.read({ path: 'notes/a.md' });
    expect(content.markdown).toBe('# 标题\n');
    expect(content.hash).toBe(sha256Hex(Buffer.from('# 标题\n', 'utf8')));
    expect(content.size).toBe(Buffer.byteLength('# 标题\n', 'utf8'));
  });

  it('reads HTML documents but refuses other extensions', async () => {
    await writeRelative('page.html', '<h1>hi</h1>');
    await writeRelative('notes/a.txt', 'no');
    expect((await documents.read({ path: 'page.html' })).markdown).toBe('<h1>hi</h1>');
    await expect(documents.read({ path: 'notes/a.txt' })).rejects.toMatchObject({
      code: 'invalid_path',
    });
  });

  it('reports missing documents and path escapes', async () => {
    await expect(documents.read({ path: 'missing.md' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(documents.read({ path: '../escape.md' })).rejects.toMatchObject({
      code: 'invalid_path',
    });
  });
});

describe('DocumentService create and save copy', () => {
  it('creates a new note exactly once', async () => {
    const created = await documents.create({
      directory: 'notes',
      fileName: 'new.md',
      markdown: '# new\n',
    });
    expect(created.path).toBe('notes/new.md');
    expect(created.hash).toBe(sha256Hex(Buffer.from('# new\n', 'utf8')));
    expect((await documents.read({ path: 'notes/new.md' })).markdown).toBe('# new\n');

    await expect(
      documents.create({ directory: 'notes', fileName: 'new.md', markdown: '' }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('requires an existing parent directory and a Markdown name', async () => {
    await expect(
      documents.create({ directory: 'missing', fileName: 'a.md', markdown: '' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      documents.create({ directory: '', fileName: 'a.txt', markdown: '' }),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('saves a copy without touching the source and refuses an existing target', async () => {
    await writeRelative('notes/a.md', '# original\n');
    await writeRelative('notes/existing.md', 'taken\n');
    const read = await documents.read({ path: 'notes/a.md' });

    const copy = await documents.saveCopy({
      documentId: 'doc-1',
      path: 'notes/a.md',
      targetPath: 'notes/copy.md',
      markdown: '# copy\n',
    });
    expect(copy.path).toBe('notes/copy.md');
    expect((await documents.read({ path: 'notes/copy.md' })).markdown).toBe('# copy\n');
    expect((await documents.read({ path: 'notes/a.md' })).markdown).toBe('# original\n');
    expect(copy.diskHash).toBe(sha256Hex(Buffer.from('# copy\n', 'utf8')));
    expect(read.hash).not.toBe(copy.diskHash);

    await expect(
      documents.saveCopy({
        documentId: 'doc-1',
        path: 'notes/a.md',
        targetPath: 'notes/existing.md',
        markdown: '# nope\n',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('DocumentService compare-and-swap saves', () => {
  it('writes atomically when baseHash matches', async () => {
    await writeRelative('a.md', '# one\n');
    const read = await documents.read({ path: 'a.md' });
    const result = await documents.save({
      documentId: 'doc-a',
      path: 'a.md',
      markdown: '# two\n',
      baseHash: read.hash,
    });

    expect(result.diskHash).toBe(sha256Hex(Buffer.from('# two\n', 'utf8')));
    expect(await readFile(join(workspace.root, 'a.md'), 'utf8')).toBe('# two\n');
    const names = await readdir(workspace.root);
    expect(names.some((name) => name.includes('.tmp'))).toBe(false);
  });

  it('refuses a stale baseHash and leaves the disk untouched', async () => {
    await writeRelative('a.md', '# one\n');
    const read = await documents.read({ path: 'a.md' });
    await writeRelative('a.md', '# external\n');

    await expect(
      documents.save({
        documentId: 'doc-a',
        path: 'a.md',
        markdown: '# mine\n',
        baseHash: read.hash,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await readFile(join(workspace.root, 'a.md'), 'utf8')).toBe('# external\n');
  });

  it('reports a deleted document as missing', async () => {
    await writeRelative('a.md', '# one\n');
    const read = await documents.read({ path: 'a.md' });
    await rm(join(workspace.root, 'a.md'));

    await expect(
      documents.save({
        documentId: 'doc-a',
        path: 'a.md',
        markdown: '# mine\n',
        baseHash: read.hash,
      }),
    ).rejects.toMatchObject({ code: 'not_found', details: { missing: true } });
  });

  it('serialises saves for one document id and rejects the stale follow-up', async () => {
    await writeRelative('a.md', '# one\n');
    const read = await documents.read({ path: 'a.md' });

    const first = documents.save({
      documentId: 'doc-a',
      path: 'a.md',
      markdown: '# first\n',
      baseHash: read.hash,
    });
    const second = documents.save({
      documentId: 'doc-a',
      path: 'a.md',
      markdown: '# second\n',
      baseHash: read.hash,
    });

    const results = await Promise.allSettled([first, second]);
    expect(results[0]?.status).toBe('fulfilled');
    expect(results[1]?.status).toBe('rejected');
    if (results[1]?.status === 'rejected') {
      expect(results[1].reason).toMatchObject({ code: 'conflict' });
    }
    expect(await readFile(join(workspace.root, 'a.md'), 'utf8')).toBe('# first\n');
  });
});

describe('DocumentService rename', () => {
  it('renames on disk and defers reference rewriting explicitly', async () => {
    await writeRelative('notes/a.md', '# a\n');
    const result = await documents.rename({
      documentId: 'doc-a',
      fromPath: 'notes/a.md',
      toPath: 'notes/b.md',
      updateReferences: true,
    });
    expect(result.path).toBe('notes/b.md');
    expect(result.referencesDeferred).toBe(true);
    expect(result.referenceEdits).toEqual([]);
    await expect(documents.read({ path: 'notes/a.md' })).rejects.toMatchObject({
      code: 'not_found',
    });
    expect((await documents.read({ path: 'notes/b.md' })).markdown).toBe('# a\n');
  });

  it('reports no deferred work when references were not requested', async () => {
    await writeRelative('notes/a.md', '# a\n');
    const result = await documents.rename({
      documentId: 'doc-a',
      fromPath: 'notes/a.md',
      toPath: 'notes/b.md',
      updateReferences: false,
    });
    expect(result.referencesDeferred).toBe(false);
  });

  it('refuses to overwrite an existing target or use a missing parent', async () => {
    await writeRelative('notes/a.md', '# a\n');
    await writeRelative('notes/b.md', '# b\n');
    await expect(
      documents.rename({
        documentId: 'doc-a',
        fromPath: 'notes/a.md',
        toPath: 'notes/b.md',
        updateReferences: false,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(await readFile(join(workspace.root, 'notes', 'a.md'), 'utf8')).toBe('# a\n');

    await expect(
      documents.rename({
        documentId: 'doc-a',
        fromPath: 'notes/a.md',
        toPath: 'missing/c.md',
        updateReferences: false,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('DocumentService external watcher', () => {
  it('emits a modified event after an external write', async () => {
    await writeRelative('watch.md', '# before\n');
    await documents.read({ path: 'watch.md' });
    await writeRelative('watch.md', '# after external\n');

    await documents.pollNow();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      path: 'watch.md',
      kind: 'modified',
      hash: sha256Hex(Buffer.from('# after external\n', 'utf8')),
    });
  });

  it('does not emit an event for its own save', async () => {
    await writeRelative('watch.md', '# before\n');
    const read = await documents.read({ path: 'watch.md' });
    await documents.save({
      documentId: 'doc-w',
      path: 'watch.md',
      markdown: '# mine\n',
      baseHash: read.hash,
    });

    await documents.pollNow();
    expect(events).toEqual([]);
  });

  it('emits deleted and restored events', async () => {
    await writeRelative('watch.md', '# before\n');
    await documents.read({ path: 'watch.md' });

    await rm(join(workspace.root, 'watch.md'));
    await documents.pollNow();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ path: 'watch.md', kind: 'deleted', hash: null });

    await writeRelative('watch.md', '# back\n');
    await documents.pollNow();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ path: 'watch.md', kind: 'modified' });
  });
});
