/**
 * Mountable HTML workspace: preview + source tabs, export status and wiring.
 *
 * The component owns no rendering logic. It asks `MarkdownRenderPipeline` for a
 * `RenderResult`, embeds `result.html` in the sandboxed `srcdoc` preview, shows
 * the Markdown (or opened HTML file) in the source tab, and keeps the
 * `signature` / `exportedSignature` pair so the UI can label unexported changes.
 *
 * Integration surface: `createHtmlWorkspace(options)` returns a controller;
 * `mountHtmlWorkspace(container, options)` also appends it to a host element.
 */

import type {
  ExportDependencyReport,
  ExportHtmlResult,
  LayoutConfig,
  ThemeConfig,
} from '../../../shared/contracts';
import type { RenderResult } from '../render/types';
import {
  createAppMarkdownRenderPipeline,
  type MarkdownRenderPipeline,
} from '../render/markdown-render-pipeline';
import {
  buildExportHtmlRequest,
  createIpcHtmlExportRequester,
  deriveExportState,
  describeDependencySummary,
  findExportApi,
  performHtmlExport,
  suggestHtmlFileName,
  type HtmlExportOutcome,
  type HtmlExportRequester,
} from './export-request';
import { createPreviewFrame, withPreviewCsp, type PreviewFrame } from './preview-frame';

export type HtmlViewMode = 'preview' | 'source';
export type HtmlDocumentKind = 'markdown' | 'html-file';

export interface HtmlWorkspaceDocument {
  /** Workspace-relative POSIX path. */
  path: string;
  markdown: string;
  title?: string | null;
}

export interface HtmlWorkspaceState {
  kind: HtmlDocumentKind;
  viewMode: HtmlViewMode;
  documentPath: string | null;
  signature: string | null;
  exportedSignature: string | null;
  hasUnexportedChanges: boolean;
  exportLabel: string;
  exporting: boolean;
  lastError: string | null;
  statusMessage: string;
  dependencies: ExportDependencyReport | null;
  warningCount: number;
}

export interface HtmlWorkspaceOptions {
  theme: ThemeConfig;
  layout: LayoutConfig;
  /** Defaults to `createAppMarkdownRenderPipeline` (image bridge auto-wired). */
  pipeline?: MarkdownRenderPipeline;
  initialDocument?: HtmlWorkspaceDocument | null;
  exportedSignature?: string | null;
  /** Defaults to `window.markdownLite.export.html` when available. */
  exporter?: HtmlExportRequester | null;
  /** Scope used to find `window.markdownLite` (tests pass a fake object). */
  scope?: unknown;
  ownerDocument?: Document;
  onStateChange?: (state: HtmlWorkspaceState) => void;
  onRendered?: (result: RenderResult, state: HtmlWorkspaceState) => void;
  onExportCompleted?: (result: ExportHtmlResult, state: HtmlWorkspaceState) => void;
}

export interface HtmlWorkspaceController {
  readonly element: HTMLElement;
  mount(container?: HTMLElement): HtmlWorkspaceController;
  destroy(): void;
  getState(): HtmlWorkspaceState;
  getResult(): RenderResult | null;
  setDocument(document: HtmlWorkspaceDocument | null): Promise<RenderResult | null>;
  setMarkdown(markdown: string): Promise<RenderResult | null>;
  setDocumentPath(path: string | null): Promise<RenderResult | null>;
  setTheme(theme: ThemeConfig): Promise<RenderResult | null>;
  setLayout(layout: LayoutConfig): Promise<RenderResult | null>;
  setViewMode(mode: HtmlViewMode): void;
  openHtmlFile(input: { path: string; html: string }): void;
  closeHtmlFile(): Promise<RenderResult | null>;
  render(): Promise<RenderResult | null>;
  exportHtml(): Promise<HtmlExportOutcome>;
  markExported(signature: string): void;
  setExporter(exporter: HtmlExportRequester | null): void;
}

