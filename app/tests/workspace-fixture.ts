/**
 * Filesystem fixture for service tests.
 *
 * Everything is created under `app/.runtime/test-data` (git-ignored), never in
 * the user profile or outside the project. Each call gets its own directory.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createWorkspacePathGuard, type WorkspacePathGuard } from '../src/main/security/workspace-paths';
import type { WorkspaceService } from '../src/main/services/workspace-service';
import type { WorkspaceSummary } from '../src/shared/contracts';

export interface TestWorkspace {
  base: string;
  root: string;
  summary: WorkspaceSummary;
  guard: WorkspacePathGuard;
  /** Minimal WorkspaceService surface used by the services under test. */
  service: WorkspaceService;
  cleanup(): Promise<void>;
}

export async function createTestWorkspace(prefix = 'ws'): Promise<TestWorkspace> {
  const testRoot = join(process.cwd(), '.runtime', 'test-data');
  await mkdir(testRoot, { recursive: true });
  const base = await mkdtemp(join(testRoot, `${prefix}-`));
  const root = join(base, 'workspace');
  await mkdir(root, { recursive: true });

  const guard = await createWorkspacePathGuard(root);
  const summary: WorkspaceSummary = {
    rootPath: guard.root,
    name: 'workspace',
    openedAt: new Date().toISOString(),
  };
  const active = { summary, guard };
  const service = {
    current: active,
    require: () => active,
  } as unknown as WorkspaceService;

  return {
    base,
    root: guard.root,
    summary,
    guard,
    service,
    async cleanup() {
      await rm(base, { recursive: true, force: true });
    },
  };
}
