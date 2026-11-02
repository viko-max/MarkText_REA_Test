/**
 * Renderer application shell.
 *
 * One window, three columns: workspace tree/tabs, CodeMirror editor plus the
 * shared HTML preview (and the graph as a middle view), and backlinks/outline/
 * theme panel. The shell only orchestrates the feature modules: it never
 * renders Markdown itself (the pipeline owns that) and never writes files
 * (the main process owns that).
 */

import './styles.css';

import type {
  AppInfo,
  DocumentChangeEvent,
  DocumentViewState,
  ExportHtmlResult,
  LayoutConfig,
  RenameDocumentResult,
  SkippedReference,
  ThemeConfig,
  ViewMode,
  WorkspaceNode,
  WorkspaceSummary,
  WorkspaceUiState,
} from '../../shared/contracts';
import { WORKSPACE_STATE_VERSION } from '../../shared/contracts';
import {
  createDefaultTheme,
  createDefaultWorkspaceUiState,
  DEFAULT_LAYOUT,
  DEFAULT_WALLPAPER,
} from '../../shared/defaults';
import type { IpcFailure } from '../../shared/ipc';
import {
  isHtmlPath,
  isMarkdownPath,
  isWorkspaceRelativePath,
  workspaceBasename,
  workspaceDirname,
  workspaceStem,
} from '../../shared/paths';
import { mountEditor } from './editor';
import type { EditorHost, EditorSaveOutcome, EditorTabInfo } from './editor';
import {
  createHtmlWorkspace,
  describeDependencySummary,
} from './html';
import type { HtmlWorkspaceController, HtmlWorkspaceState } from './html';
import { applyWikilinkTargets, resolveWikiLinkFromIndex } from './html/preview-links';
import { mountThemePanel } from './html/theme-panel';
import type { ThemePanelController } from './html/theme-panel';
import { createLinkWorkspace } from './links';
import type { BacklinksPanelController, GraphViewController, LinkWorkspaceController } from './links';
import { createAppMarkdownRenderPipeline, normalizeLayout } from './render';
import type { OutlineEntry, RenderResult } from './render';

type ShellViewMode = 'edit' | 'preview' | 'split';

const PREVIEW_DEBOUNCE_MS = 300;
const STATE_DEBOUNCE_MS = 400;
const TREE_DEBOUNCE_MS = 600;

const ERROR_LABELS: Record<string, string> = {
  invalid_request: '请求参数不合法',
  invalid_path: '路径不合法',
  outside_workspace: '路径越出工作区',
  no_workspace: '尚未打开工作区',
  not_found: '路径不存在',
  conflict: '内容冲突',
  too_large: '内容过大',
  permission_denied: '没有权限',
  forbidden: '调用被拒绝',
  not_implemented: '该功能尚未实现',
  internal_error: '内部错误',
};

interface DialogField {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
}

interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
}

interface DialogOptions {
  title: string;
  message?: string;
  fields?: DialogField[];
  buttons?: DialogButton[];
  confirmLabel?: string;
  cancelLabel?: string;
}

type DialogOutcome =
  | { kind: 'submit'; values: Record<string, string> }
  | { kind: 'button'; value: string }
  | null;

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`missing element #${id}`);
  return element as T;
}

function describeFailure(failure: IpcFailure): string {
  const label = ERROR_LABELS[failure.code] ?? failure.code;
  return `${label}（${failure.code}）：${failure.message}`;
}

const CONTEXT_LABELS: Record<string, string> = {
  save: '保存失败',
  paste: '粘贴图片失败',
  reload: '重新加载失败',
};

function describeContext(context: string): string {
  return CONTEXT_LABELS[context] ?? context;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function sameRoot(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return left === right;
  return left.replace(/\\/g, '/').toLowerCase() === right.replace(/\\/g, '/').toLowerCase();
}

/** A theme whose nested objects can be mutated without touching the source. */
function cloneTheme(theme: ThemeConfig): ThemeConfig {
  return {
    ...theme,
    customVariables: { ...theme.customVariables },
    wallpaper: { ...DEFAULT_WALLPAPER, ...(theme.wallpaper ?? {}) },
  };
}

function stateForWorkspace(state: WorkspaceUiState, workspace: WorkspaceSummary): WorkspaceUiState {
  if (sameRoot(state.workspaceRootPath, workspace.rootPath)) return state;
  const fallback = createDefaultWorkspaceUiState(workspace.rootPath);
  return { ...fallback, theme: state.theme, layout: state.layout };
}

function persistedViewMode(mode: ShellViewMode): ViewMode {
  return mode;
}

/** `html` belongs to HTML files only and never persists for Markdown. */
function shellViewModeOf(mode: ViewMode): ShellViewMode {
  return mode === 'html' ? 'preview' : mode;
}

function composeWorkspacePath(directoryRaw: string, fileNameRaw: string): string | null {
  const directory = directoryRaw
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const fileName = fileNameRaw.trim();
  if (fileName.length === 0 || !isMarkdownPath(fileName)) return null;
  const target = directory.length > 0 ? `${directory}/${fileName}` : fileName;
  return isWorkspaceRelativePath(target) ? target : null;
}

function tabState(tab: EditorTabInfo): 'clean' | 'dirty' | 'saving' | 'conflict' | 'missing' {
  if (tab.conflict) return 'conflict';
  if (tab.missing) return 'missing';
  if (tab.saving) return 'saving';
  if (tab.dirty) return 'dirty';
  return 'clean';
}

function tabStateLabel(tab: EditorTabInfo): string {
  if (tab.conflict) return '磁盘已变更，保存被阻止';
  if (tab.missing) return '文件缺失';
  if (tab.saving) return '保存中…';
  if (tab.dirty) return '未保存';
  return '已保存';
}

function summarizeSkippedReferences(list: readonly SkippedReference[]): string {
  const counts = new Map<string, number>();
  for (const item of list) {
    const label =
      item.reason === 'ambiguous' ? '同名歧义' : item.reason === 'unresolvable' ? '无法解析' : '写入失败';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => `${label} ${count} 处`).join('、');
}

function describeRename(result: RenameDocumentResult): string {
  const files = result.referenceEdits.length;
  const occurrences = result.referenceEdits.reduce((sum, edit) => sum + edit.occurrences, 0);
  let text = `已重命名为 ${result.path}：更新 ${files} 个文件中的 ${occurrences} 处引用`;
  if (result.skippedReferences.length > 0) {
    text += `；跳过 ${result.skippedReferences.length} 处（${summarizeSkippedReferences(
      result.skippedReferences,
    )}）`;
  }
  if (result.referencesDeferred) text += '；引用改写尚未完成';
  return text;
}

function countFiles(nodes: readonly WorkspaceNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.kind === 'file') total += 1;
    else if (node.children) total += countFiles(node.children);
  }
  return total;
}

