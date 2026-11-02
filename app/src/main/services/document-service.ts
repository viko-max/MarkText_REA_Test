/**
 * Document reads, compare-and-swap saves, copy-on-write saves, atomic renames
 * and the external-change watcher.
 *
 * Save protocol:
 * 1. The renderer sends `baseHash`, the hash of the bytes its edits were based
 *    on. Main re-reads the file and refuses with `conflict` when the hash no
 *    longer matches, so a save never silently overwrites an external edit.
 * 2. Writes go through a sibling temporary file and an atomic rename.
 * 3. Saves for one `documentId` are serialised; a second request waits for the
 *    first, then performs its own CAS check.
 * 4. Saves refused because the file vanished fail with `not_found` and
 *    `details.missing = true`.
 */

import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type {
  CreateDocumentRequest,
  DocumentChangeEvent,
  DocumentContent,
  ReadDocumentRequest,
  RenameDocumentRequest,
  RenameDocumentResult,
  SaveDocumentCopyRequest,
  SaveDocumentRequest,
  SaveDocumentResult,
} from '../../shared/contracts';
import {
  assertWorkspaceRelativePath,
  isHtmlPath,
  isMarkdownPath,
  isWorkspaceRelativePath,
  workspaceDirname,
  workspacePathKey,
} from '../../shared/paths';
import { AppError } from '../errors';
import type { WorkspacePathGuard } from '../security/workspace-paths';
import {
  renameExclusive,
  sha256Hex,
  TargetExistsError,
  writeFileExclusive,
  writeFileAtomic,
} from './atomic-write';
import type { WorkspaceService } from './workspace-service';

export const DEFAULT_MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const SELF_WRITE_MUTE_MS = 3_000;
const WATCH_DEBOUNCE_MS = 120;

export interface DocumentServiceOptions {
  watch?: boolean;
  pollIntervalMs?: number;
  maxDocumentBytes?: number;
  now?: () => Date;
}

interface TrackedDocument {
  path: string;
  hash: string | null;
  size: number | null;
  mtimeMs: number | null;
  exists: boolean;
  /** While set, watcher scans ignore this entry (our own atomic write). */
  mutedUntil: number;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

function isRenameConflict(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'ENOTEMPTY')
  );
}

export class DocumentService {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly tracked = new Map<string, TrackedDocument>();
  private readonly maxDocumentBytes: number;
  private readonly shouldWatch: boolean;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;

  private eventSink: ((event: DocumentChangeEvent) => void) | null = null;
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;
  private watchRoot: string | null = null;
  private scanning = false;

  constructor(
    private readonly workspace: WorkspaceService,
    options: DocumentServiceOptions = {},
  ) {
    this.maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES;
    this.shouldWatch = options.watch ?? true;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
    this.now = options.now ?? (() => new Date());
  }

  setEventSink(sink: ((event: DocumentChangeEvent) => void) | null): void {
    this.eventSink = sink;
  }

  /** Restart the watcher when the workspace root changed or was closed. */
  refreshWorkspace(): void {
    const root = this.workspace.current?.summary.rootPath ?? null;
    if (root !== this.watchRoot) {
      this.tracked.clear();
      this.stopWatcher();
    }
    this.ensureWatcher();
  }

  shutdown(): void {
    this.stopWatcher();
    this.tracked.clear();
    this.queues.clear();
  }

  async read(request: ReadDocumentRequest): Promise<DocumentContent> {
    const { guard } = this.workspace.require();
    this.ensureWatcher();
    return this.readRelative(guard, request.path);
  }