interface InternalState {
  kind: HtmlDocumentKind;
  viewMode: HtmlViewMode;
  documentPath: string | null;
  signature: string | null;
  exportedSignature: string | null;
  exporting: boolean;
  lastError: string | null;
  statusMessage: string;
  dependencies: ExportDependencyReport | null;
  warningCount: number;
}

const WORKSPACE_STYLE_ID = 'mdl-html-workspace-styles';

const WORKSPACE_CSS = `
.mdl-html-workspace {
  display: flex;
  flex-direction: column;
  min-height: 480px;
  height: 100%;
  background: var(--panel-bg, #ffffff);
  color: var(--text, #1f2328);
  border: 1px solid var(--panel-border, #e2e2dc);
  border-radius: 10px;
  overflow: hidden;
}
.mdl-html-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.45rem 0.6rem;
  border-bottom: 1px solid var(--panel-border, #e2e2dc);
}
.mdl-html-tabs {
  display: inline-flex;
  gap: 0.15rem;
  padding: 0.15rem;
  border-radius: 8px;
  background: var(--app-bg, #f4f4f1);
}
.mdl-html-tab {
  appearance: none;
  border: 0;
  background: transparent;
  color: var(--text-muted, #6b7280);
  font: inherit;
  font-size: 0.8rem;
  padding: 0.3rem 0.7rem;
  border-radius: 6px;
  cursor: pointer;
}
.mdl-html-tab[aria-selected='true'] {
  background: var(--panel-bg, #ffffff);
  color: var(--text, #1f2328);
  box-shadow: 0 1px 2px rgb(15 23 42 / 10%);
}
.mdl-html-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: auto;
}
.mdl-html-badge {
  font-size: 0.75rem;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  background: var(--badge-bg, #eef2ff);
  color: var(--badge-text, #2f4fbf);
  white-space: nowrap;
}
.mdl-html-badge[data-state='dirty'] {
  background: #fff4e5;
  color: #8a4b00;
}
.mdl-html-export {
  appearance: none;
  border: 0;
  background: var(--accent, #2f6feb);
  color: #ffffff;
  font: inherit;
  font-size: 0.8rem;
  padding: 0.34rem 0.75rem;
  border-radius: 7px;
  cursor: pointer;
}
.mdl-html-export:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.mdl-html-status {
  margin: 0;
  padding: 0.35rem 0.7rem;
  font-size: 0.78rem;
  color: var(--text-muted, #6b7280);
  border-bottom: 1px solid var(--panel-border, #e2e2dc);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mdl-html-status[data-kind='error'] {
  color: #b42318;
}
.mdl-html-stage {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}
.mdl-html-preview {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 420px;
  background: #ffffff;
}
.mdl-preview-frame {
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-height: 420px;
  border: 0;
  background: #ffffff;
}
.mdl-html-source {
  display: none;
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  padding: 1rem;
  overflow: auto;
  background: var(--app-bg, #f4f4f1);
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 0.8rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.mdl-html-workspace[data-view='source'] .mdl-html-preview {
  display: none;
}
.mdl-html-workspace[data-view='source'] .mdl-html-source {
  display: block;
}
`;

