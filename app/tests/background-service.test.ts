/**
 * Native wallpaper picker service.
 *
 * `electron.dialog` is replaced with a controllable stub so the tests can drive
 * cancel, bad geometry and real PNG/JPEG bytes without any window. Every case
 * also checks that the absolute path never appears in the returned value.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import { AppError } from '../src/main/errors';
import { BackgroundService } from '../src/main/services/background-service';
import { MAX_IMAGE_BYTES } from '../src/shared/validation';
import { WALLPAPER_PNG_BYTES } from './wallpaper-fixtures';

const electron = vi.hoisted(() => ({
  openResult: { canceled: true, filePaths: [] as string[] },
  calls: [] as Array<{ options: unknown; withWindow: boolean }>,
}));

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: async (windowOrOptions: unknown, maybeOptions?: unknown) => {
      electron.calls.push({
        options: maybeOptions ?? windowOrOptions,
        withWindow: maybeOptions !== undefined,
      });
      return electron.openResult;
    },
  },
}));

const createdDirs: string[] = [];

afterAll(async () => {
  await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const base = join(process.cwd(), '.runtime', 'test-data');
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, 'wallpaper-'));
  createdDirs.push(dir);
  return dir;
}

async function writeImage(name: string, bytes: Buffer): Promise<string> {
  const dir = await tempDir();
  const file = join(dir, name);
  await writeFile(file, bytes);
  return file;
}

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x11)]);
const GIF_BYTES = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(32, 0x22)]);
const SVG_BYTES = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  'utf8',
);

function service(options: { maxWallpaperBytes?: number } = {}): BackgroundService {
  const window = { id: 1 } as unknown as BrowserWindow;
  return new BackgroundService({ getWindow: () => window }, options);
}

function setSelection(filePath: string): void {
  electron.openResult = { canceled: false, filePaths: [filePath] };
}

beforeEach(() => {
  electron.openResult = { canceled: true, filePaths: [] };
  electron.calls.length = 0;
});

describe('BackgroundService.choose', () => {
  it('reports a cancellation without touching the filesystem', async () => {
    const result = await service().choose();
    expect(result).toEqual({ cancelled: true, wallpaper: null });

    const call = electron.calls.at(0);
    expect(call?.withWindow).toBe(true);
    const filters = (call?.options as { filters?: Array<{ extensions: string[] }> }).filters;
    expect(filters?.[0]?.extensions).toEqual(['png', 'jpg', 'jpeg', 'webp']);
    expect((call?.options as { properties?: string[] }).properties).toEqual(['openFile']);
  });

  it('returns a canonical data URI for a real PNG', async () => {
    const file = await writeImage('wallpaper.png', WALLPAPER_PNG_BYTES);
    setSelection(file);

    const result = await service().choose();
    expect(result.cancelled).toBe(false);
    const wallpaper = result.wallpaper;
    expect(wallpaper).not.toBeNull();
    if (wallpaper === null) return;

    expect(wallpaper.mediaType).toBe('image/png');
    expect(wallpaper.bytes).toBe(WALLPAPER_PNG_BYTES.byteLength);
    expect(wallpaper.dataUri).toBe(`data:image/png;base64,${WALLPAPER_PNG_BYTES.toString('base64')}`);
    expect(wallpaper.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(wallpaper).sort()).toEqual(['bytes', 'dataUri', 'mediaType', 'sha256']);
    expect(JSON.stringify(result)).not.toMatch(/[A-Za-z]:[\\/]/);
  });

  it('accepts JPEG bytes regardless of the .jpeg extension wording', async () => {
    const file = await writeImage('photo.jpeg', JPEG_BYTES);
    setSelection(file);

    const result = await service().choose();
    expect(result.wallpaper?.mediaType).toBe('image/jpeg');
    expect(result.wallpaper?.dataUri.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('rejects a non-image payload', async () => {
    const file = await writeImage('notes.txt', Buffer.from('plain text, not an image', 'utf8'));
    setSelection(file);
    await expect(service().choose()).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects SVG even when the extension is allowed', async () => {
    const file = await writeImage('wallpaper.png', SVG_BYTES);
    setSelection(file);

    const failure = await service()
      .choose()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('forbidden');
  });

  it('rejects GIF because only PNG/JPEG/WebP are allowed', async () => {
    const file = await writeImage('wallpaper.gif', GIF_BYTES);
    setSelection(file);
    await expect(service().choose()).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects an extension that disagrees with the bytes', async () => {
    const file = await writeImage('wallpaper.webp', WALLPAPER_PNG_BYTES);
    setSelection(file);
    await expect(service().choose()).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects a file above the size limit before reading it', async () => {
    const file = await writeImage('wallpaper.png', WALLPAPER_PNG_BYTES);
    setSelection(file);

    await expect(
      service({ maxWallpaperBytes: WALLPAPER_PNG_BYTES.byteLength - 1 }).choose(),
    ).rejects.toMatchObject({ code: 'too_large' });
  });

  it('uses the shared 10 MiB ceiling by default', async () => {
    expect(MAX_IMAGE_BYTES).toBe(10 * 1024 * 1024);
  });
});
