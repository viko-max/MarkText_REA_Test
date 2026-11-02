import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildWorkspaceTree } from '../src/main/services/workspace-tree';
import { createTestWorkspace, type TestWorkspace } from './workspace-fixture';

let workspace: TestWorkspace;

beforeAll(async () => {
  workspace = await createTestWorkspace('tree');
  const root = workspace.root;
  await mkdir(join(root, 'notes'), { recursive: true });
  await mkdir(join(root, 'pages'), { recursive: true });
  await mkdir(join(root, 'empty'), { recursive: true });
  await mkdir(join(root, '.hidden'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
  await writeFile(join(root, 'root.md'), '# root\n', 'utf8');
  await writeFile(join(root, 'notes', 'a.md'), '# a\n', 'utf8');
  await writeFile(join(root, 'notes', 'b.markdown'), '# b\n', 'utf8');
  await writeFile(join(root, 'notes', 'c.txt'), 'ignored\n', 'utf8');
  await writeFile(join(root, 'pages', 'index.html'), '<h1>hi</h1>', 'utf8');
  await writeFile(join(root, 'pages', 'legacy.htm'), '<h1>hi</h1>', 'utf8');
  await writeFile(join(root, '.hidden', 'secret.md'), '# secret\n', 'utf8');
  await writeFile(join(root, 'node_modules', 'pkg', 'readme.md'), '# pkg\n', 'utf8');
});

afterAll(async () => {
  await workspace.cleanup();
});

describe('buildWorkspaceTree', () => {
  it('lists only Markdown and HTML notes, directories first', async () => {
    const tree = await buildWorkspaceTree(workspace.guard, workspace.summary, { path: '', depth: 0 });
    expect(tree.path).toBe('');
    expect(tree.truncated).toBe(false);
    expect(tree.nodes.map((node) => node.path)).toEqual([
      'empty',
      'notes',
      'pages',
      'root.md',
    ]);
    expect(tree.nodes.every((node) => node.kind === 'directory' || node.path === 'root.md')).toBe(true);
    expect(tree.nodes[0]?.children).toBeNull();
  });

  it('loads nested children to the requested depth', async () => {
    const depthOne = await buildWorkspaceTree(workspace.guard, workspace.summary, {
      path: '',
      depth: 1,
    });
    const notes = depthOne.nodes.find((node) => node.path === 'notes');
    expect(notes?.children?.map((child) => child.path)).toEqual([
      'notes/a.md',
      'notes/b.markdown',
    ]);

    const depthTwo = await buildWorkspaceTree(workspace.guard, workspace.summary, {
      path: '',
      depth: 2,
    });
    const pages = depthTwo.nodes.find((node) => node.path === 'pages');
    expect(pages?.children?.map((child) => child.name).sort()).toEqual(['index.html', 'legacy.htm']);
  });

  it('supports a subtree request', async () => {
    const tree = await buildWorkspaceTree(workspace.guard, workspace.summary, {
      path: 'notes',
      depth: 0,
    });
    expect(tree.path).toBe('notes');
    expect(tree.nodes.map((node) => node.name)).toEqual(['a.md', 'b.markdown']);
    const file = tree.nodes[0];
    expect(file?.size).toBeGreaterThan(0);
    expect(file?.mtimeMs).toBeGreaterThan(0);
  });

  it('rejects a file used as a directory', async () => {
    await expect(
      buildWorkspaceTree(workspace.guard, workspace.summary, { path: 'root.md', depth: 1 }),
    ).rejects.toMatchObject({ code: 'invalid_path' });
  });

  it('marks the tree truncated when the node budget is exhausted', async () => {
    const tree = await buildWorkspaceTree(
      workspace.guard,
      workspace.summary,
      { path: '', depth: 2 },
      { maxNodes: 2 },
    );
    expect(tree.truncated).toBe(true);
    expect(tree.nodes.length).toBeLessThanOrEqual(3);
  });

  it('hides dot directories and node_modules', async () => {
    const tree = await buildWorkspaceTree(workspace.guard, workspace.summary, { path: '', depth: 2 });
    const paths = tree.nodes.map((node) => node.path);
    expect(paths).not.toContain('.hidden');
    expect(paths).not.toContain('node_modules');
    expect(tree.nodes.find((node) => node.path === 'notes')?.children?.some((child) => child.path.endsWith('c.txt'))).toBe(
      false,
    );
  });
});
