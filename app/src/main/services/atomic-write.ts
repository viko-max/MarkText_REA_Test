/**
 * Small filesystem primitives shared by the document, resource and state
 * services.
 *
 * - `writeFileAtomic` replaces an existing file: bytes go to a sibling
 *   temporary file, are fsynced, and are renamed into place.
 * - `writeFileExclusive` creates a file that must not exist yet. A hard link
 *   from the temporary file gives atomic "create if absent" semantics, with an
 *   O_EXCL write as the fallback on filesystems without hard links.
 */

import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import writeFileAtomicImpl from 'write-file-atomic';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'ENOTEMPTY')
  );
}

async function targetExists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'ENOENT' || error.code === 'ENOTDIR')
    ) {
      return false;
    }
    throw error;
  }
}

/** Raised when an exclusive target was created by someone else first. */
export class TargetExistsError extends Error {
  readonly target: string;

  constructor(target: string) {
    super(`target already exists: ${target}`);
    this.name = 'TargetExistsError';
    this.target = target;
  }
}

export async function ensureParentDirectory(absolutePath: string): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
}

export async function writeFileAtomic(absolutePath: string, data: string | Uint8Array): Promise<void> {
  await ensureParentDirectory(absolutePath);
  await writeFileAtomicImpl(absolutePath, data, {
    encoding: typeof data === 'string' ? 'utf8' : undefined,
    fsync: true,
    mode: 0o644,
  });
}

/** Create `absolutePath`; rejects with `TargetExistsError` if it exists. */
export async function writeFileExclusive(
  absolutePath: string,
  data: string | Uint8Array,
): Promise<void> {
  await ensureParentDirectory(absolutePath);
  const temporary = `${absolutePath}.${process.pid}.${randomUUID()}.tmp`;

  await writeExclusiveOnce(temporary, data);
  try {
    try {
      await link(temporary, absolutePath);
    } catch (error) {
      if (await targetExists(absolutePath)) throw new TargetExistsError(absolutePath);
      // Filesystem without hard-link support: an exclusive write still never
      // clobbers an existing file.
      await writeExclusiveOnce(absolutePath, data);
      void error;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Move `from` to `to` without replacing an existing target.
 *
 * A hard link plus unlink keeps the "target must not exist" guarantee on every
 * platform; plain `rename` is the fallback for filesystems without links.
 */
export async function renameExclusive(from: string, to: string): Promise<void> {
  try {
    await link(from, to);
  } catch (error) {
    if (await targetExists(to)) throw new TargetExistsError(to);
    try {
      await rename(from, to);
    } catch (renameError) {
      if (isAlreadyExists(renameError)) throw new TargetExistsError(to);
      throw renameError;
    }
    void error;
    return;
  }

  try {
    await unlink(from);
  } catch (error) {
    await unlink(to).catch(() => undefined);
    throw error;
  }
}

async function writeExclusiveOnce(
  absolutePath: string,
  data: string | Uint8Array,
): Promise<void> {
  try {
    if (typeof data === 'string') {
      await writeFile(absolutePath, data, { encoding: 'utf8', flag: 'wx', mode: 0o644, flush: true });
    } else {
      await writeFile(absolutePath, data, { flag: 'wx', mode: 0o644, flush: true });
    }
  } catch (error) {
    if (isAlreadyExists(error)) throw new TargetExistsError(absolutePath);
    throw error;
  }
}

export async function readFileBytes(absolutePath: string): Promise<Buffer> {
  return readFile(absolutePath);
}
