import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ResourceService } from '../src/main/services/resource-service';
import { createTestWorkspace, type TestWorkspace } from './workspace-fixture';

let workspace: TestWorkspace;
let resources: ResourceService;

const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
  0x52,
]);
const PNG_OTHER = Buffer.concat([PNG, Buffer.from([0x00, 0x01])]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');

beforeAll(async () => {
  workspace = await createTestWorkspace('img');
});

afterAll(async () => {
  await workspace.cleanup();
});

beforeEach(async () => {
  for (const name of await readdir(workspace.root)) {
    await rm(join(workspace.root, name), { recursive: true, force: true });
  }
  await mkdir(join(workspace.root, 'notes'), { recursive: true });
  await writeFile(join(workspace.root, 'notes', 'a.md'), '# a\n', 'utf8');
  resources = new ResourceService(workspace.service);
});

function saveRequest(bytes: Buffer, fileName = 'pasted.png', mediaType = 'image/png') {
  return {
    documentPath: 'notes/a.md',
    fileName,
    mediaType: mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'image/svg+xml',
    dataBase64: bytes.toString('base64'),
  };
}

describe('ResourceService.save', () => {
  it('writes assets/<sha256>.<ext> as a POSIX path and deduplicates', async () => {
    const first = await resources.save(saveRequest(PNG));
    expect(first.path).toMatch(/^assets\/[a-f0-9]{64}\.png$/);
    expect(first.duplicate).toBe(false);
    expect(first.bytes).toBe(PNG.byteLength);
    expect(first.sha256).toBe(createHash('sha256').update(PNG).digest('hex'));

    const second = await resources.save(saveRequest(PNG));
    expect(second.path).toBe(first.path);
    expect(second.duplicate).toBe(true);
    expect((await readdir(join(workspace.root, 'assets'))).filter((name) => name === `${first.sha256}.png`)).toHaveLength(
      1,
    );
  });

  it('gives different bytes different asset names', async () => {
    const one = await resources.save(saveRequest(PNG));
    const two = await resources.save(saveRequest(PNG_OTHER));
    expect(one.path).not.toBe(two.path);
  });

  it('rejects SVG instead of storing it', async () => {
    await expect(
      resources.save(saveRequest(SVG, 'evil.svg', 'image/svg+xml')),
    ).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'unsafe' } });
  });

  it('rejects a declared media type that does not match the bytes', async () => {
    await expect(resources.save(saveRequest(PNG, 'p.jpeg', 'image/jpeg'))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('rejects a file extension that does not match the media type', async () => {
    await expect(resources.save(saveRequest(PNG, 'p.jpg', 'image/png'))).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });

  it('rejects unsupported bytes and oversized payloads', async () => {
    await expect(resources.save(saveRequest(Buffer.from([1, 2, 3]), 'x.png', 'image/png'))).rejects.toMatchObject({
      code: 'invalid_request',
    });

    const small = new ResourceService(workspace.service, { maxImageBytes: 8 });
    await expect(small.save(saveRequest(PNG))).rejects.toMatchObject({ code: 'too_large' });
  });

  it('requires an existing Markdown document as the attachment basis', async () => {
    await expect(resources.save(saveRequest(PNG, 'p.png', 'image/png'))).resolves.toBeDefined();
    await expect(
      resources.save({
        documentPath: 'notes/missing.md',
        fileName: 'p.png',
        mediaType: 'image/png',
        dataBase64: PNG.toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await writeFile(join(workspace.root, 'notes', 'page.html'), '<p>x</p>', 'utf8');
    await expect(
      resources.save({
        documentPath: 'notes/page.html',
        fileName: 'p.png',
        mediaType: 'image/png',
        dataBase64: PNG.toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('keeps JPEG bytes and extension consistent', async () => {
    const saved = await resources.save(saveRequest(JPEG, 'photo.jpeg', 'image/jpeg'));
    expect(saved.path).toMatch(/\.jpg$/);
    expect(saved.mediaType).toBe('image/jpeg');
  });
});

describe('ResourceService.read', () => {
  it('returns base64 bytes, media type and digest for an in-workspace image', async () => {
    const saved = await resources.save(saveRequest(PNG));
    const read = await resources.read({ path: saved.path, documentPath: 'notes/a.md' });
    expect(read.mediaType).toBe('image/png');
    expect(read.sha256).toBe(saved.sha256);
    expect(read.bytes).toBe(PNG.byteLength);
    expect(Buffer.from(read.dataBase64, 'base64').equals(PNG)).toBe(true);
    expect(read.path).toBe(saved.path);
  });

  it('rejects SVG, unknown bytes and extension mismatches', async () => {
    await mkdir(join(workspace.root, 'assets'), { recursive: true });
    await writeFile(join(workspace.root, 'assets', 'evil.svg'), SVG);
    await expect(
      resources.read({ path: 'assets/evil.svg', documentPath: 'notes/a.md' }),
    ).rejects.toMatchObject({ code: 'forbidden' });

    await writeFile(join(workspace.root, 'assets', 'fake.png'), Buffer.from('not an image'));
    await expect(
      resources.read({ path: 'assets/fake.png', documentPath: 'notes/a.md' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    await writeFile(join(workspace.root, 'assets', 'mismatch.jpg'), PNG);
    await expect(
      resources.read({ path: 'assets/mismatch.jpg', documentPath: 'notes/a.md' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('rejects oversized images and paths outside the workspace', async () => {
    const small = new ResourceService(workspace.service, { maxImageBytes: 8 });
    await mkdir(join(workspace.root, 'assets'), { recursive: true });
    await writeFile(join(workspace.root, 'assets', 'big.png'), PNG);
    await expect(
      small.read({ path: 'assets/big.png', documentPath: 'notes/a.md' }),
    ).rejects.toMatchObject({ code: 'too_large' });

    await expect(
      resources.read({ path: '../secret.png', documentPath: 'notes/a.md' }),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('requires the basis document to exist', async () => {
    const saved = await resources.save(saveRequest(PNG));
    await expect(
      resources.read({ path: saved.path, documentPath: 'notes/missing.md' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
