import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { LinkService, type LinkWorkspaceSource } from '../src/main/services/link-service';
import { createWorkspacePathGuard } from '../src/main/security/workspace-paths';
import type { WorkspaceSummary } from '../src/shared/contracts';

/** Scratch area inside the app directory; already covered by `.gitignore`. */
export const LINK_TEST_ROOT = resolve(import.meta.dirname, '..', '.test-runtime', 'links');

export interface TempWorkspace {
  root: string;
  source: LinkWorkspaceSource;
  service: LinkService;
  write(relativePath: string, markdown: string): Promise<void>;
  remove(relativePath: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createTempWorkspace(
  notes: Record<string, string> = {},
): Promise<TempWorkspace> {
  await mkdir(LINK_TEST_ROOT, { recursive: true });
  const root = await mkdtemp(join(LINK_TEST_ROOT, 'ws-'));
  const canonicalRoot = root;

  for (const [path, markdown] of Object.entries(notes)) {
    await writeWorkspaceFile(canonicalRoot, path, markdown);
  }

  const guard = await createWorkspacePathGuard(root);
  const summary: WorkspaceSummary = {
    rootPath: guard.root,
    name: 'test-workspace',
    openedAt: new Date().toISOString(),
  };
  const source: LinkWorkspaceSource = { require: () => ({ summary, guard }) };

  return {
    root: guard.root,
    source,
    service: new LinkService(source),
    write: (relativePath, markdown) => writeWorkspaceFile(guard.root, relativePath, markdown),
    remove: (relativePath) => rm(join(guard.root, ...relativePath.split('/')), { force: true }),
    cleanup: () => rm(guard.root, { recursive: true, force: true }),
  };
}

async function writeWorkspaceFile(root: string, relativePath: string, markdown: string): Promise<void> {
  const segments = relativePath.split('/');
  const absolute = join(root, ...segments);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, markdown, 'utf8');
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}
