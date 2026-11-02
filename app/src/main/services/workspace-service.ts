import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';
import { basename } from 'node:path';
import type {
  GetWorkspaceTreeRequest,
  OpenWorkspaceResult,
  WorkspaceSummary,
  WorkspaceTree,
} from '../../shared/contracts';
import { AppError } from '../errors';
import { createWorkspacePathGuard, type WorkspacePathGuard } from '../security/workspace-paths';
import { buildWorkspaceTree } from './workspace-tree';

export interface ActiveWorkspace {
  summary: WorkspaceSummary;
  guard: WorkspacePathGuard;
}

/**
 * Owns the active workspace root. Every other service resolves renderer
 * paths through this service's guard, so no handler can reach outside the
 * folder the user picked.
 */
export class WorkspaceService {
  private active: ActiveWorkspace | null = null;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  get current(): ActiveWorkspace | null {
    return this.active;
  }

  require(): ActiveWorkspace {
    if (!this.active) {
      throw new AppError('no_workspace', 'no workspace is open');
    }
    return this.active;
  }

  /** Shows the native directory picker; the renderer never supplies a path. */
  async open(): Promise<OpenWorkspaceResult> {
    const window = this.getWindow();
    const options = {
      title: 'Open workspace',
      buttonLabel: 'Open',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options);

    const selected = result.filePaths[0];
    if (result.canceled || !selected) {
      return { cancelled: true, workspace: null };
    }
    const summary = await this.setRoot(selected);
    return { cancelled: false, workspace: summary };
  }

  /** Canonicalises and validates a root before making it active. */
  async setRoot(rootPath: string): Promise<WorkspaceSummary> {
    const guard = await createWorkspacePathGuard(rootPath);
    const summary: WorkspaceSummary = {
      rootPath: guard.root,
      name: basename(guard.root),
      openedAt: new Date().toISOString(),
    };
    this.active = { summary, guard };
    return summary;
  }

  close(): void {
    this.active = null;
  }

  /** Directory tree rooted at `request.path`, bounded by `request.depth`. */
  async getTree(request: GetWorkspaceTreeRequest): Promise<WorkspaceTree> {
    const { summary, guard } = this.require();
    return buildWorkspaceTree(guard, summary, request);
  }
}