/** Small modal replacement: Electron does not implement `window.prompt`. */
function openDialog(options: DialogOptions): Promise<DialogOutcome> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';

    const form = document.createElement('form');
    form.className = 'modal';
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-modal', 'true');
    form.setAttribute('aria-label', options.title);
    form.noValidate = true;

    const title = document.createElement('h2');
    title.className = 'modal-title';
    title.textContent = options.title;
    form.append(title);

    if (options.message) {
      const message = document.createElement('p');
      message.className = 'modal-message';
      message.textContent = options.message;
      form.append(message);
    }

    const inputs = new Map<string, HTMLInputElement>();
    for (const field of options.fields ?? []) {
      const label = document.createElement('label');
      label.className = 'modal-field';
      const caption = document.createElement('span');
      caption.textContent = field.label;
      const input = document.createElement('input');
      input.type = 'text';
      input.value = field.value;
      input.dataset.field = field.key;
      if (field.placeholder) input.placeholder = field.placeholder;
      label.append(caption, input);
      form.append(label);
      inputs.set(field.key, input);
    }

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    let settled = false;
    const finish = (outcome: DialogOutcome): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      backdrop.remove();
      resolve(outcome);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      finish(null);
    };

    const primaryValue = options.buttons?.find((button) => button.primary)?.value ?? '';

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (inputs.size > 0) {
        const values: Record<string, string> = {};
        for (const [key, input] of inputs) values[key] = input.value;
        finish({ kind: 'submit', values });
        return;
      }
      finish({ kind: 'button', value: primaryValue });
    });

    if (options.buttons && options.buttons.length > 0) {
      for (const button of options.buttons) {
        const element = document.createElement('button');
        element.type = button.primary ? 'submit' : 'button';
        element.className = 'modal-button';
        element.dataset.primary = String(button.primary === true);
        element.textContent = button.label;
        if (!button.primary) {
          element.addEventListener('click', () => finish({ kind: 'button', value: button.value }));
        }
        actions.append(element);
      }
    } else {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'modal-button';
      cancel.textContent = options.cancelLabel ?? '取消';
      cancel.addEventListener('click', () => finish(null));

      const confirm = document.createElement('button');
      confirm.type = 'submit';
      confirm.className = 'modal-button';
      confirm.dataset.primary = 'true';
      confirm.textContent = options.confirmLabel ?? '确定';
      actions.append(cancel, confirm);
    }

    form.append(actions);
    document.addEventListener('keydown', onKeyDown, true);
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) finish(null);
    });
    backdrop.append(form);
    document.body.append(backdrop);

    const firstInput = [...inputs.values()][0];
    if (firstInput) {
      firstInput.focus();
      firstInput.select();
    } else {
      actions.querySelector<HTMLButtonElement>('button[data-primary="true"]')?.focus();
    }
  });
}

class MarkdownLiteShell {
  private readonly api = window.markdownLite;

  private readonly app = byId<HTMLDivElement>('app');
  private readonly welcome = byId<HTMLElement>('welcome');
  private readonly welcomeOpen = byId<HTMLButtonElement>('welcome-open');
  private readonly openButton = byId<HTMLButtonElement>('open-workspace');
  private readonly newNoteButton = byId<HTMLButtonElement>('new-note');
  private readonly renameButton = byId<HTMLButtonElement>('rename-document');
  private readonly findButton = byId<HTMLButtonElement>('find-in-document');
  private readonly autoSaveButton = byId<HTMLButtonElement>('toggle-autosave');
  private readonly graphButton = byId<HTMLButtonElement>('toggle-graph');
  private readonly themeButton = byId<HTMLButtonElement>('toggle-theme-panel');
  private readonly exportButton = byId<HTMLButtonElement>('export-html');
  private readonly envBadge = byId<HTMLElement>('env-badge');
  private readonly versionBadge = byId<HTMLElement>('version-badge');
  private readonly workspaceName = byId<HTMLElement>('workspace-name');

  private readonly tabFiles = byId<HTMLButtonElement>('tab-files');
  private readonly tabOpen = byId<HTMLButtonElement>('tab-open');
  private readonly treePanel = byId<HTMLElement>('tree-panel');
  private readonly tabsPanel = byId<HTMLElement>('tabs-panel');
  private readonly treeEmpty = byId<HTMLElement>('tree-empty');
  private readonly fileTree = byId<HTMLUListElement>('file-tree');
  private readonly documentTabs = byId<HTMLUListElement>('document-tabs');

  private readonly outlineLeftHost = byId<HTMLElement>('outline-left-host');
  private readonly outlineRightHost = byId<HTMLElement>('outline-right-host');
  private readonly outlineSection = byId<HTMLElement>('outline-section');
  private readonly outlineList = byId<HTMLElement>('outline-list');

  private readonly mainArea = byId<HTMLElement>('main-area');
  private readonly editorHostElement = byId<HTMLElement>('editor-host');
  private readonly previewHost = byId<HTMLElement>('preview-host');
  private readonly graphHost = byId<HTMLElement>('graph-host');
  private readonly backlinksHost = byId<HTMLElement>('backlinks-host');
  private readonly themePanelHost = byId<HTMLElement>('theme-panel-host');

  private readonly viewEditButton = byId<HTMLButtonElement>('view-edit');
  private readonly viewSplitButton = byId<HTMLButtonElement>('view-split');
  private readonly viewPreviewButton = byId<HTMLButtonElement>('view-preview');

  private readonly statusDocument = byId<HTMLElement>('status-document');
  private readonly statusExport = byId<HTMLElement>('status-export');
  private readonly statusMessage = byId<HTMLElement>('status-message');
  private readonly statusAction = byId<HTMLButtonElement>('status-action');
  private readonly statusMeta = byId<HTMLElement>('status-meta');

  private readonly editor: EditorHost;
  private readonly links: LinkWorkspaceController;
  private readonly preview: HtmlWorkspaceController;
  private readonly backlinks: BacklinksPanelController;
  private readonly graph: GraphViewController;
  private readonly themePanel: ThemePanelController;

  private theme: ThemeConfig = createDefaultTheme();
  private layout: LayoutConfig = {
    sidebar: { ...DEFAULT_LAYOUT.sidebar },
    outline: { ...DEFAULT_LAYOUT.outline },
    title: { ...DEFAULT_LAYOUT.title },
  };

  private workspace: WorkspaceSummary | null = null;
  private autoSaveEnabled = true;
  private viewMode: ShellViewMode = 'split';
  private uiActivePath: string | null = null;
  private htmlDocumentPath: string | null = null;
  private previewPath: string | null = null;
  private editorTabs: EditorTabInfo[] = [];
  private activeTabId: string | null = null;
  private lastPreviewState: HtmlWorkspaceState | null = null;
  private lastRenderedMarkdown: string | null = null;

  private readonly docIds = new Map<string, string>();
  private readonly shellViewModes = new Map<string, ShellViewMode>();
  private readonly tabSignals = new Map<string, { saving: boolean; dirty: boolean }>();
  private readonly decoratedDocuments = new WeakSet<Document>();
  private readonly previewContext: { documentPath: string } = { documentPath: '' };
  private tabsSignature = '';

  private idCounter = 0;
  private activeToken = 0;
  private previewTask: Promise<void> = Promise.resolve();
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private treeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.editor = mountEditor({
      parent: this.editorHostElement,
      autoSaveDelayMs: 1_200,
      placeholder: '在这里输入 Markdown；Ctrl+S 保存，输入 [[ 可补全双链。',
      save: (request) => this.api.documents.save(request),
      saveCopy: (request) => this.api.documents.saveCopy(request),
      read: (request) => this.api.documents.read(request),
      saveImage: (request) => this.api.images.save(request),
      onStateChange: (tabs, activeId) => this.handleEditorState(tabs, activeId),
      onError: (failure, context) => this.reportFailure(failure, context),
      onImageSaved: (asset, insertion) =>
        this.setStatus(
          insertion.length > 0
            ? `已插入图片：${asset.path}${asset.duplicate ? '（复用已有资源）' : ''}`
            : `图片已保存为 ${asset.path}，但文档已切换，未插入。`,
        ),
    });