  async create(request: CreateDocumentRequest): Promise<DocumentContent> {
    const { guard } = this.workspace.require();
    this.ensureWatcher();

    if (!isWorkspaceRelativePath(request.fileName) || !isMarkdownPath(request.fileName)) {
      throw new AppError('invalid_path', 'new documents must end with .md or .markdown', {
        fileName: request.fileName,
      });
    }
    if (request.directory !== '') {
      const directory = await guard.resolveExisting(request.directory);
      const stats = await stat(directory);
      if (!stats.isDirectory()) {
        throw new AppError('invalid_path', 'parent path is not a directory', {
          path: request.directory,
        });
      }
    }

    const targetPath =
      request.directory === '' ? request.fileName : `${request.directory}/${request.fileName}`;
    assertWorkspaceRelativePath(targetPath);
    const absolute = await guard.resolveNew(targetPath);

    try {
      await writeFileExclusive(absolute, request.markdown ?? '');
    } catch (error) {
      if (error instanceof TargetExistsError) {
        throw new AppError('conflict', 'a file with that name already exists', { path: targetPath });
      }
      throw error;
    }

    const stats = await stat(absolute);
    const bytes = Buffer.from(request.markdown ?? '', 'utf8');
    const hash = sha256Hex(bytes);
    this.track(targetPath, hash, bytes.byteLength, stats.mtimeMs, true);

    return {
      path: targetPath,
      markdown: request.markdown ?? '',
      hash,
      mtimeMs: stats.mtimeMs,
      size: bytes.byteLength,
    };
  }

  async save(request: SaveDocumentRequest): Promise<SaveDocumentResult> {
    const { guard } = this.workspace.require();
    this.ensureWatcher();

    return this.enqueue(request.documentId, async () => {
      const absolute = await guard.resolveNew(request.path);
      const before = await stat(absolute).catch((error: unknown) => {
        if (isNotFound(error)) {
          throw new AppError('not_found', 'document no longer exists on disk', {
            path: request.path,
            missing: true,
          });
        }
        throw error;
      });
      if (!before.isFile()) {
        throw new AppError('invalid_path', 'document path is not a file', { path: request.path });
      }

      const currentBytes = await readFile(absolute);
      const currentHash = sha256Hex(currentBytes);
      if (currentHash !== request.baseHash) {
        this.track(request.path, currentHash, currentBytes.byteLength, before.mtimeMs, true);
        throw new AppError('conflict', 'document changed on disk since it was loaded', {
          path: request.path,
          diskHash: currentHash,
          baseHash: request.baseHash,
        });
      }

      const bytes = Buffer.from(request.markdown, 'utf8');
      if (bytes.byteLength > this.maxDocumentBytes) {
        throw new AppError('too_large', 'document exceeds the maximum size', {
          path: request.path,
          maxBytes: this.maxDocumentBytes,
        });
      }
      const newHash = sha256Hex(bytes);
      const restore = this.muteSelfWrite(request.path, newHash, bytes.byteLength);
      try {
        await writeFileAtomic(absolute, request.markdown);
      } catch (error) {
        this.restoreTracked(request.path, restore);
        throw error;
      }

      const after = await stat(absolute);
      this.track(request.path, newHash, bytes.byteLength, after.mtimeMs, true);
      return {
        path: request.path,
        diskHash: newHash,
        mtimeMs: after.mtimeMs,
        savedAt: this.now().toISOString(),
        bytes: bytes.byteLength,
      };
    });
  }

  async saveCopy(request: SaveDocumentCopyRequest): Promise<SaveDocumentResult> {
    const { guard } = this.workspace.require();
    this.ensureWatcher();

    return this.enqueue(request.documentId, async () => {
      await this.requireParentDirectory(guard, request.targetPath);
      const absolute = await guard.resolveNew(request.targetPath);
      try {
        await writeFileExclusive(absolute, request.markdown);
      } catch (error) {
        if (error instanceof TargetExistsError) {
          throw new AppError('conflict', 'copy target already exists', {
            path: request.targetPath,
          });
        }
        throw error;
      }

      const stats = await stat(absolute);
      const bytes = Buffer.from(request.markdown, 'utf8');
      const hash = sha256Hex(bytes);
      this.track(request.targetPath, hash, bytes.byteLength, stats.mtimeMs, true);
      return {
        path: request.targetPath,
        diskHash: hash,
        mtimeMs: stats.mtimeMs,
        savedAt: this.now().toISOString(),
        bytes: bytes.byteLength,
      };
    });
  }

