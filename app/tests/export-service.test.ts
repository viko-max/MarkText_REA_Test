/**
 * `ExportService` behaviour with injected dialog and writer ports.
 *
 * Nothing here writes a real user file: the save dialog and the atomic writer
 * are fakes, so the test can assert the exact target and payload and prove that
 * cancellation and source shadowing never reach the writer.
 */

import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExportService,
  type SaveHtmlDialogPort,
} from '../src/main/services/export-service';
import type { HtmlWriter } from '../src/main/services/export-writer';
import type { ExportDependencyReport, ExportHtmlRequest } from '../src/shared/contracts';
import { createTestWorkspace, type TestWorkspace } from './workspace-fixture';

let workspace: TestWorkspace;
let sourcePath: string;

beforeAll(async () => {
  workspace = await createTestWorkspace('export');
  sourcePath = join(workspace.root, 'note.md');
  await writeFile(sourcePath, '# 笔记\n', 'utf8');
});

afterAll(async () => {
  await workspace.cleanup();
});

function dependencies(): ExportDependencyReport {
  return {
    embeddedLocalAssets: ['assets/a.png'],
    externalAssets: [{ url: 'https://example.com/a.png', reason: 'remote' }],
    missingAssets: ['assets/missing.png'],
  };
}

function request(): ExportHtmlRequest {
  return {
    documentPath: 'note.md',
    suggestedFileName: 'note.html',
    html: '<!doctype html><html><body><p>正文</p></body></html>',
    signature: 'sha256:abc123',
    dependencies: dependencies(),
  };
}

interface WriterCall {
  target: string;
  html: string;
}

function createWriter(calls: WriterCall[]): HtmlWriter {
  return async (target, html) => {
    calls.push({ target, html });
    return Buffer.byteLength(html, 'utf8');
  };
}

describe('ExportService', () => {
  it('reports a dismissed save dialog as a cancellation with details.reason=cancelled', async () => {
    const dialog: SaveHtmlDialogPort = {
      show: async () => ({ cancelled: true, filePath: null }),
    };
    const calls: WriterCall[] = [];
    const service = new ExportService(workspace.service, { dialog, writer: createWriter(calls) });

    await expect(service.html(request())).rejects.toMatchObject({
      code: 'conflict',
      details: { reason: 'cancelled', cancelled: true },
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses a destination that is the source Markdown file', async () => {
    const dialog: SaveHtmlDialogPort = {
      show: async () => ({ cancelled: false, filePath: sourcePath }),
    };
    const calls: WriterCall[] = [];
    const service = new ExportService(workspace.service, { dialog, writer: createWriter(calls) });

    await expect(service.html(request())).rejects.toMatchObject({
      code: 'forbidden',
      message: expect.stringContaining('refusing to overwrite the source Markdown document'),
    });
    expect(calls).toHaveLength(0);
  });

  it('writes through the injected writer and echoes signature, dependencies and bytes', async () => {
    const target = join(workspace.root, 'note.html');
    const dialog: SaveHtmlDialogPort = {
      show: async (options) => {
        expect(options.defaultPath).toBe('note.html');
        expect(options.sourcePath.toLowerCase()).toBe(sourcePath.toLowerCase());
        return { cancelled: false, filePath: target };
      },
    };
    const calls: WriterCall[] = [];
    const service = new ExportService(workspace.service, { dialog, writer: createWriter(calls) });
    const payload = request();

    const result = await service.html(payload);

    expect(calls).toEqual([{ target, html: payload.html }]);
    expect(result).toEqual({
      writtenPath: target,
      bytes: Buffer.byteLength(payload.html, 'utf8'),
      signature: payload.signature,
      dependencies: payload.dependencies,
    });
    expect(result.dependencies).toBe(payload.dependencies);
    expect(await readdir(workspace.root)).not.toContain('note.html');
  });
});
