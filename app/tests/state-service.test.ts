import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../src/main/services/atomic-write';
import { StateService } from '../src/main/services/state-service';
import type { WorkspaceService } from '../src/main/services/workspace-service';
import { createDefaultWorkspaceUiState } from '../src/shared/defaults';
import type { WorkspaceUiState } from '../src/shared/contracts';
import { createTestWorkspace, type TestWorkspace } from './workspace-fixture';

let workspace: TestWorkspace;
let stateDir: string;
let states: StateService;
const NOW = new Date('2026-11-02T10:00:00.000Z');

beforeAll(async () => {
  workspace = await createTestWorkspace('state');
  stateDir = join(workspace.base, 'state');
  states = new StateService(workspace.service, { stateDir, now: () => NOW });
});

afterAll(async () => {
  await workspace.cleanup();
});

function statePath(root: string): string {
  const key = process.platform === 'win32' ? root.toLowerCase() : root;
  return join(stateDir, 'workspaces', `${sha256Hex(key)}.json`);
}

function sampleState(): WorkspaceUiState {
  const base = createDefaultWorkspaceUiState(workspace.root, NOW.toISOString());
  return {
    ...base,
    openDocuments: ['notes/a.md', 'notes/b.md'],
    activeDocument: 'notes/b.md',
    documentViews: {
      'notes/a.md': { selection: { anchor: 1, head: 4 }, scrollTop: 12, viewMode: 'edit' },
      'notes/b.md': { selection: null, scrollTop: 0, viewMode: 'preview' },
    },
  };
}

function createClosedWorkspace(): WorkspaceService {
  return {
    current: null,
    require: () => {
      throw new Error('no workspace');
    },
  } as unknown as WorkspaceService;
}

/** WorkspaceService double whose root can change, like `setRoot` does. */
function createSwitchableWorkspace(initialRoot: string): {
  service: WorkspaceService;
  setRoot(root: string): void;
} {
  const activeFor = (rootPath: string) => ({
    summary: { rootPath, name: 'workspace', openedAt: NOW.toISOString() },
  });
  let active = activeFor(initialRoot);
  return {
    service: {
      get current() {
        return active;
      },
      require: () => active,
    } as unknown as WorkspaceService,
    setRoot(root: string) {
      active = activeFor(root);
    },
  };
}

