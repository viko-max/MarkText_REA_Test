import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createWorkspacePathGuard,
  isPathInside,
  WorkspacePathGuardError,
  type WorkspacePathGuard,
} from '../src/main/security/workspace-paths';

const testRoot = join(process.cwd(), '.test-runtime');
let sandbox: string;
let workspaceRoot: string;
let outsideRoot: string;
let guard: WorkspacePathGuard;
let junctionAvailable = false;

beforeAll(async () => {
  await mkdir(testRoot, { recursive: true });
  sandbox = await mkdtemp(join(testRoot, 'paths-'));
  workspaceRoot = join(sandbox, 'workspace');
  outsideRoot = join(sandbox, 'outside');

  await mkdir(join(workspaceRoot, 'notes'), { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await writeFile(join(workspaceRoot, 'notes', 'a.md'), '# a\n', 'utf8');
  await writeFile(join(outsideRoot, 'secret.md'), '# secret\n', 'utf8');

  guard = await createWorkspacePathGuard(workspaceRoot);

  try {
    await symlink(outsideRoot, join(workspaceRoot, 'escape-link'), 'junction');
    junctionAvailable = true;
  } catch {
    junctionAvailable = false;
  }
});

afterAll(async () => {
  // Only this file's sandbox: `.test-runtime` is shared with other test files
  // (for example the link fixtures), so removing the parent would race them.
  if (sandbox) await rm(sandbox, { recursive: true, force: true });
});

describe('createWorkspacePathGuard', () => {
  it('uses the canonical root', async () => {
    const direct = await createWorkspacePathGuard(join(workspaceRoot, 'notes', '..'));
    expect(direct.root).toBe(guard.root);
  });

  it('reports a missing root as not_found', async () => {
    await expect(createWorkspacePathGuard(join(sandbox, 'missing'))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rejects a file as the workspace root', async () => {
    await expect(createWorkspacePathGuard(join(workspaceRoot, 'notes', 'a.md'))).rejects.toMatchObject({
      code: 'invalid_path',
    });
  });

  it('resolves a valid relative path inside the root', () => {
    const absolute = guard.resolve('notes/a.md');
    expect(absolute.toLowerCase()).toBe(join(guard.root, 'notes', 'a.md').toLowerCase());
    expect(isPathInside(guard.root, absolute)).toBe(true);
  });

  it('rejects absolute, traversal and backslash paths before touching disk', () => {
    for (const bad of ['/etc/passwd', 'C:/Windows/win.ini', '../outside.md', 'notes/../../x.md', 'notes\\a.md', '']) {
      expect(() => guard.resolve(bad)).toThrow(WorkspacePathGuardError);
    }
  });

  it('returns not_found for missing entries', async () => {
    await expect(guard.resolveExisting('notes/missing.md')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('resolves a new file whose parent exists', async () => {
    const target = await guard.resolveNew('notes/new.md');
    expect(target.toLowerCase()).toBe(join(guard.root, 'notes', 'new.md').toLowerCase());
  });

  it('resolves new files under directories that do not exist yet, inside the root', async () => {
    const target = await guard.resolveNew('missing-dir/nested/new.md');
    expect(isPathInside(guard.root, target)).toBe(true);
  });

  it('blocks reads that traverse a junction out of the workspace', async () => {
    if (!junctionAvailable) return;
    await expect(guard.resolveExisting('escape-link/secret.md')).rejects.toMatchObject({
      code: 'outside_workspace',
    });
  });

  it('blocks writes that traverse a junction out of the workspace', async () => {
    if (!junctionAvailable) return;
    await expect(guard.resolveNew('escape-link/new.md')).rejects.toMatchObject({
      code: 'outside_workspace',
    });
  });
});

describe('isPathInside', () => {
  it('accepts the root itself and descendants', () => {
    expect(isPathInside('C:/work', 'C:/work')).toBe(true);
    expect(isPathInside('C:/work', 'C:/work/notes/a.md')).toBe(true);
  });

  it('rejects siblings, parents and differently rooted paths', () => {
    expect(isPathInside('C:/work', 'C:/work-other/a.md')).toBe(false);
    expect(isPathInside('C:/work', 'C:/work/../secret.md')).toBe(false);
    expect(isPathInside('C:/work', 'D:/work/a.md')).toBe(false);
  });
});