    this.links = createLinkWorkspace({
      api: this.api.links,
      onOpenNote: (path) => {
        void this.activateDocument(path);
      },
      onInsertLink: (text, start, end) => {
        this.editor.insertText(text, start, end);
      },
      onMissingTarget: (target) => this.setStatus(`未找到笔记：${target}`, 'error'),
    });

    this.backlinks = this.links.mountBacklinks(this.backlinksHost, { heading: '反链' });
    this.graph = this.links.mountGraph(this.graphHost, {
      getActiveNote: () => this.markdownActivePath(),
      minHeightPx: 260,
      depth: 1,
    });

    const pipeline = createAppMarkdownRenderPipeline({
      resolveWikiLink: async (link) => {
        const index = await this.links.store.getIndex();
        return resolveWikiLinkFromIndex(index, this.previewContext.documentPath, link);
      },
    });

    this.preview = createHtmlWorkspace({
      theme: this.theme,
      layout: this.layout,
      pipeline,
      exporter: (request) => this.api.export.html(request),
      onStateChange: (state) => this.handlePreviewState(state),
      onRendered: (result) => this.handleRendered(result),
      onExportCompleted: (result) => this.handleExportCompleted(result),
    }).mount(this.previewHost);

    this.themePanel = mountThemePanel(this.themePanelHost, {
      theme: this.theme,
      layout: this.layout,
      onChooseWallpaper: () => this.chooseWallpaper(),
      onChange: (change) => this.applyThemeLayout(change.theme, change.layout, change.changed),
    });