  async reload(request: ReadDocumentRequest): Promise<DocumentContent> {
    const { guard } = this.workspace.require();
    this.ensureWatcher();
    return this.readRelative(guard, request.path);
  }

  async rename(request: RenameDocumentRequest): Promise<RenameDocumentResult> {
    const { guard } = this.workspace.require();
    this.ensureWatcher();

    return this.enqueue(request.documentId, async () => {
      const from = await guard.resolveExisting(request.fromPath);
      const fromStats = await stat(from);
      if (!fromStats.isFile()) {
        throw new AppError('invalid_path', 'source path is not a file', {
          path: request.fromPath,
        });
      }
      await this.requireParentDirectory(guard, request.toPath);
      const to = await guard.resolveNew(request.toPath);

      try {
        await renameExclusive(from, to);
      } catch (error) {
        if (error instanceof TargetExistsError) {
          throw new AppError('conflict', 'rename target already exists', { path: request.toPath });
        }
        if (isRenameConflict(error)) {
          throw new AppError('conflict', 'rename target already exists', { path: request.toPath });
        }
        throw error;
      }

      this.moveTracked(request.fromPath, request.toPath);

      return {
        path: request.toPath,
        referenceEdits: [],
        skippedReferences: [],
        referencesDeferred: request.updateReferences,
      };
    });
  }

  /**
   * Scans every tracked document for external changes and emits watcher
   * events. Exposed so tests and the polling fallback do not depend on the
   * platform watcher implementation.
   */
  async pollNow(): Promise<void> {
    if (this.scanning) return;
    if (!this.workspace.current) return;
    const { guard } = this.workspace.require();
    this.scanning = true;
    try {
      for (const entry of [...this.tracked.values()]) {
        await this.checkTracked(entry, guard);
      }
    } finally {
      this.scanning = false;
    }
  }

  private async readRelative(
    guard: WorkspacePathGuard,
    relativePath: string,
  ): Promise<DocumentContent> {
    if (!isWorkspaceRelativePath(relativePath)) {
      throw new AppError('invalid_path', 'path must be a workspace-relative POSIX path', {
        path: relativePath,
      });
    }
    if (!isMarkdownPath(relativePath) && !isHtmlPath(relativePath)) {
      throw new AppError('invalid_path', 'only Markdown and HTML documents can be read', {
        path: relativePath,
      });
    }
    const absolute = await guard.resolveExisting(relativePath);
    const stats = await stat(absolute);
    if (!stats.isFile()) {
      throw new AppError('invalid_path', 'document path is not a file', { path: relativePath });
    }
    if (stats.size > this.maxDocumentBytes) {
      throw new AppError('too_large', 'document exceeds the maximum size', {
        path: relativePath,
        maxBytes: this.maxDocumentBytes,
      });
    }

    const bytes = await readFile(absolute);
    if (bytes.byteLength > this.maxDocumentBytes) {
      throw new AppError('too_large', 'document exceeds the maximum size', {
        path: relativePath,
        maxBytes: this.maxDocumentBytes,
      });
    }
    const hash = sha256Hex(bytes);
    this.track(relativePath, hash, bytes.byteLength, stats.mtimeMs, true);

    return {
      path: relativePath,
      markdown: bytes.toString('utf8'),
      hash,
      mtimeMs: stats.mtimeMs,
      size: bytes.byteLength,
    };
  }

  private async requireParentDirectory(
    guard: WorkspacePathGuard,
    relativePath: string,
  ): Promise<void> {
    const directory = workspaceDirname(relativePath);
    if (directory === '') return;
    const absolute = await guard.resolveExisting(directory);
    const stats = await stat(absolute);
    if (!stats.isDirectory()) {
      throw new AppError('not_found', 'parent directory does not exist', { path: directory });
    }
  }

