/**
 * Image compatibility reproduction (fix 02): Windows backslash separators and
 * a loopback HTTP image in the real preview.
 *
 * Both cases assert the rendered pixel, never just that path resolution
 * succeeded: the iframe image must really be complete with `naturalWidth > 0`.
 * The remote case is served by a local 127.0.0.1 server, so no external
 * network traffic is involved.
 */

import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import {
  activeTabTitle,
  openMarkdownFile,
  previewFrame,
} from './support/app-ui';
import { APP_ROOT, executeCase, waitFor } from './support/harness';

test.describe.configure({ timeout: 240_000 });

const FIXTURE_PIXEL = path.resolve(APP_ROOT, '..', 'fixtures', 'notes-demo', 'assets', 'pixel.png');
const BACKSLASH_NOTE = '目录/反斜杠.md';
const REMOTE_NOTE = '远程.md';

interface FrameImage {
  src: string | null;
  complete: boolean;
  naturalWidth: number;
  status: string | null;
}

async function readFrameImage(
  frame: ReturnType<typeof previewFrame>,
  selector = 'img.mdl-image',
): Promise<FrameImage> {
  return frame.locator(selector).first().evaluate((element) => {
    const image = element as HTMLImageElement;
    return {
      src: image.getAttribute('src'),
      complete: image.complete,
      naturalWidth: image.naturalWidth,
      status: image.getAttribute('data-mdl-image'),
    };
  });
}

async function serveLoopbackPixel(): Promise<{ server: Server; url: string }> {
  const pixel = readFileSync(FIXTURE_PIXEL);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? '');
    if (request.url === '/pixel.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': pixel.length });
      response.end(pixel);
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('loopback server has no port');
  return { server, url: `http://127.0.0.1:${address.port}/pixel.png` };
}

test('IMG1 Windows backslash image and loopback remote image render real pixels', async () => {
  const { server, url } = await serveLoopbackPixel();
  try {
    await executeCase(
      'IMG1-backslash-and-loopback',
      // Playwright injects its own utility script into every frame; the preview
      // sandbox intentionally has no `allow-scripts`, so Chromium logs a
      // "Blocked script execution" error for it. The CSP entries never decide
      // the result: the remote step fails on `naturalWidth` and additionally
      // asserts below that no CSP block remains.
      {
        allowedConsoleErrors: [
          /Content Security Policy/i,
          /Refused to load/i,
          /Blocked script execution/i,
          /sandbox/i,
        ],
      },
      async (context) => {
        writeFileSync(
          context.workspacePath(BACKSLASH_NOTE),
          `# 反斜杠图片\n\nWindows 风格相对路径：\n\n![反斜杠](../assets\\pixel.png)\n`,
        );
        writeFileSync(context.workspacePath(REMOTE_NOTE), `# 远程图片\n\n![远程](${url})\n`);

        await context.launchApp();
        const page = context.page!;

        await context.step('backslash relative image renders a real PNG data URI', async () => {
          await openMarkdownFile(page, BACKSLASH_NOTE);
          await expect(activeTabTitle(page)).toHaveText('反斜杠.md');
          const frame = previewFrame(page);
          await expect(frame.locator('.mdl-content img.mdl-image')).toHaveCount(1, {
            timeout: 15_000,
          });
          await expect(frame.locator('.mdl-content img.mdl-image')).toHaveAttribute(
            'src',
            /^data:image\/png;base64,/,
          );
          const image = await readFrameImage(frame);
          expect(image.src).toMatch(/^data:image\/png;base64,/);
          expect(image.status).toBe('embedded');
          expect(image.naturalWidth).toBeGreaterThan(0);
          await expect(frame.locator('.mdl-content .mdl-image-missing')).toHaveCount(0);
          context.note(`backslash image decoded with naturalWidth=${image.naturalWidth}`);
          await context.capture('backslash-image');
        });

        await context.step('loopback remote image loads as an external resource', async () => {
          await openMarkdownFile(page, REMOTE_NOTE);
          await expect(activeTabTitle(page)).toHaveText('远程.md');
          const frame = previewFrame(page);
          await expect(frame.locator('.mdl-content img.mdl-image')).toHaveCount(1, {
            timeout: 15_000,
          });
          await expect(frame.locator('.mdl-content img.mdl-image')).toHaveAttribute('src', url);
          await expect(frame.locator('.mdl-content img.mdl-image')).toHaveAttribute(
            'data-mdl-image',
            'external',
          );
          await waitFor(
            async () => (await readFrameImage(frame)).naturalWidth > 0,
            15_000,
            150,
            `loopback image ${url} to decode inside the preview frame`,
          );
          const image = await readFrameImage(frame);
          expect(image.status).toBe('external');
          expect(image.src).toBe(url);
          expect(image.naturalWidth).toBeGreaterThan(0);
          context.note(`remote image decoded with naturalWidth=${image.naturalWidth}`);
          await context.capture('remote-image');
        });

        await context.step('export dependency report lists the remote asset', async () => {
          await expect(page.locator('#status-export')).toHaveAttribute('title', /个远程资源/, {
            timeout: 10_000,
          });
          const summary = await page.locator('#status-export').getAttribute('title');
          expect(summary ?? '').toContain('1 个远程资源');
          context.note(`status-export dependency title: ${summary ?? ''}`);
        });

        await context.step('no Content Security Policy block applies to the remote image', async () => {
          const cspErrors = context.errors.filter((entry) =>
            /Content Security Policy|Refused to load/i.test(entry.message),
          );
          expect(cspErrors.map((entry) => entry.message)).toEqual([]);
        });

        if (context.errors.length > 0) {
          context.note(
            `renderer console during image cases: ${context.errors
              .map((entry) => entry.message)
              .join(' | ')}`,
          );
        }
      },
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
