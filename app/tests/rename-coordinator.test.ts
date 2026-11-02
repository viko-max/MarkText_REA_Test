import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/main/errors';
import { DocumentService } from '../src/main/services/document-service';
import { LinkService } from '../src/main/services/link-service';
import { RenameCoordinator } from '../src/main/services/rename-coordinator';
import type { WorkspaceService } from '../src/main/services/workspace-service';
import type {
  RenameDocumentRequest,
  RenameDocumentResult,
  SaveDocumentRequest,
  SaveDocumentResult,
} from '../src/shared/contracts';
import { createTestWorkspace, type TestWorkspace } from './workspace-fixture';

const created: TestWorkspace[] = [];

afterAll(async () => {
  await Promise.all(created.map((workspace) => workspace.cleanup()));
});

async function workspaceWith(files: Record<string, string> = {}): Promise<TestWorkspace> {
  const temp = await createTestWorkspace('rename');
  created.push(temp);
  for (const [path, markdown] of Object.entries(files)) {
    await writeRelative(temp, path, markdown);
  }
  return temp;
}

function absolutePath(workspace: TestWorkspace, relativePath: string): string {
  return join(workspace.root, ...relativePath.split('/'));
}

async function writeRelative(
  workspace: TestWorkspace,
  relativePath: string,
  markdown: string,
): Promise<void> {
  const absolute = absolutePath(workspace, relativePath);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, markdown, 'utf8');
}

async function readRelative(workspace: TestWorkspace, relativePath: string): Promise<string> {
  return readFile(absolutePath(workspace, relativePath), 'utf8');
}

async function exists(workspace: TestWorkspace, relativePath: string): Promise<boolean> {
  try {
    await stat(absolutePath(workspace, relativePath));
    return true;
  } catch {
    return false;
  }
}

interface FaultHooks {
  beforeSave?(request: SaveDocumentRequest, call: number): Promise<void>;
  beforeRename?(request: RenameDocumentRequest, call: number): Promise<void>;
}

/** Real `DocumentService` with a hook to inject concurrent disk changes. */
class HookedDocumentService extends DocumentService {
  private saveCalls = 0;
  private renameCalls = 0;

  constructor(
    workspace: WorkspaceService,
    private readonly hooks: FaultHooks = {},
  ) {
    super(workspace, { watch: false });
  }

  override async save(request: SaveDocumentRequest): Promise<SaveDocumentResult> {
    this.saveCalls += 1;
    await this.hooks.beforeSave?.(request, this.saveCalls);
    return super.save(request);
  }

  override async rename(request: RenameDocumentRequest): Promise<RenameDocumentResult> {
    this.renameCalls += 1;
    await this.hooks.beforeRename?.(request, this.renameCalls);
    return super.rename(request);
  }
}

function build(workspace: TestWorkspace, hooks: FaultHooks = {}) {
  const documents = new HookedDocumentService(workspace.service, hooks);
  const links = new LinkService(workspace.service);
  return { documents, links, coordinator: new RenameCoordinator(documents, links) };
}

function renameRequest(
  fromPath: string,
  toPath: string,
  updateReferences = true,
): RenameDocumentRequest {
  return { documentId: 'doc-1', fromPath, toPath, updateReferences };
}

