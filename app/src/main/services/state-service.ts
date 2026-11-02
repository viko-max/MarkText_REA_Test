/**
 * Persists the small amount of UI state that should survive a restart:
 * theme, layout, open documents, the active document, and per-document
 * selection/scroll/view mode. Undo history is intentionally not restored.
 *
 * State lives under the runtime data directory (never the user profile) and is
 * written atomically. Each save is written per workspace root and mirrored to
 * the global `workspace-state.json`, so a restart without an open workspace can
 * resume the last root. A corrupt or obsolete file falls back to defaults rather
 * than blocking startup.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { WorkspaceUiState } from '../../shared/contracts';
import { WORKSPACE_STATE_VERSION } from '../../shared/contracts';
import { createDefaultWorkspaceUiState } from '../../shared/defaults';
import { validateWorkspaceUiState } from '../../shared/validation';
import { AppError } from '../errors';
import { sha256Hex, writeFileAtomic } from './atomic-write';
import type { WorkspaceService } from './workspace-service';

const RUNTIME_ROOT_ENV = 'MARKDOWN_LITE_USER_DATA';

export interface StateServiceOptions {
  /** Overrides the runtime state directory; tests and embedders use this. */
  stateDir?: string;
  now?: () => Date;
}

function defaultRuntimeRoot(): string {
  const fromEnvironment = process.env[RUNTIME_ROOT_ENV]?.trim();
  if (fromEnvironment) {
    return isAbsolute(fromEnvironment) ? resolve(fromEnvironment) : resolve(process.cwd(), fromEnvironment);
  }
  const isDefaultApp = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === true;
  const base = isDefaultApp ? process.cwd() : dirname(process.execPath);
  return join(base, '.runtime');
}

function normaliseRoot(root: string): string {
  return process.platform === 'win32' ? root.toLowerCase() : root;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  );
}

export class StateService {
  private readonly stateDir: string;
  private readonly now: () => Date;

  constructor(
    private readonly workspace: WorkspaceService,
    options: StateServiceOptions = {},
  ) {
    this.stateDir = options.stateDir ?? join(defaultRuntimeRoot(), 'state');
    this.now = options.now ?? (() => new Date());
  }

  get stateDirectory(): string {
    return this.stateDir;
  }

  get workspaceRoot(): string | null {
    return this.workspace.current?.summary.rootPath ?? null;
  }

  async load(): Promise<WorkspaceUiState> {
    const root = this.workspaceRoot;
    const file = this.filePath(root);

    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      if (isNotFound(error)) return this.fallback(root);
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return this.fallback(root);
    }

    const validated = validateWorkspaceUiState(parsed);
    if (!validated.ok) return this.fallback(root);
    if (root !== null) {
      const storedRoot = validated.value.workspaceRootPath;
      if (storedRoot === null || normaliseRoot(storedRoot) !== normaliseRoot(root)) {
        return this.fallback(root);
      }
    }
    return validated.value;
  }

  async save(state: WorkspaceUiState): Promise<void> {
    const root = this.workspaceRoot;
    const next: WorkspaceUiState = {
      ...state,
      version: WORKSPACE_STATE_VERSION,
      workspaceRootPath: root,
      updatedAt: this.now().toISOString(),
    };
    const validated = validateWorkspaceUiState(next);
    if (!validated.ok) {
      throw new AppError('invalid_request', `workspace state is invalid: ${validated.message}`);
    }

    const payload = `${JSON.stringify(validated.value, null, 2)}\n`;
    const rootFile = this.filePath(root);
    await mkdir(dirname(rootFile), { recursive: true });
    await writeFileAtomic(rootFile, payload);

    // The same state is mirrored globally so a restart without an open
    // workspace can restore the last root. Root first, global second; a
    // failure propagates instead of leaving the caller believing both wrote.
    const globalFile = this.filePath(null);
    if (globalFile !== rootFile) {
      await mkdir(dirname(globalFile), { recursive: true });
      await writeFileAtomic(globalFile, payload);
    }
  }

  /** Path of the state file for the current root (or the global one). */
  private filePath(root: string | null): string {
    if (root === null) return join(this.stateDir, 'workspace-state.json');
    const digest = sha256Hex(normaliseRoot(root));
    return join(this.stateDir, 'workspaces', `${digest}.json`);
  }

  private fallback(root: string | null): WorkspaceUiState {
    return createDefaultWorkspaceUiState(root, this.now().toISOString());
  }
}