describe('StateService', () => {
  it('returns defaults when no state file exists', async () => {
    const loaded = await states.load();
    expect(loaded.workspaceRootPath).toBe(workspace.root);
    expect(loaded.openDocuments).toEqual([]);
    expect(loaded.activeDocument).toBeNull();
    expect(loaded.documentViews).toEqual({});
    expect(loaded.version).toBe(1);
  });

  it('round-trips open documents, active document and editor views atomically', async () => {
    await states.save(sampleState());
    const file = statePath(workspace.root);
    const raw = await readFile(file, 'utf8');
    expect(JSON.parse(raw)).toMatchObject({
      workspaceRootPath: workspace.root,
      activeDocument: 'notes/b.md',
    });
    expect(raw.endsWith('\n')).toBe(true);

    const loaded = await states.load();
    expect(loaded.openDocuments).toEqual(['notes/a.md', 'notes/b.md']);
    expect(loaded.activeDocument).toBe('notes/b.md');
    expect(loaded.documentViews['notes/a.md']).toEqual({
      selection: { anchor: 1, head: 4 },
      scrollTop: 12,
      viewMode: 'edit',
    });
    expect(loaded.updatedAt).toBe(NOW.toISOString());

    const names = await readdir(join(stateDir, 'workspaces'));
    expect(names.some((name) => name.includes('.tmp'))).toBe(false);
  });

  it('falls back to defaults for corrupt or unsupported state', async () => {
    await states.save(sampleState());
    const file = statePath(workspace.root);

    await writeFile(file, '{ not json', 'utf8');
    expect((await states.load()).openDocuments).toEqual([]);

    const unsupported = { ...sampleState(), version: 99 };
    await writeFile(file, JSON.stringify(unsupported), 'utf8');
    expect((await states.load()).openDocuments).toEqual([]);

    const badDocuments = { ...sampleState(), openDocuments: ['notes/a.txt'] };
    await writeFile(file, JSON.stringify(badDocuments), 'utf8');
    expect((await states.load()).activeDocument).toBeNull();
  });

  it('keeps one state file per workspace root and a global file when closed', async () => {
    const closed = {
      current: null,
      require: () => {
        throw new Error('no workspace');
      },
    } as unknown as WorkspaceService;
    const globalStates = new StateService(closed, { stateDir, now: () => NOW });

    const globalState = createDefaultWorkspaceUiState(null, NOW.toISOString());
    await globalStates.save({ ...globalState, openDocuments: ['notes/a.md'], activeDocument: 'notes/a.md' });
    const loaded = await globalStates.load();
    expect(loaded.workspaceRootPath).toBeNull();
    expect(loaded.openDocuments).toEqual(['notes/a.md']);
    expect(await readFile(join(stateDir, 'workspace-state.json'), 'utf8')).toContain('notes/a.md');
  });

  it('mirrors each save globally so a restart without a root restores the last workspace', async () => {
    await states.save(sampleState());

    const globalRaw = await readFile(join(stateDir, 'workspace-state.json'), 'utf8');
    expect(JSON.parse(globalRaw)).toMatchObject({
      workspaceRootPath: workspace.root,
      activeDocument: 'notes/b.md',
    });

    const closed = new StateService(createClosedWorkspace(), { stateDir, now: () => NOW });
    const loaded = await closed.load();
    expect(loaded.workspaceRootPath).toBe(workspace.root);
    expect(loaded.openDocuments).toEqual(['notes/a.md', 'notes/b.md']);
    expect(loaded.activeDocument).toBe('notes/b.md');
  });

  it('loads the state belonging to the current root after the root changes', async () => {
    const roots = createSwitchableWorkspace(workspace.root);
    const service = new StateService(roots.service, { stateDir, now: () => NOW });
    const otherRoot = join(workspace.base, 'second-workspace');

    await service.save({
      ...sampleState(),
      openDocuments: ['notes/a.md'],
      activeDocument: 'notes/a.md',
    });
    roots.setRoot(otherRoot);
    await service.save({
      ...sampleState(),
      openDocuments: ['notes/b.md'],
      activeDocument: 'notes/b.md',
    });

    const second = await service.load();
    expect(second.workspaceRootPath).toBe(otherRoot);
    expect(second.activeDocument).toBe('notes/b.md');
    expect(await readFile(statePath(otherRoot), 'utf8')).toContain('notes/b.md');
    expect(await readFile(statePath(workspace.root), 'utf8')).toContain('notes/a.md');

    roots.setRoot(workspace.root);
    const first = await service.load();
    expect(first.workspaceRootPath).toBe(workspace.root);
    expect(first.activeDocument).toBe('notes/a.md');

    // The global mirror always names the most recently saved root.
    const closed = new StateService(createClosedWorkspace(), { stateDir, now: () => NOW });
    expect((await closed.load()).workspaceRootPath).toBe(otherRoot);
  });

  it('falls back to defaults when the global state file is corrupt', async () => {
    await states.save(sampleState());
    await writeFile(join(stateDir, 'workspace-state.json'), '{ not json', 'utf8');

    const closed = new StateService(createClosedWorkspace(), { stateDir, now: () => NOW });
    const loaded = await closed.load();
    expect(loaded.workspaceRootPath).toBeNull();
    expect(loaded.openDocuments).toEqual([]);
    expect(loaded.activeDocument).toBeNull();
    expect(loaded.updatedAt).toBe(NOW.toISOString());
  });

  it('rejects an invalid state instead of writing it', async () => {
    const invalid = { ...sampleState(), activeDocument: 'notes/a.txt' } as unknown as WorkspaceUiState;
    await expect(states.save(invalid)).rejects.toMatchObject({ code: 'invalid_request' });
  });
});