    this.bindEvents();
    this.installPreviewBindings();
    this.installWikilinkKeyHandler();
    this.applyLayoutClasses();
    this.applyThemeMode();
    this.applyWallpaper();
    this.applyViewMode('split');
    this.updateActionState();
    this.updateStatusBar();
  }

  async start(): Promise<void> {
    try {
      const info = await this.api.app.getInfo();
      if (info.ok) {
        this.renderInfo(info.value);
      } else {
        this.reportFailure(info.error, '读取应用信息失败');
      }
    } catch (error) {
      this.setStatus(`无法读取应用信息：${toMessage(error)}`, 'error');
    }

    try {
      const restored = await this.api.workspace.restore();
      if (!restored.ok) {
        this.reportFailure(restored.error, '恢复上次工作区失败');
        this.showWelcome();
        return;
      }
      const workspace = restored.value.workspace;
      if (restored.value.cancelled || workspace === null) {
        this.showWelcome();
        return;
      }
      await this.enterWorkspace(workspace, true);
    } catch (error) {
      this.setStatus(`启动失败：${toMessage(error)}`, 'error');
      this.showWelcome();
    }
  }

  // -- workspace lifecycle --------------------------------------------------

  private showWelcome(): void {
    this.app.classList.remove('has-workspace');
    this.welcome.hidden = false;
    this.workspaceName.hidden = true;
    this.setStatus('');
    this.updateActionState();
    this.updateStatusBar();
  }

  private async openWorkspace(): Promise<void> {
    this.openButton.disabled = true;
    this.welcomeOpen.disabled = true;
    this.setStatus('正在等待文件夹选择…');
    try {
      const response = await this.api.workspace.open();
      if (!response.ok) {
        this.reportFailure(response.error, '打开工作区失败');
        return;
      }
      if (response.value.cancelled || response.value.workspace === null) {
        this.setStatus('已取消选择。');
        return;
      }
      await this.enterWorkspace(response.value.workspace, false);
    } catch (error) {
      this.setStatus(`IPC 调用失败：${toMessage(error)}`, 'error');
    } finally {
      this.openButton.disabled = false;
      this.welcomeOpen.disabled = false;
    }
  }

  private async enterWorkspace(workspace: WorkspaceSummary, restore: boolean): Promise<void> {
    if (this.workspace !== null && !sameRoot(this.workspace.rootPath, workspace.rootPath)) {
      this.closeAllDocuments();
    }

    this.workspace = workspace;
    this.app.classList.add('has-workspace');
    this.welcome.hidden = true;
    this.workspaceName.hidden = false;
    this.workspaceName.textContent = workspace.name;
    this.workspaceName.title = workspace.rootPath;

    const loaded = await this.api.state.load();
    let state: WorkspaceUiState;
    if (loaded.ok) {
      state = stateForWorkspace(loaded.value, workspace);
    } else {
      this.reportFailure(loaded.error, '读取界面状态失败');
      state = createDefaultWorkspaceUiState(workspace.rootPath);
    }

    this.theme = cloneTheme(state.theme);
    this.layout = normalizeLayout(state.layout);
    this.themePanel.setTheme(this.theme);
    this.themePanel.setLayout(this.layout);
    this.applyThemeMode();
    this.applyWallpaper();
    void this.preview.setTheme(this.theme);
    void this.preview.setLayout(this.layout);
    this.applyLayoutClasses();

    await this.refreshTree();

    if (restore && state.openDocuments.length > 0) {
      await this.restoreDocuments(state);
    } else if (this.editorTabs.length === 0) {
      this.setStatus('工作区已打开。从左侧选择一个文件，或新建笔记。');
    }

    this.updateActionState();
    this.updateStatusBar();
    this.scheduleStateSave();
  }

  private async restoreDocuments(state: WorkspaceUiState): Promise<void> {
    let opened = 0;
    let failed = 0;
    for (const path of state.openDocuments) {
      if (!isMarkdownPath(path)) continue;
      const view = state.documentViews[path] ?? null;
      const ok = await this.openDocumentPath(path, { activate: false, view, quiet: true });
      if (ok) opened += 1;
      else failed += 1;
    }

    const active = state.activeDocument;
    if (active !== null && this.docIds.has(active)) {
      await this.activateDocument(active);
    } else if (this.editorTabs.length > 0) {
      const first = this.editorTabs[0];
      if (first) await this.activateDocument(first.path);
    }

    if (opened === 0) this.setStatus('未能恢复上次打开的文档。');
    else if (failed > 0) {
      this.setStatus(`有 ${failed} 个文档未能恢复（文件可能已被删除）。`, 'error');
    }
  }

  private async refreshTree(): Promise<void> {
    if (this.workspace === null) return;
    const result = await this.api.workspace.getTree({ path: '', depth: 4 });
    if (!result.ok) {
      this.reportFailure(result.error, '读取工作区目录失败');
      return;
    }
    this.renderTree(result.value.nodes);
    this.treeEmpty.hidden = countFiles(result.value.nodes) > 0;
    if (result.value.truncated) this.setStatus('目录内容过多，文件树已截断显示。');
  }

  private renderTree(nodes: WorkspaceNode[]): void {
    this.fileTree.replaceChildren(...this.buildTreeItems(nodes));
  }

  private buildTreeItems(nodes: readonly WorkspaceNode[]): HTMLLIElement[] {
    return nodes.map((node) => this.buildTreeItem(node));
  }

  private buildTreeItem(node: WorkspaceNode): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'tree-node';

    if (node.kind === 'directory') {
      const details = document.createElement('details');
      details.open = node.path.split('/').length <= 1;
      const summary = document.createElement('summary');
      summary.textContent = node.name;
      summary.title = node.path;
      details.append(summary);
      if (node.children && node.children.length > 0) {
        const list = document.createElement('ul');
        list.append(...this.buildTreeItems(node.children));
        details.append(list);
      }
      item.append(details);
      return item;
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tree-file';
    button.dataset.path = node.path;
    button.dataset.kind = isHtmlPath(node.path) ? 'html' : 'markdown';
    button.textContent = node.name;
    button.title = node.path;
    button.setAttribute('aria-current', String(this.uiActivePath === node.path));
    button.addEventListener('click', () => {
      void this.activateDocument(node.path);
    });
    item.append(button);
    return item;
  }

  private scheduleTreeRefresh(): void {
    if (this.treeTimer !== null) clearTimeout(this.treeTimer);
    this.treeTimer = setTimeout(() => {
      this.treeTimer = null;
      void this.refreshTree();
    }, TREE_DEBOUNCE_MS);
  }

  private closeAllDocuments(): void {
    for (const tab of [...this.editorTabs]) this.editor.close(tab.id);
    this.docIds.clear();
    this.shellViewModes.clear();
    this.tabSignals.clear();
    this.editorTabs = [];
    this.activeTabId = null;
    this.uiActivePath = null;
    this.htmlDocumentPath = null;
    this.previewPath = null;
    this.renderDocumentTabs();
  }

  // -- documents ------------------------------------------------------------

  private markdownActivePath(): string | null {
    if (this.htmlDocumentPath !== null) return null;
    const path = this.uiActivePath;
    return path !== null && isMarkdownPath(path) ? path : null;
  }

  private activeTab(): EditorTabInfo | null {
    return this.editorTabs.find((tab) => tab.id === this.activeTabId) ?? null;
  }

  private async activateDocument(path: string): Promise<void> {
    if (isHtmlPath(path)) {
      await this.openHtmlDocument(path);
      return;
    }
    if (!isMarkdownPath(path)) {
      this.setStatus('只支持打开 Markdown 与 HTML 文件。', 'error');
      return;
    }
    if (!this.docIds.has(path)) {
      const opened = await this.openDocumentPath(path, { activate: false });
      if (!opened) return;
    }
    await this.setActivePath(path, { fromHost: false });
  }

  private async openDocumentPath(
    path: string,
    options: { activate?: boolean; view?: DocumentViewState | null; quiet?: boolean } = {},
  ): Promise<boolean> {
    if (isHtmlPath(path)) {
      if (options.activate !== false) await this.openHtmlDocument(path);
      return true;
    }
    if (!isMarkdownPath(path)) {
      this.setStatus(`不支持的文件类型：${path}`, 'error');
      return false;
    }

    const existing = this.docIds.get(path);
    if (existing !== undefined && this.editor.getTabs().some((tab) => tab.id === existing)) {
      if (options.activate !== false) await this.activateDocument(path);
      return true;
    }

    const result = await this.api.documents.read({ path });
    if (!result.ok) {
      if (!options.quiet) this.reportFailure(result.error, `无法打开 ${path}`);
      return false;
    }

    const content = result.value;
    const id = existing ?? `doc-${(this.idCounter += 1)}`;
    this.docIds.set(path, id);

    const view = options.view ?? null;
    if (view) this.shellViewModes.set(path, shellViewModeOf(view.viewMode));

    this.editor.open(
      {
        id,
        path,
        markdown: content.markdown,
        baseHash: content.hash,
        diskHash: content.hash,
        mtimeMs: content.mtimeMs,
        selection: view?.selection ?? null,
        scrollTop: view?.scrollTop ?? 0,
        viewMode: view?.viewMode ?? 'edit',
      },
      { activate: options.activate ?? true },
    );
    return true;
  }

  private async setActivePath(path: string | null, options: { fromHost: boolean }): Promise<void> {
    const token = (this.activeToken += 1);
    const hadHtmlDocument = this.htmlDocumentPath !== null;
    const unchanged = path === this.uiActivePath && !hadHtmlDocument;
    this.uiActivePath = path;
    this.htmlDocumentPath = null;

    if (path === null) {
      this.previewPath = null;
      await this.preview.setDocument(null);
      if (token !== this.activeToken) return;
      this.renderOutline([]);
      await this.backlinks.setActiveNote(null);
      if (token !== this.activeToken) return;
      void this.graph.setFocus(null);
      this.renderDocumentTabs();
      this.updateActionState();
      this.updateStatusBar();
      this.scheduleStateSave();
      return;
    }

    if (!options.fromHost) {
      const id = this.docIds.get(path);
      if (id !== undefined) this.editor.activate(id);
    }

    if (!unchanged) await this.runPreview();
    if (token !== this.activeToken) return;

    const storedMode = this.shellViewModes.get(path);
    if (storedMode !== undefined && this.mainArea.dataset.view !== 'graph') {
      this.applyViewMode(storedMode);
    }

    void this.backlinks.setActiveNote(path);
    void this.graph.setFocus(path);
    this.renderDocumentTabs();
    this.updateActionState();
    this.updateStatusBar();
    this.scheduleStateSave();
  }

  private async openHtmlDocument(path: string): Promise<void> {
    // Let an in-flight Markdown render finish so it cannot repaint the frame
    // after the HTML file is shown.
    await this.previewTask;
    this.activeToken += 1;

    const result = await this.api.documents.read({ path });
    if (!result.ok) {
      this.reportFailure(result.error, `无法打开 ${path}`);
      return;
    }

    this.htmlDocumentPath = path;
    this.uiActivePath = path;
    this.previewPath = null;
    this.preview.openHtmlFile({ path, html: result.value.markdown });
    this.renderOutline([]);
    this.renderDocumentTabs();
    this.updateActionState();
    this.updateStatusBar();
    await this.backlinks.setActiveNote(null);
    void this.graph.setFocus(null);
    this.scheduleStateSave();
    this.setStatus(`已打开 HTML 文件：${path}（只读预览，不能导出为 Markdown）`);
  }

  private async closeHtmlTab(): Promise<void> {
    this.htmlDocumentPath = null;
    this.previewPath = null;
    const next =
      this.editorTabs.find((tab) => tab.id === this.activeTabId) ?? this.editorTabs[0] ?? null;
    await this.setActivePath(next ? next.path : null, { fromHost: true });
  }

  private async closeDocument(path: string): Promise<void> {
    const tab = this.editorTabs.find((entry) => entry.path === path);
    if (!tab) {
      if (this.htmlDocumentPath === path) await this.closeHtmlTab();
      return;
    }

    if (tab.dirty) {
      const choice = await openDialog({
        title: '关闭标签',
        message: `「${tab.title}」有未保存的修改。`,
        buttons: [
          { label: '保存并关闭', value: 'save', primary: true },
          { label: '另存为…', value: 'copy' },
          { label: '取消', value: 'cancel' },
        ],
      });
      if (choice === null || choice.kind !== 'button' || choice.value === 'cancel') return;

      if (choice.value === 'save') {
        const outcome = await this.editor.save(tab.id);
        if (outcome.status !== 'saved') {
          this.reportSaveOutcome(outcome);
          return;
        }
      } else {
        const target = await this.promptCopyTarget(path);
        if (target === null) return;
        const copy = await this.editor.saveCopy(tab.id, target);
        if (!copy.ok) {
          this.reportFailure(copy.error, '另存失败');
          return;
        }
        this.setStatus(`已另存为 ${copy.value.path}`);
        await this.refreshTree();
      }
    }

    this.docIds.delete(path);
    this.shellViewModes.delete(path);
    this.tabSignals.delete(tab.id);
    if (this.previewPath === path) this.previewPath = null;
    this.editor.close(tab.id);
    this.scheduleStateSave();
  }

  private async promptCopyTarget(fromPath: string): Promise<string | null> {
    const outcome = await openDialog({
      title: '另存为',
      message: '输入工作区内的新路径；目标文件必须尚不存在。',
      fields: [
        { key: 'directory', label: '目录（留空为根目录）', value: workspaceDirname(fromPath) },
        { key: 'fileName', label: '文件名', value: `${workspaceStem(fromPath)}-副本.md` },
      ],
      confirmLabel: '另存',
    });
    if (outcome === null || outcome.kind !== 'submit') return null;
    const target = composeWorkspacePath(
      outcome.values.directory ?? '',
      outcome.values.fileName ?? '',
    );
    if (target === null) {
      this.setStatus('路径无效：文件名必须以 .md 或 .markdown 结尾。', 'error');
      return null;
    }
    if (this.docIds.has(target)) {
      this.setStatus('该路径已经是打开的文档。', 'error');
      return null;
    }
    return target;
  }

  private async createDocument(): Promise<void> {
    if (this.workspace === null) return;
    const outcome = await openDialog({
      title: '新建笔记',
      message: '填写工作区内的目录与文件名；文件名必须以 .md 或 .markdown 结尾。',
      fields: [
        { key: 'directory', label: '目录（留空为根目录）', value: '' },
        { key: 'fileName', label: '文件名', value: '未命名.md' },
      ],
      confirmLabel: '创建',
    });
    if (outcome === null || outcome.kind !== 'submit') return;

    const target = composeWorkspacePath(
      outcome.values.directory ?? '',
      outcome.values.fileName ?? '',
    );
    if (target === null) {
      this.setStatus('文件名必须以 .md 或 .markdown 结尾。', 'error');
      return;
    }

    const result = await this.api.documents.create({
      directory: workspaceDirname(target),
      fileName: workspaceBasename(target),
    });
    if (!result.ok) {
      this.reportFailure(result.error, '新建笔记失败');
      return;
    }

    await this.refreshTree();
    await this.openDocumentPath(result.value.path, { activate: true });
    this.links.invalidate();
    void this.refreshGraph();
    this.setStatus(`已创建 ${result.value.path}`);
  }

  private async renameActiveDocument(): Promise<void> {
    const tab = this.activeTab();
    if (tab === null || this.htmlDocumentPath !== null) {
      this.setStatus('请先打开一篇 Markdown 文档。', 'error');
      return;
    }
    if (tab.dirty) {
      this.setStatus('请先保存当前文档再重命名。', 'error');
      return;
    }

    const outcome = await openDialog({
      title: '重命名笔记',
      message: '默认同时更新能唯一解析的 [[双链]] 引用。',
      fields: [
        { key: 'directory', label: '目录', value: workspaceDirname(tab.path) },
        { key: 'fileName', label: '新文件名', value: workspaceBasename(tab.path) },
      ],
      confirmLabel: '重命名',
    });
    if (outcome === null || outcome.kind !== 'submit') return;

    const target = composeWorkspacePath(
      outcome.values.directory ?? '',
      outcome.values.fileName ?? '',
    );
    if (target === null) {
      this.setStatus('文件名必须以 .md 或 .markdown 结尾。', 'error');
      return;
    }
    if (target === tab.path) {
      this.setStatus('路径没有变化。');
      return;
    }

    const result = await this.api.documents.rename({
      documentId: tab.id,
      fromPath: tab.path,
      toPath: target,
      updateReferences: true,
    });
    if (!result.ok) {
      this.reportFailure(result.error, '重命名失败');
      return;
    }

    await this.afterRename(tab, result.value);
  }

  private async afterRename(tab: EditorTabInfo, result: RenameDocumentResult): Promise<void> {
    const state = this.editor.getDocumentState(tab.id);
    const selection = state?.selection ?? null;
    const scrollTop = state?.scrollTop ?? 0;
    const mode = this.shellViewModes.get(tab.path) ?? this.viewMode;

    this.docIds.delete(tab.path);
    this.shellViewModes.delete(tab.path);
    this.tabSignals.delete(tab.id);
    if (this.previewPath === tab.path) this.previewPath = null;
    if (this.uiActivePath === tab.path) this.uiActivePath = null;
    this.editor.close(tab.id);

    await this.openDocumentPath(result.path, {
      activate: true,
      view: { selection, scrollTop, viewMode: persistedViewMode(mode) },
    });
    await this.refreshTree();
    this.links.invalidate();
    void this.refreshBacklinks();
    void this.refreshGraph();
    this.scheduleStateSave();
    this.setStatus(describeRename(result));
  }

  // -- editor/preview synchronisation --------------------------------------

  private handleEditorState(tabs: EditorTabInfo[], activeId: string | null): void {
    this.editorTabs = tabs;
    this.activeTabId = activeId;
    this.renderDocumentTabs();
    this.detectSaveCompletion(tabs);
    this.updateActionState();
    this.updateStatusBar();

    const activePath = tabs.find((tab) => tab.id === activeId)?.path ?? null;
    if (this.htmlDocumentPath === null && activePath !== this.uiActivePath) {
      void this.setActivePath(activePath, { fromHost: true });
    }
    if (this.htmlDocumentPath === null && activePath !== null) {
      this.schedulePreview();
      this.refreshWikilinkCompletion();
    }
  }

  private schedulePreview(): void {
    if (this.previewTimer !== null) clearTimeout(this.previewTimer);
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      void this.runPreview();
    }, PREVIEW_DEBOUNCE_MS);
  }

  /** Runs one preview render and remembers it so callers can await it. */
  private runPreview(): Promise<void> {
    const task = this.showPreviewNow();
    this.previewTask = task.catch(() => undefined);
    return task;
  }

  private async showPreviewNow(): Promise<void> {
    if (this.previewTimer !== null) {
      clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    if (this.htmlDocumentPath !== null) return;

    const path = this.uiActivePath;
    if (path === null || !isMarkdownPath(path)) {
      this.previewPath = null;
      this.lastRenderedMarkdown = null;
      await this.preview.setDocument(null);
      this.renderOutline([]);
      return;
    }

    const markdown = this.editor.getActiveMarkdown() ?? '';
    this.previewContext.documentPath = path;

    if (
      this.previewPath === path &&
      this.lastRenderedMarkdown === markdown &&
      this.preview.getState().kind === 'markdown' &&
      this.preview.getResult() !== null
    ) {
      return;
    }

    if (this.previewPath === path && this.preview.getState().kind === 'markdown') {
      const result = await this.preview.setMarkdown(markdown);
      if (result) {
        this.lastRenderedMarkdown = markdown;
        this.applyRenderResult(result);
      }
      return;
    }

    this.previewPath = path;
    const result = await this.preview.setDocument({ path, markdown, title: null });
    if (result) {
      this.lastRenderedMarkdown = markdown;
      this.applyRenderResult(result);
    }
  }

  private applyRenderResult(result: RenderResult): void {
    this.renderOutline(result.outline);
  }

  private handleRendered(result: RenderResult): void {
    this.renderOutline(result.outline);
  }

  private handlePreviewState(state: HtmlWorkspaceState): void {
    this.lastPreviewState = state;
    this.statusExport.textContent =
      state.kind === 'html-file' ? 'HTML 预览（不可导出）' : state.exportLabel;
    this.statusExport.title = state.dependencies
      ? describeDependencySummary(state.dependencies)
      : '';
    this.updateActionState();
  }

  private handleExportCompleted(result: ExportHtmlResult): void {
    this.setStatus(
      `已导出 ${result.writtenPath}（${formatBytes(result.bytes)}；${describeDependencySummary(
        result.dependencies,
      )}）`,
    );
  }

  private renderOutline(entries: readonly OutlineEntry[]): void {
    this.outlineList.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'outline-empty';
      empty.textContent = '当前笔记没有标题。';
      this.outlineList.append(empty);
      return;
    }

    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'outline-entry';
      button.dataset.depth = String(entry.depth);
      button.textContent = entry.text.length > 0 ? entry.text : '（无标题）';
      button.title = entry.text;
      button.addEventListener('click', () => this.scrollPreviewTo(entry.id));
      this.outlineList.append(button);
    }
  }

  private previewDocument(): Document | null {
    const frame = this.preview.element.querySelector<HTMLIFrameElement>('iframe');
    return frame?.contentDocument ?? null;
  }

  private scrollPreviewTo(id: string): void {
    const target = this.previewDocument()?.getElementById(id);
    target?.scrollIntoView({ block: 'start' });
  }

  private installPreviewBindings(): void {
    const frame = this.preview.element.querySelector<HTMLIFrameElement>('iframe');
    frame?.addEventListener('load', () => {
      this.decoratePreview();
    });
    // Container-level delegation covers wiki links rendered outside the frame.
    this.links.wikiLinks.attach(this.previewHost);
  }

  private decoratePreview(): void {
    const doc = this.previewDocument();
    if (!doc || !doc.body) return;
    applyWikilinkTargets(doc);
    void this.links.wikiLinks.decorate(doc.body);
    if (this.decoratedDocuments.has(doc)) return;
    this.decoratedDocuments.add(doc);
    doc.addEventListener('click', (event) => this.handlePreviewClick(event));
  }

  private handlePreviewClick(event: Event): void {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') return;

    const wiki = target.closest('[data-wikilink-target]');
    if (wiki) {
      event.preventDefault();
      const value = wiki.getAttribute('data-wikilink-target') ?? '';
      if (value.trim().length > 0) void this.links.wikiLinks.activate(value);
      return;
    }
    // Sandboxed previews must not navigate away; in-page anchors still work.
    const anchor = target.closest('a');
    if (anchor && !(anchor.getAttribute('href') ?? '').startsWith('#')) event.preventDefault();
  }

  private installWikilinkKeyHandler(): void {
    document.addEventListener(
      'keydown',
      (event) => {
        const target = event.target;
        if (!(target instanceof Node) || !this.editor.view.dom.contains(target)) return;
        if (
          (event as Event & { isComposing?: boolean }).isComposing === true ||
          this.editor.view.composing
        ) {
          return;
        }
        if (this.links.wikiLinks.handleKeyDown(event)) {
          event.preventDefault();
          event.stopPropagation();
        }
      },
      true,
    );
  }

  private refreshWikilinkCompletion(): void {
    const pane = this.mainArea.dataset.view;
    if (pane === 'preview' || pane === 'graph') {
      this.links.wikiLinks.close();
      return;
    }
    const view = this.editor.view;
    if (view.composing) return;
    const selection = view.state.selection.main;
    let anchor: { left: number; top: number } | undefined;
    try {
      const coords = view.coordsAtPos(selection.head);
      if (coords) anchor = { left: coords.left, top: coords.bottom + 4 };
    } catch {
      anchor = undefined;
    }
    void this.links.wikiLinks.query({
      text: view.state.doc.toString(),
      caret: selection.head,
      anchor,
    });
  }

  // -- status, saves and persistence ---------------------------------------

  private detectSaveCompletion(tabs: readonly EditorTabInfo[]): void {
    for (const tab of tabs) {
      const previous = this.tabSignals.get(tab.id);
      if (previous?.saving && !tab.saving && !tab.dirty && !tab.conflict && !tab.missing) {
        this.onDocumentSaved(tab.path);
      }
      this.tabSignals.set(tab.id, { saving: tab.saving, dirty: tab.dirty });
    }
  }

  private onDocumentSaved(path: string): void {
    this.scheduleStateSave();
    this.links.invalidate();
    void this.refreshBacklinks();
    void this.refreshGraph();
    this.setStatus(`已保存 ${path}`);
  }

  private async refreshBacklinks(): Promise<void> {
    await this.backlinks.setActiveNote(this.markdownActivePath());
  }

  private async refreshGraph(): Promise<void> {
    await this.graph.setFocus(this.markdownActivePath());
  }

  private reportSaveOutcome(outcome: EditorSaveOutcome): void {
    if (outcome.status === 'failed') {
      this.reportFailure(outcome.failure, 'save');
      return;
    }
    if (outcome.status === 'blocked') {
      this.setStatus(
        outcome.reason === 'conflict'
          ? '磁盘内容已改变，保存被阻止；请重新加载或另存。'
          : '文件缺失或尚未就绪，保存被阻止。',
        'error',
      );
      return;
    }
    if (outcome.status === 'skipped') this.setStatus('没有需要保存的修改。');
  }

  private scheduleStateSave(): void {
    if (this.stateTimer !== null) clearTimeout(this.stateTimer);
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      void this.persistState();
    }, STATE_DEBOUNCE_MS);
  }

  private collectState(): WorkspaceUiState {
    const tabs = this.editor.getTabs();
    const documentViews: Record<string, DocumentViewState> = {};
    for (const tab of tabs) {
      const state = this.editor.getDocumentState(tab.id);
      documentViews[tab.path] = {
        selection: state?.selection ?? null,
        scrollTop: state?.scrollTop ?? 0,
        viewMode: persistedViewMode(this.shellViewModes.get(tab.path) ?? this.viewMode),
      };
    }
    return {
      version: WORKSPACE_STATE_VERSION,
      workspaceRootPath: this.workspace?.rootPath ?? null,
      openDocuments: tabs.map((tab) => tab.path),
      activeDocument: this.markdownActivePath(),
      documentViews,
      theme: this.theme,
      layout: this.layout,
      updatedAt: new Date().toISOString(),
    };
  }

  private async persistState(): Promise<void> {
    if (this.workspace === null) return;
    try {
      const result = await this.api.state.save(this.collectState());
      if (!result.ok) this.reportFailure(result.error, '保存界面状态失败');
    } catch (error) {
      this.setStatus(`保存界面状态失败：${toMessage(error)}`, 'error');
    }
  }

  private async handleExternalChange(change: DocumentChangeEvent): Promise<void> {
    await this.editor.applyExternalChange(change);
    this.links.invalidate();
    void this.refreshBacklinks();
    void this.refreshGraph();
    this.scheduleTreeRefresh();
    this.updateStatusBar();
    if (change.kind === 'deleted') this.setStatus(`文件已从磁盘删除：${change.path}`, 'error');
    else this.setStatus(`检测到外部修改：${change.path}`);
  }

  private async reloadAfterConflict(): Promise<void> {
    const id = this.activeTabId;
    if (id === null) return;
    const tab = this.editorTabs.find((entry) => entry.id === id);
    if (tab?.dirty) {
      const confirmed = await openDialog({
        title: '重新加载',
        message: `重新加载会丢弃「${tab.title}」中未保存的修改。`,
        buttons: [
          { label: '重新加载', value: 'reload', primary: true },
          { label: '取消', value: 'cancel' },
        ],
      });
      if (confirmed === null || confirmed.kind !== 'button' || confirmed.value !== 'reload') {
        return;
      }
    }

    const result = await this.editor.reload(id);
    if (result === null) return;
    if (!result.ok) {
      this.reportFailure(result.error, 'reload');
      return;
    }
    this.links.invalidate();
    void this.refreshBacklinks();
    void this.refreshGraph();
    this.setStatus('已从磁盘重新加载。');
  }

  private setStatus(message: string, kind: 'info' | 'error' = 'info'): void {
    this.statusMessage.textContent = message;
    this.statusMessage.dataset.kind = kind;
    this.statusMessage.title = kind === 'error' ? message : '';
  }

  private reportFailure(failure: IpcFailure, context: string): void {
    this.setStatus(`${describeContext(context)}：${describeFailure(failure)}`, 'error');
  }

  private renderInfo(info: AppInfo): void {
    this.envBadge.textContent = info.environment === 'development' ? '开发' : '生产';
    this.versionBadge.textContent = `v${info.version}`;
    this.statusMeta.textContent = `${info.platform}/${info.arch} · Electron ${info.electron}`;
    this.statusMeta.title = `运行数据目录：${info.runtimeDataDir}`;
  }

  private updateStatusBar(): void {
    const tab = this.activeTab();
    if (this.htmlDocumentPath !== null) {
      this.statusDocument.textContent = `${workspaceBasename(this.htmlDocumentPath)} · HTML 只读预览`;
    } else if (tab !== null) {
      this.statusDocument.textContent = `${tab.title} · ${tabStateLabel(tab)}`;
    } else {
      this.statusDocument.textContent = this.workspace ? '未打开文档' : '未打开工作区';
    }

    if (this.lastPreviewState === null) {
      this.statusExport.textContent = '未导出';
      this.statusExport.title = '';
    }

    const conflicted = tab?.conflict === true || tab?.missing === true;
    this.statusAction.hidden = !conflicted;
    if (conflicted) {
      this.statusAction.textContent = tab?.missing ? '文件缺失：重新加载' : '磁盘已变更：重新加载';
    }
  }

  private updateActionState(): void {
    const hasWorkspace = this.workspace !== null;
    const markdownActive = this.markdownActivePath() !== null;

    this.newNoteButton.disabled = !hasWorkspace;
    this.findButton.disabled = !markdownActive;
    this.renameButton.disabled = !markdownActive;
    this.exportButton.disabled = !markdownActive || this.lastPreviewState?.exporting === true;
    this.graphButton.disabled = !hasWorkspace;
    this.themeButton.disabled = !hasWorkspace;
    this.openButton.disabled = false;
  }

  private renderDocumentTabs(): void {
    const signature = [
      this.uiActivePath ?? '',
      this.htmlDocumentPath ?? '',
      ...this.editorTabs.map((tab) => `${tab.id}:${tab.path}:${tabState(tab)}`),
    ].join('|');
    if (signature === this.tabsSignature) return;
    this.tabsSignature = signature;

    const items: HTMLLIElement[] = [];

    for (const tab of this.editorTabs) {
      const item = document.createElement('li');
      item.className = 'doc-tab';
      item.dataset.active = String(this.uiActivePath === tab.path && this.htmlDocumentPath === null);
      item.dataset.state = tabState(tab);

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'doc-tab-main';
      main.title = tab.path;

      const dot = document.createElement('span');
      dot.className = 'doc-tab-state';
      const title = document.createElement('span');
      title.className = 'doc-tab-title';
      title.textContent = tab.title;
      main.append(dot, title);
      main.addEventListener('click', () => {
        void this.activateDocument(tab.path);
      });

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'doc-tab-close';
      close.textContent = '×';
      close.title = '关闭标签';
      close.setAttribute('aria-label', `关闭 ${tab.title}`);
      close.addEventListener('click', () => {
        void this.closeDocument(tab.path);
      });

      item.append(main, close);
      items.push(item);
    }

    if (this.htmlDocumentPath !== null) {
      const path = this.htmlDocumentPath;
      const item = document.createElement('li');
      item.className = 'doc-tab';
      item.dataset.active = 'true';
      item.dataset.state = 'clean';

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'doc-tab-main';
      main.title = path;
      const dot = document.createElement('span');
      dot.className = 'doc-tab-state';
      const title = document.createElement('span');
      title.className = 'doc-tab-title';
      title.textContent = workspaceBasename(path);
      main.append(dot, title);
      main.addEventListener('click', () => {
        void this.openHtmlDocument(path);
      });

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'doc-tab-close';
      close.textContent = '×';
      close.title = '关闭标签';
      close.setAttribute('aria-label', `关闭 ${workspaceBasename(path)}`);
      close.addEventListener('click', () => {
        void this.closeHtmlTab();
      });

      item.append(main, close);
      items.push(item);
    }

    this.documentTabs.replaceChildren(...items);
  }

  // -- view, layout and theme ----------------------------------------------

  private applyViewMode(mode: ShellViewMode): void {
    this.viewMode = mode;
    this.mainArea.dataset.view = mode;
    this.viewEditButton.setAttribute('aria-pressed', String(mode === 'edit'));
    this.viewSplitButton.setAttribute('aria-pressed', String(mode === 'split'));
    this.viewPreviewButton.setAttribute('aria-pressed', String(mode === 'preview'));
    this.graphButton.setAttribute('aria-pressed', 'false');
  }

  private setViewMode(mode: ShellViewMode): void {
    this.applyViewMode(mode);
    if (mode !== 'edit' && mode !== 'split') this.links.wikiLinks.close();
    const path = this.markdownActivePath();
    if (path !== null) this.shellViewModes.set(path, mode);
    this.scheduleStateSave();
  }

  private toggleGraphView(): void {
    const showingGraph = this.mainArea.dataset.view === 'graph';
    if (showingGraph) {
      this.applyViewMode(this.viewMode);
      return;
    }
    this.mainArea.dataset.view = 'graph';
    this.graphButton.setAttribute('aria-pressed', 'true');
    void this.graph.setFocus(this.markdownActivePath());
  }

  private toggleThemePanel(): void {
    const show = this.themePanelHost.hidden;
    this.themePanelHost.hidden = !show;
    this.themeButton.setAttribute('aria-pressed', String(show));
  }

  private toggleAutoSave(): void {
    this.autoSaveEnabled = !this.autoSaveEnabled;
    this.editor.setAutoSaveEnabled(this.autoSaveEnabled);
    this.autoSaveButton.textContent = `自动保存：${this.autoSaveEnabled ? '开' : '关'}`;
    this.autoSaveButton.setAttribute('aria-pressed', String(this.autoSaveEnabled));
    this.setStatus(
      this.autoSaveEnabled ? '已开启自动保存。' : '已关闭自动保存；Ctrl+S 仍可手动保存。',
    );
  }

  private showSidebarPanel(panel: 'files' | 'open'): void {
    const files = panel === 'files';
    this.treePanel.hidden = !files;
    this.tabsPanel.hidden = files;
    this.tabFiles.setAttribute('aria-selected', String(files));
    this.tabOpen.setAttribute('aria-selected', String(!files));
  }

  private applyThemeLayout(
    theme: ThemeConfig,
    layout: LayoutConfig,
    changed: 'theme' | 'layout' | null,
  ): void {
    this.theme = cloneTheme(theme);
    this.layout = normalizeLayout(layout);

    if (changed === 'theme') void this.preview.setTheme(this.theme);
    else if (changed === 'layout') void this.preview.setLayout(this.layout);
    else {
      void this.preview.setTheme(this.theme);
      void this.preview.setLayout(this.layout);
    }

    this.applyLayoutClasses();
    this.applyThemeMode();
    this.applyWallpaper();
    this.themePanel.setTheme(this.theme);
    this.themePanel.setLayout(this.layout);
    this.scheduleStateSave();
  }

  /**
   * Applies the light/dark/system choice to the whole window, not just the
   * preview frame: `data-theme` selects the variable block in `styles.css` and
   * `color-scheme` switches native controls with it.
   */
  private applyThemeMode(): void {
    const mode = this.theme.mode;
    this.app.dataset.theme = mode;
    document.documentElement.dataset.theme = mode;
    const colorScheme = mode === 'dark' ? 'dark' : mode === 'light' ? 'light' : 'light dark';
    this.app.style.colorScheme = colorScheme;
    document.documentElement.style.colorScheme = colorScheme;
  }

  /** Publishes the wallpaper layer variables consumed by `.app::before`. */
  private applyWallpaper(): void {
    const wallpaper = this.theme.wallpaper ?? DEFAULT_WALLPAPER;
    const hasWallpaper = wallpaper.dataUri !== null;
    const style = this.app.style;
    style.setProperty('--wallpaper-image', hasWallpaper ? `url("${wallpaper.dataUri}")` : 'none');
    style.setProperty('--wallpaper-opacity', String(wallpaper.opacity));
    style.setProperty('--wallpaper-blur', `${wallpaper.blurPx}px`);
    style.setProperty('--wallpaper-size', wallpaper.size === 'repeat' ? 'auto' : wallpaper.size);
    style.setProperty('--wallpaper-position', wallpaper.position);
    style.setProperty('--wallpaper-repeat', wallpaper.size === 'repeat' ? 'repeat' : 'no-repeat');
    this.app.classList.toggle('has-wallpaper', hasWallpaper);
  }

  private async chooseWallpaper(): Promise<string | null> {
    try {
      const result = await this.api.background.choose();
      if (!result.ok) {
        this.reportFailure(result.error, '选择壁纸失败');
        return null;
      }
      if (result.value.cancelled || result.value.wallpaper === null) {
        this.setStatus('已取消选择壁纸。');
        return null;
      }
      this.setStatus(`壁纸已更新（${formatBytes(result.value.wallpaper.bytes)}）`);
      return result.value.wallpaper.dataUri;
    } catch (error) {
      this.setStatus(`选择壁纸失败：${toMessage(error)}`, 'error');
      return null;
    }
  }

  private applyLayoutClasses(): void {
    const layout = normalizeLayout(this.layout);
    this.app.classList.toggle('layout-sidebar-hidden', !layout.sidebar.visible);
    this.app.classList.toggle('layout-sidebar-right', layout.sidebar.position === 'right');
    this.app.classList.toggle('layout-outline-hidden', !layout.outline.visible);
    const outlineOnLeft = layout.outline.position === 'left' && layout.sidebar.visible;
    this.app.classList.toggle('layout-outline-left', outlineOnLeft);
    this.app.style.setProperty('--sidebar-width', `${layout.sidebar.widthPx}px`);

    const target = outlineOnLeft ? this.outlineLeftHost : this.outlineRightHost;
    if (this.outlineSection.parentElement !== target) target.append(this.outlineSection);
  }

  private async exportHtml(): Promise<void> {
    if (this.markdownActivePath() === null) {
      this.setStatus('请先打开一篇 Markdown 文档。', 'error');
      return;
    }
    this.exportButton.disabled = true;
    try {
      // Flush a debounced preview first so the export never lags the buffer.
      await this.runPreview();
      const outcome = await this.preview.exportHtml();
      if (outcome.status === 'cancelled') this.setStatus('已取消导出。');
      else if (outcome.status === 'failed') this.reportFailure(outcome.error, '导出失败');
    } finally {
      this.updateActionState();
    }
  }

  private bindEvents(): void {
    this.openButton.addEventListener('click', () => {
      void this.openWorkspace();
    });
    this.welcomeOpen.addEventListener('click', () => {
      void this.openWorkspace();
    });
    this.newNoteButton.addEventListener('click', () => {
      void this.createDocument();
    });
    this.renameButton.addEventListener('click', () => {
      void this.renameActiveDocument();
    });
    this.findButton.addEventListener('click', () => {
      this.editor.openSearch();
    });
    this.autoSaveButton.addEventListener('click', () => this.toggleAutoSave());
    this.graphButton.addEventListener('click', () => this.toggleGraphView());
    this.themeButton.addEventListener('click', () => this.toggleThemePanel());
    this.exportButton.addEventListener('click', () => {
      void this.exportHtml();
    });
    this.tabFiles.addEventListener('click', () => this.showSidebarPanel('files'));
    this.tabOpen.addEventListener('click', () => this.showSidebarPanel('open'));
    this.viewEditButton.addEventListener('click', () => this.setViewMode('edit'));
    this.viewSplitButton.addEventListener('click', () => this.setViewMode('split'));
    this.viewPreviewButton.addEventListener('click', () => this.setViewMode('preview'));
    this.statusAction.addEventListener('click', () => {
      void this.reloadAfterConflict();
    });
    this.api.documents.onExternalChange((change) => {
      void this.handleExternalChange(change);
    });
    window.addEventListener('beforeunload', () => {
      void this.persistState();
    });
  }
}

function bootstrap(): void {
  if (!window.markdownLite) {
    const message = document.getElementById('status-message');
    if (message) {
      message.textContent = '预加载脚本未提供 window.markdownLite，界面无法调用主进程。';
      message.dataset.kind = 'error';
    }
    return;
  }
  try {
    const shell = new MarkdownLiteShell();
    void shell.start();
  } catch (error) {
    const message = document.getElementById('status-message');
    if (message) {
      message.textContent = `界面初始化失败：${toMessage(error)}`;
      message.dataset.kind = 'error';
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
} else {
  bootstrap();
}