function ensureWorkspaceStyles(doc: Document): void {
  if (doc.getElementById(WORKSPACE_STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = WORKSPACE_STYLE_ID;
  style.textContent = WORKSPACE_CSS;
  doc.head.append(style);
}

function createElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createButton(doc: Document, label: string, className: string, onClick: () => void): HTMLButtonElement {
  const button = createElement(doc, 'button', className, label);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知大小';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function describeRenderStatus(result: RenderResult): string {
  const warnings = result.warnings.length > 0 ? ` · ${result.warnings.length} 条提示` : '';
  return `已渲染${warnings} · ${describeDependencySummary(result.dependencies)}`;
}

export function createHtmlWorkspace(options: HtmlWorkspaceOptions): HtmlWorkspaceController {
  const doc = options.ownerDocument ?? globalThis.document;
  ensureWorkspaceStyles(doc);

  let theme: ThemeConfig = options.theme;
  let layout: LayoutConfig = options.layout;
  let model: HtmlWorkspaceDocument | null = options.initialDocument ? { ...options.initialDocument } : null;
  let suspendedModel: HtmlWorkspaceDocument | null = null;
  let currentResult: RenderResult | null = null;
  let renderDirty = true;
  let renderToken = 0;
  let destroyed = false;
  let mounted = false;

  const pipeline = options.pipeline ?? createAppMarkdownRenderPipeline({ scope: options.scope });
  let exporter: HtmlExportRequester | null =
    options.exporter ?? createIpcHtmlExportRequester(findExportApi(options.scope ?? globalThis));

  const state: InternalState = {
    kind: 'markdown',
    viewMode: 'preview',
    documentPath: model?.path ?? null,
    signature: null,
    exportedSignature: options.exportedSignature ?? null,
    exporting: false,
    lastError: null,
    statusMessage: model ? '准备渲染…' : '未打开文档。',
    dependencies: null,
    warningCount: 0,
  };

  const root = createElement(doc, 'section', 'mdl-html-workspace');
  root.dataset.view = state.viewMode;
  root.dataset.kind = state.kind;

  const toolbar = createElement(doc, 'header', 'mdl-html-toolbar');
  const tabs = createElement(doc, 'div', 'mdl-html-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', '视图切换');

  const previewTab = createButton(doc, '预览', 'mdl-html-tab', () => setViewMode('preview'));
  previewTab.setAttribute('role', 'tab');
  const sourceTab = createButton(doc, '源码', 'mdl-html-tab', () => setViewMode('source'));
  sourceTab.setAttribute('role', 'tab');
  tabs.append(previewTab, sourceTab);

  const actions = createElement(doc, 'div', 'mdl-html-actions');
  const badge = createElement(doc, 'span', 'mdl-html-badge');
  badge.setAttribute('role', 'status');
  const exportButton = createButton(doc, '导出 HTML…', 'mdl-html-export', () => {
    void exportHtml();
  });
  actions.append(badge, exportButton);

  toolbar.append(tabs, actions);

  const status = createElement(doc, 'p', 'mdl-html-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const stage = createElement(doc, 'div', 'mdl-html-stage');
  const previewHost = createElement(doc, 'div', 'mdl-html-preview');
  const frame: PreviewFrame = createPreviewFrame({ ownerDocument: doc, title: 'Markdown 预览' });
  previewHost.append(frame.element);
  const sourceHost = createElement(doc, 'pre', 'mdl-html-source');
  const sourceCode = createElement(doc, 'code');
  sourceHost.append(sourceCode);
  stage.append(previewHost, sourceHost);

  root.append(toolbar, status, stage);

  function getState(): HtmlWorkspaceState {
    const signatureState = deriveExportState(state.signature, state.exportedSignature);
    return {
      kind: state.kind,
      viewMode: state.viewMode,
      documentPath: state.documentPath,
      signature: state.signature,
      exportedSignature: state.exportedSignature,
      hasUnexportedChanges: signatureState.hasUnexportedChanges,
      exportLabel: signatureState.label,
      exporting: state.exporting,
      lastError: state.lastError,
      statusMessage: state.statusMessage,
      dependencies: state.dependencies,
      warningCount: state.warningCount,
    };
  }

  function notify(): void {
    options.onStateChange?.(getState());
  }

  function renderChrome(): void {
    root.dataset.view = state.viewMode;
    root.dataset.kind = state.kind;
    previewTab.setAttribute('aria-selected', String(state.viewMode === 'preview'));
    sourceTab.setAttribute('aria-selected', String(state.viewMode === 'source'));

    const signatureState = deriveExportState(state.signature, state.exportedSignature);
    badge.textContent = signatureState.label;
    badge.dataset.state = signatureState.hasUnexportedChanges ? 'dirty' : 'clean';
    badge.title =
      state.warningCount > 0 ? `${state.warningCount} 条渲染提示` : '预览与导出的内容签名一致时显示“已导出”';

    exportButton.disabled =
      state.kind !== 'markdown' || model === null || state.exporting || exporter === null;
    exportButton.textContent = state.exporting ? '导出中…' : '导出 HTML…';

    status.textContent = state.statusMessage;
    status.dataset.kind = state.lastError ? 'error' : 'info';
    notify();
  }

  function buildStatusMessage(result: RenderResult): string {
    return describeRenderStatus(result);
  }

  async function renderDocument(): Promise<RenderResult | null> {
    if (destroyed || state.kind !== 'markdown' || !model) return null;
    const token = ++renderToken;
    const snapshot: HtmlWorkspaceDocument = { ...model };
    try {
      const result = await pipeline.render({
        markdown: snapshot.markdown,
        documentPath: snapshot.path,
        title: snapshot.title ?? null,
        theme,
        layout,
      });
      if (destroyed || token !== renderToken) return null;
      currentResult = result;
      renderDirty = false;
      frame.setDocument(result.html);
      sourceCode.textContent = snapshot.markdown;
      state.signature = result.signature;
      state.dependencies = result.dependencies;
      state.warningCount = result.warnings.length;
      state.lastError = null;
      state.statusMessage = buildStatusMessage(result);
      renderChrome();
      options.onRendered?.(result, getState());
      return result;
    } catch (error) {
      if (destroyed || token !== renderToken) return null;
      currentResult = null;
      renderDirty = true;
      state.signature = null;
      state.lastError = error instanceof Error ? error.message : String(error);
      state.statusMessage = `渲染失败：${state.lastError}`;
      renderChrome();
      return null;
    }
  }

  async function ensureRendered(): Promise<RenderResult | null> {
    if (!currentResult || renderDirty) return renderDocument();
    return currentResult;
  }

  function setViewMode(mode: HtmlViewMode): void {
    if (mode !== 'preview' && mode !== 'source') return;
    state.viewMode = mode;
    renderChrome();
  }

  function setDocument(input: HtmlWorkspaceDocument | null): Promise<RenderResult | null> {
    suspendedModel = null;
    state.kind = 'markdown';
    state.lastError = null;
    if (!input) {
      model = null;
      currentResult = null;
      renderDirty = true;
      state.documentPath = null;
      state.signature = null;
      state.dependencies = null;
      state.warningCount = 0;
      state.statusMessage = '未打开文档。';
      frame.clear();
      sourceCode.textContent = '';
      renderChrome();
      return Promise.resolve(null);
    }
    model = { ...input };
    state.documentPath = input.path;
    state.statusMessage = '准备渲染…';
    renderDirty = true;
    return renderDocument();
  }

  function setMarkdown(markdown: string): Promise<RenderResult | null> {
    if (state.kind !== 'markdown' || !model) return Promise.resolve(null);
    model = { ...model, markdown };
    renderDirty = true;
    return renderDocument();
  }

  function setDocumentPath(path: string | null): Promise<RenderResult | null> {
    if (state.kind !== 'markdown' || !model) return Promise.resolve(null);
    model = { ...model, path: path ?? '' };
    state.documentPath = path;
    renderDirty = true;
    return renderDocument();
  }

  function setTheme(next: ThemeConfig): Promise<RenderResult | null> {
    theme = next;
    renderDirty = true;
    return renderDocument();
  }

  function setLayout(next: LayoutConfig): Promise<RenderResult | null> {
    layout = next;
    renderDirty = true;
    return renderDocument();
  }

  function openHtmlFile(input: { path: string; html: string }): void {
    suspendedModel = model;
    model = null;
    currentResult = null;
    renderDirty = true;
    state.kind = 'html-file';
    state.documentPath = input.path;
    state.signature = null;
    state.dependencies = null;
    state.warningCount = 0;
    state.lastError = null;
    state.statusMessage = `已打开 HTML 文件：${input.path}（预览使用无脚本沙箱）`;
    sourceCode.textContent = input.html;
    frame.setDocument(withPreviewCsp(input.html));
    renderChrome();
  }

  function closeHtmlFile(): Promise<RenderResult | null> {
    state.kind = 'markdown';
    state.signature = null;
    state.dependencies = null;
    state.warningCount = 0;
    state.lastError = null;
    const restored = suspendedModel;
    suspendedModel = null;
    if (restored) {
      model = restored;
      state.documentPath = restored.path;
      renderDirty = true;
      return renderDocument();
    }
    model = null;
    currentResult = null;
    state.documentPath = null;
    state.statusMessage = '未打开文档。';
    frame.clear();
    sourceCode.textContent = '';
    renderChrome();
    return Promise.resolve(null);
  }

  async function exportHtml(): Promise<HtmlExportOutcome> {
    if (state.kind !== 'markdown' || !model) {
      return {
        status: 'failed',
        error: { code: 'invalid_request', message: '当前视图没有可导出的 Markdown 文档' },
      };
    }
    const activeModel: HtmlWorkspaceDocument = { ...model };
    if (state.exporting) {
      return { status: 'failed', error: { code: 'conflict', message: '导出已在进行中' } };
    }
    const requester = exporter;
    if (!requester) {
      return {
        status: 'failed',
        error: { code: 'not_implemented', message: '导出接口不可用（window.markdownLite.export.html 缺失）' },
      };
    }

    const result = await ensureRendered();
    if (!result) {
      return {
        status: 'failed',
        error: { code: 'internal_error', message: state.lastError ?? '渲染失败，无法导出' },
      };
    }

    state.exporting = true;
    state.statusMessage = '正在导出…';
    renderChrome();

    const request = buildExportHtmlRequest(result, {
      documentPath: activeModel.path,
      suggestedFileName: suggestHtmlFileName(activeModel.path),
    });
    const outcome = await performHtmlExport(requester, request);
    state.exporting = false;

    if (outcome.status === 'written') {
      state.exportedSignature = outcome.result.signature;
      state.lastError = null;
      state.statusMessage = `已导出：${outcome.result.writtenPath}（${formatBytes(outcome.result.bytes)}；${describeDependencySummary(
        outcome.result.dependencies,
      )}）`;
      options.onExportCompleted?.(outcome.result, getState());
    } else if (outcome.status === 'cancelled') {
      state.statusMessage = '已取消导出。';
    } else {
      state.lastError = outcome.error.message;
      state.statusMessage = `导出失败（${outcome.error.code}）：${outcome.error.message}`;
    }
    renderChrome();
    return outcome;
  }

  function markExported(signature: string): void {
    state.exportedSignature = signature;
    renderChrome();
  }

  function setExporter(next: HtmlExportRequester | null): void {
    exporter = next;
    renderChrome();
  }

  const controller: HtmlWorkspaceController = {
    element: root,
    mount(container?: HTMLElement): HtmlWorkspaceController {
      if (container && root.parentElement !== container) container.append(root);
      if (!mounted) {
        mounted = true;
        if (model && state.kind === 'markdown') {
          renderDirty = true;
          void renderDocument();
        } else {
          renderChrome();
        }
      }
      return controller;
    },
    destroy(): void {
      destroyed = true;
      renderToken += 1;
      frame.destroy();
      root.remove();
    },
    getState,
    getResult: () => currentResult,
    setDocument,
    setMarkdown,
    setDocumentPath,
    setTheme,
    setLayout,
    setViewMode,
    openHtmlFile,
    closeHtmlFile,
    render: () => {
      renderDirty = true;
      return renderDocument();
    },
    exportHtml,
    markExported,
    setExporter,
  };

  renderChrome();
  return controller;
}

/** Creates and mounts the workspace in one call. */
export function mountHtmlWorkspace(
  container: HTMLElement,
  options: HtmlWorkspaceOptions,
): HtmlWorkspaceController {
  return createHtmlWorkspace(options).mount(container);
}

/** True when the workspace shows an opened HTML file rather than Markdown. */
export function isHtmlFileView(state: HtmlWorkspaceState): boolean {
  return state.kind === 'html-file';
}

/** True when the preview frame is showing a rendered Markdown document. */
export function isMarkdownView(state: HtmlWorkspaceState): boolean {
  return state.kind === 'markdown';
}

/** Convenience for integrations that only need the export status label. */
export function exportStatusLabel(state: HtmlWorkspaceState): string {
  return state.exportLabel;
}