  private enqueue<T>(documentId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(documentId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(documentId, tail);
    void tail.finally(() => {
      if (this.queues.get(documentId) === tail) this.queues.delete(documentId);
    });
    return next;
  }

  // -- tracking -------------------------------------------------------------

  private track(
    path: string,
    hash: string | null,
    size: number | null,
    mtimeMs: number | null,
    exists: boolean,
  ): void {
    this.tracked.set(workspacePathKey(path), {
      path,
      hash,
      size,
      mtimeMs,
      exists,
      mutedUntil: 0,
    });
  }

  /** Hide our own write from the watcher until the new bytes are visible. */
  private muteSelfWrite(
    path: string,
    hash: string,
    size: number,
  ): TrackedDocument | null {
    const key = workspacePathKey(path);
    const existing = this.tracked.get(key);
    if (!existing) return null;
    const snapshot = { ...existing };
    existing.hash = hash;
    existing.size = size;
    existing.exists = true;
    existing.mutedUntil = Date.now() + SELF_WRITE_MUTE_MS;
    return snapshot;
  }

  private restoreTracked(path: string, snapshot: TrackedDocument | null): void {
    const key = workspacePathKey(path);
    if (snapshot) this.tracked.set(key, snapshot);
    else this.tracked.delete(key);
  }

  private moveTracked(fromPath: string, toPath: string): void {
    const fromKey = workspacePathKey(fromPath);
    const entry = this.tracked.get(fromKey);
    if (!entry) return;
    this.tracked.delete(fromKey);
    this.tracked.set(workspacePathKey(toPath), { ...entry, path: toPath, mutedUntil: 0 });
  }

  // -- watcher --------------------------------------------------------------

  private ensureWatcher(): void {
    if (!this.shouldWatch) return;
    const root = this.workspace.current?.summary.rootPath ?? null;
    if (root === null) {
      this.stopWatcher();
      return;
    }
    if (this.watchRoot === root && (this.watcher || this.pollTimer)) return;

    this.stopWatcher();
    this.watchRoot = root;
    try {
      this.watcher = watch(root, { recursive: true, persistent: false }, () => {
        this.scheduleScan();
      });
      this.watcher.on('error', () => {
        this.startPolling();
      });
    } catch {
      this.startPolling();
    }
  }

  private stopWatcher(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.watchRoot = null;
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.pollTimer = setInterval(() => {
      void this.pollNow().catch(() => undefined);
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  private scheduleScan(): void {
    if (this.scanTimer) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      void this.pollNow().catch(() => undefined);
    }, WATCH_DEBOUNCE_MS);
    this.scanTimer.unref?.();
  }

  private async checkTracked(entry: TrackedDocument, guard: WorkspacePathGuard): Promise<void> {
    if (Date.now() < entry.mutedUntil) return;

    const absolute = guard.resolve(entry.path);
    let stats;
    try {
      stats = await stat(absolute);
    } catch (error) {
      if (!isNotFound(error)) return;
      if (entry.exists) {
        entry.exists = false;
        entry.hash = null;
        entry.size = null;
        entry.mtimeMs = null;
        this.emit({ path: entry.path, kind: 'deleted', hash: null, mtimeMs: null, size: null });
      }
      return;
    }

    if (!stats.isFile()) return;
    if (
      entry.exists &&
      entry.size === stats.size &&
      entry.mtimeMs === stats.mtimeMs &&
      entry.hash !== null
    ) {
      return;
    }

    if (stats.size > this.maxDocumentBytes) {
      entry.exists = true;
      entry.size = stats.size;
      entry.mtimeMs = stats.mtimeMs;
      entry.hash = null;
      this.emit({
        path: entry.path,
        kind: 'modified',
        hash: null,
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      });
      return;
    }

    const bytes = await readFile(absolute).catch(() => null);
    if (!bytes) return;
    const hash = sha256Hex(bytes);
    const wasMissing = !entry.exists;
    const previousHash = entry.hash;
    entry.exists = true;
    entry.size = bytes.byteLength;
    entry.mtimeMs = stats.mtimeMs;
    entry.hash = hash;

    if (!wasMissing && previousHash === hash) return;
    this.emit({
      path: entry.path,
      kind: 'modified',
      hash,
      mtimeMs: stats.mtimeMs,
      size: bytes.byteLength,
    });
  }

  private emit(event: DocumentChangeEvent): void {
    this.eventSink?.(event);
  }
}