describe('RenameCoordinator', () => {
  it('moves a note with no references without writing any document', async () => {
    const workspace = await workspaceWith({
      '笔记.md': '# 笔记\n\n正文\n',
      '其他.md': '# 其他\n\n[[别的]]\n',
    });
    const { coordinator, links } = build(workspace);
    const invalidate = vi.spyOn(links, 'invalidate');

    const result = await coordinator.rename(renameRequest('笔记.md', '新笔记.md'));

    expect(result).toEqual({
      path: '新笔记.md',
      referenceEdits: [],
      skippedReferences: [],
      referencesDeferred: false,
    });
    expect(await readRelative(workspace, '笔记.md').catch(() => null)).toBeNull();
    expect(await readRelative(workspace, '新笔记.md')).toBe('# 笔记\n\n正文\n');
    expect(await readRelative(workspace, '其他.md')).toBe('# 其他\n\n[[别的]]\n');
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('rewrites ordinary references after moving the note', async () => {
    const workspace = await workspaceWith({
      'index.md': '# 索引\n\n[[笔记]] 与 [[笔记|别名]]\n',
      '笔记.md': '# 笔记\n',
    });
    const { coordinator } = build(workspace);

    const result = await coordinator.rename(renameRequest('笔记.md', '新笔记.md'));

    expect(result.referenceEdits).toEqual([
      { documentPath: 'index.md', from: '笔记', to: '新笔记', occurrences: 2 },
    ]);
    expect(result.skippedReferences).toEqual([]);
    expect(result.referencesDeferred).toBe(false);
    expect(await readRelative(workspace, 'index.md')).toBe(
      '# 索引\n\n[[新笔记]] 与 [[新笔记|别名]]\n',
    );
    expect(await readRelative(workspace, '新笔记.md')).toBe('# 笔记\n');
  });

  it('leaves ambiguous same-name references untouched and reports them', async () => {
    const workspace = await workspaceWith({
      'index.md': '# 索引\n\n[[同名]]\n',
      'a/同名.md': '# A\n',
      'b/同名.md': '# B\n',
    });
    const { coordinator } = build(workspace);

    const result = await coordinator.rename(renameRequest('a/同名.md', 'a/新同名.md'));

    expect(result.referenceEdits).toEqual([]);
    expect(result.skippedReferences).toEqual([
      { documentPath: 'index.md', line: 3, raw: '[[同名]]', reason: 'ambiguous' },
    ]);
    expect(await readRelative(workspace, 'index.md')).toBe('# 索引\n\n[[同名]]\n');
    expect(await readRelative(workspace, 'a/新同名.md')).toBe('# A\n');
    expect(await exists(workspace, 'a/同名.md')).toBe(false);
  });

  it('rewrites the moved note own self links at its new path', async () => {
    const workspace = await workspaceWith({
      'index.md': '# 索引\n\n[[笔记]]\n',
      '目录/笔记.md': '# 笔记\n\n自链 [[笔记]] 与 [[目录/笔记]]\n',
    });
    const { coordinator } = build(workspace);

    const result = await coordinator.rename(renameRequest('目录/笔记.md', '目录/新笔记.md'));

    expect(result.referenceEdits).toEqual([
      { documentPath: 'index.md', from: '笔记', to: '新笔记', occurrences: 1 },
      { documentPath: '目录/笔记.md', from: '目录/笔记', to: '目录/新笔记', occurrences: 1 },
      { documentPath: '目录/笔记.md', from: '笔记', to: '新笔记', occurrences: 1 },
    ]);
    expect(await readRelative(workspace, '目录/新笔记.md')).toBe(
      '# 笔记\n\n自链 [[新笔记]] 与 [[目录/新笔记]]\n',
    );
    expect(await readRelative(workspace, 'index.md')).toBe('# 索引\n\n[[新笔记]]\n');
    expect(await exists(workspace, '目录/笔记.md')).toBe(false);
  });

  it('rolls back completed writes and the move when a write conflicts', async () => {
    const workspace = await workspaceWith({
      'a.md': '# A\n\n[[旧]]\n',
      'm.md': '# M\n\n[[旧]]\n',
      'z.md': '# Z\n\n[[旧]]\n',
      '旧.md': '# 旧\n',
    });
    const { coordinator, links } = build(workspace, {
      async beforeSave(request) {
        // Someone edits the second document after the plan was computed.
        if (request.path === 'm.md') {
          await writeRelative(workspace, 'm.md', '# M 外部修改\n\n[[旧]]\n');
        }
      },
    });
    const invalidate = vi.spyOn(links, 'invalidate');

    await expect(coordinator.rename(renameRequest('旧.md', '新.md'))).rejects.toMatchObject({
      code: 'conflict',
      message: 'rename rolled back because reference updates failed',
      details: { path: 'm.md' },
    });

    // The note is back at its old path and the completed write was restored.
    expect(await readRelative(workspace, '旧.md')).toBe('# 旧\n');
    expect(await exists(workspace, '新.md')).toBe(false);
    expect(await readRelative(workspace, 'a.md')).toBe('# A\n\n[[旧]]\n');
    // Never-written documents keep their content; the edited one keeps its edit.
    expect(await readRelative(workspace, 'z.md')).toBe('# Z\n\n[[旧]]\n');
    expect(await readRelative(workspace, 'm.md')).toBe('# M 外部修改\n\n[[旧]]\n');
    expect(invalidate).toHaveBeenCalled();
  });

  it('reports an incomplete rollback instead of claiming the rename was undone', async () => {
    const workspace = await workspaceWith({
      'a.md': '# A\n\n[[旧]]\n',
      'm.md': '# M\n\n[[旧]]\n',
      '旧.md': '# 旧\n',
    });
    const { coordinator } = build(workspace, {
      async beforeSave(request, call) {
        if (request.path === 'm.md') {
          await writeRelative(workspace, 'm.md', '# M 外部修改\n\n[[旧]]\n');
        }
        // The restore of a.md is refused as well: the rollback cannot finish.
        if (call > 1 && request.path === 'a.md') {
          await writeRelative(workspace, 'a.md', '# A 回滚期间被修改\n');
        }
      },
      async beforeRename(_request, call) {
        // And the old path is occupied, so the move cannot be undone either.
        if (call === 2) {
          await writeRelative(workspace, '旧.md', '# 被占用\n');
        }
      },
    });

    const error: unknown = await coordinator
      .rename(renameRequest('旧.md', '新.md'))
      .then(
        () => null,
        (caught: unknown) => caught,
      );

    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe('conflict');
    expect(appError.message).toBe('rename rollback incomplete');
    expect(appError.details).toMatchObject({
      path: 'm.md',
      failure: { operation: 'write', path: 'm.md', code: 'conflict' },
    });
    expect(appError.details?.rollbackFailures).toEqual([
      { operation: 'restore', path: 'a.md', code: 'conflict', message: expect.any(String) },
      { operation: 'rename', path: '新.md', code: 'conflict', message: expect.any(String) },
    ]);

    // Nothing claims recovery: the note still sits at the new path.
    expect(await exists(workspace, '新.md')).toBe(true);
    expect(await readRelative(workspace, 'a.md')).toBe('# A 回滚期间被修改\n');
  });

  it('skips planning and writes when reference updating is off', async () => {
    const workspace = await workspaceWith({
      'index.md': '# 索引\n\n[[笔记]]\n',
      '笔记.md': '# 笔记\n',
    });
    const { coordinator, links } = build(workspace);
    const plan = vi.spyOn(links, 'renamePlan');

    const result = await coordinator.rename(renameRequest('笔记.md', '新笔记.md', false));

    expect(result).toEqual({
      path: '新笔记.md',
      referenceEdits: [],
      skippedReferences: [],
      referencesDeferred: false,
    });
    expect(plan).not.toHaveBeenCalled();
    expect(await readRelative(workspace, 'index.md')).toBe('# 索引\n\n[[笔记]]\n');
    expect(await readRelative(workspace, '新笔记.md')).toBe('# 笔记\n');
  });
});
